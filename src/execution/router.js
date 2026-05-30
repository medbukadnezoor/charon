import { now, json } from '../utils.js';
import { numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { SHADOW_MODE, WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, decisionPositionSizeSol, hasOpenPositionForMint, openPositionCount, resolveLiveSniperRisk } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent, logSameMintBlocked } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { candidateSummary } from '../telegram/format.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';
import { acquireLiveExecutionLock, attachLiveExecutionLockPosition, releaseLiveExecutionLock } from './liveLock.js';

async function sendChatMessage(chatId, text, extra = {}) {
  const { getBot } = await import('../telegram/bot.js');
  const bot = getBot();
  return bot.sendMessage(chatId, text, extra);
}

async function sendOpenedPosition(positionId) {
  const { sendPositionOpen } = await import('../telegram/send.js');
  return sendPositionOpen(positionId);
}

export async function sameMintExposureGuard(mint, {
  fetchTokenBalance = fetchLiveTokenBalance,
  hasOpenPosition = hasOpenPositionForMint,
  dustThresholdRaw = numSetting('live_sell_dust_threshold_raw', 1000),
} = {}) {
  if (hasOpenPosition(mint)) {
    return {
      blocked: true,
      reason: 'open_position',
      walletBalanceRaw: null,
      dustThresholdRaw,
    };
  }
  const walletBalanceRaw = await fetchTokenBalance(mint);
  if (walletBalanceRaw == null) {
    return {
      blocked: false,
      reason: 'balance_check_failed',
      walletBalanceRaw: null,
      dustThresholdRaw,
    };
  }
  const balance = Number(walletBalanceRaw);
  if (Number.isFinite(balance) && balance > Number(dustThresholdRaw)) {
    return {
      blocked: true,
      reason: 'wallet_balance',
      walletBalanceRaw: balance,
      dustThresholdRaw,
    };
  }
  return {
    blocked: false,
    reason: 'clear',
    walletBalanceRaw: Number.isFinite(balance) ? balance : walletBalanceRaw,
    dustThresholdRaw,
  };
}

export class ShadowExecutionBlockedError extends Error {
  constructor(fn) {
    super(`[FATAL] ${fn} called in SHADOW_MODE - invariant breach, all upstream guards failed`);
    this.name = 'ShadowExecutionBlockedError';
  }
}

function logBlockedEntry({ batchId, triggerCandidateId, selectedRow, rows, decision, guard }) {
  logSameMintBlocked({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    reason: guard.reason,
    guardrails: {
      mint: selectedRow?.candidate?.token?.mint,
      sameMintGuard: guard,
    },
  });
}

export function logAllowedSameMintGuardWarning({ batchId, triggerCandidateId, selectedRow, rows = [], decision = {}, guard }) {
  if (guard?.reason !== 'balance_check_failed') return;
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision: {
      ...decision,
      reason: 'balance_check_failed',
    },
    mode: 'live',
    action: 'same_mint_balance_check_failed',
    guardrails: {
      mint: selectedRow?.candidate?.token?.mint,
      sameMintGuard: guard,
    },
    execution: {
      blocked: false,
      reason: guard.reason,
    },
  });
}

export function liveBuyAmountLamports(decision, strat = activeStrategy()) {
  const liveRisk = resolveLiveSniperRisk(decision, strat, { tradingMode: 'live' });
  const resolvedDecision = liveRisk
    ? { ...decision, resolved_risk: liveRisk.resolved_risk }
    : decision;
  return {
    amountLamports: Math.floor(decisionPositionSizeSol(resolvedDecision, strat) * 1_000_000_000),
    liveRisk,
  };
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  if (SHADOW_MODE) {
    throw new ShadowExecutionBlockedError('executeLiveBuy');
  }
  const mint = selectedRow.candidate.token.mint;
  const guard = await sameMintExposureGuard(mint);
  if (guard.blocked) {
    logBlockedEntry({ batchId, triggerCandidateId, selectedRow, rows, decision, guard });
    console.log(`[live] same mint blocked ${mint}: ${guard.reason}`);
    return { action: 'same_mint_blocked', blocked: true };
  }
  logAllowedSameMintGuardWarning({ batchId, triggerCandidateId, selectedRow, rows, decision, guard });
  const strat = activeStrategy();
  const { amountLamports, liveRisk } = liveBuyAmountLamports(decision, strat);
  const executionDecision = liveRisk ? { ...decision, live_sniper_risk: liveRisk } : decision;
  const amountSol = amountLamports / 1_000_000_000;
  const liveLock = acquireLiveExecutionLock({ mint, amountSol });
  if (!liveLock.acquired) {
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision: executionDecision,
      mode: 'live',
      action: 'global_live_lock_blocked',
      guardrails: { liveLock },
      execution: { blocked: true, reason: liveLock.reason },
    });
    console.log(`[live] global lock blocked ${mint}: ${liveLock.reason}`);
    return { action: 'global_live_lock_blocked', blocked: true, reason: liveLock.reason };
  }
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    releaseLiveExecutionLock(liveLock.lockId, 'insufficient_balance');
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  let swap;
  let positionId;
  try {
    swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: selectedRow.candidate.token.mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(selectedRow.candidate.token.mint) || swap.outputAmount;
    }
    positionId = createLivePosition(selectedRow.id, selectedRow.candidate, executionDecision, swap, `live_batch_${batchId}`);
    attachLiveExecutionLockPosition(liveLock.lockId, positionId);
  } catch (err) {
    releaseLiveExecutionLock(liveLock.lockId, `buy_failed:${err.message}`);
    throw err;
  }
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision: executionDecision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, liveLock },
    execution: { positionId, swap, liveRisk, lockId: liveLock.lockId },
  });
  await sendOpenedPosition(positionId);
  return { action: 'live_entry_executed', positionId };
}

export async function executeLiveSell(position, reason) {
  if (SHADOW_MODE) {
    throw new ShadowExecutionBlockedError('executeLiveSell');
  }
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return sendChatMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return sendChatMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return sendChatMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const mint = freshRow.candidate.token.mint;
    const guard = await sameMintExposureGuard(mint);
    if (guard.blocked) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_same_mint', now(), intentId);
      logBlockedEntry({
        batchId: null,
        triggerCandidateId: intent.candidate_id,
        selectedRow: freshRow,
        rows: [],
        decision,
        guard,
      });
      return sendChatMessage(chatId, `Same mint exposure blocked: ${escapeHtml(guard.reason)}.`, { parse_mode: 'HTML' });
    }
    logAllowedSameMintGuardWarning({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      guard,
    });
    const strat = activeStrategy();
    const amountLamports = Math.floor(decisionPositionSizeSol(decision, strat) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return sendChatMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
    }
    const positionId = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, swap },
    });
    return sendOpenedPosition(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return sendChatMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return sendChatMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return sendChatMessage(chatId, `Rejected trade intent #${intentId}.`);
}
