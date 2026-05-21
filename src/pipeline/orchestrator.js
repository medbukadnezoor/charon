import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { upsertCandidate, updateCandidateSnapshot, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';
import { effectiveLlmMinConfidence, shouldApproveEntry } from './entryApproval.js';
import { queueCandidateObservation } from '../db/observations.js';
import { enrichOverview, isEnabled as isInsightXEnabled, shouldSampleInsightX } from '../providers/insightx.js';
import { fetchBirdeyeOhlcv } from '../enrichment/birdeye.js';
import { computeEntrySignals } from '../analysis/ohlcvSignals.js';
import { getActiveReentryWatch, markReentryTriggered } from '../db/reentry.js';
import { db } from '../db/connection.js';

export const seenSignalCandidates = new Map();

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function captureInsightXOverviewForCandidate(candidate, candidateId, {
  onlyAfterLlmPass = boolSetting('insightx_only_after_llm_pass', false),
  enabled = isInsightXEnabled,
  shouldSample = shouldSampleInsightX,
  enrich = enrichOverview,
  updateSnapshot = updateCandidateSnapshot,
  nowMs = now,
} = {}) {
  if (onlyAfterLlmPass) return false;
  if (!enabled()) return false;
  const mint = candidate?.token?.mint;
  if (!shouldSample(mint)) return false;
  try {
    const overview = await enrich(mint);
    if (!overview) return false;
    candidate.insightx_overview = overview;
    candidate.insightx_overview_at_ms = nowMs();
    updateSnapshot(candidateId, candidate);
    return true;
  } catch (err) {
    console.log(`[insightx] enrichment skipped for ${mint ? short(mint) : 'unknown mint'}: ${err.message}`);
    return false;
  }
}

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);
  queueCandidateObservation({
    candidate,
    candidateId,
    screeningEventId: candidate.screeningEventId,
    stage: 'candidate_filter',
    action: candidate.filters.passed ? 'passed' : 'filtered',
    eligibilityReason: candidate.filters.primaryFailureCode || 'candidate_filter',
  });

  // Re-entry fast path: bypass LLM for mints that hit SL and recovered
  const reentryStrat = activeStrategy();
  if (reentryStrat?.reentry_enabled) {
    const watch = getActiveReentryWatch(signals.mint);
    if (watch) {
      const currentMcap = Number(candidate.mcapSample?.marketCapUsd || candidate.metrics?.marketCapUsd || 0);
      const minRecovery = Number(reentryStrat.reentry_min_mcap_recovery ?? 1.0);
      if (currentMcap >= watch.entry_mcap * minRecovery) {
        console.log(`[reentry] ${signals.mint.slice(0, 8)} recovered to ${Math.round(currentMcap / 1000)}k (entry was ${Math.round(watch.entry_mcap / 1000)}k) — attempting re-entry`);
        // Run OHLCV entry confirmation before re-entering
        let ohlcvConfirmed = true;
        if (boolSetting('entry_confirm_enabled', false)) {
          try {
            const ohlcv = await fetchBirdeyeOhlcv(signals.mint, { interval: '1m', count: 15 });
            const entrySignals = computeEntrySignals(ohlcv.candles || []);
            if (!entrySignals.confirm) {
              console.log(`[reentry] ${signals.mint.slice(0, 8)} OHLCV rejected re-entry: ${entrySignals.reject_reason}`);
              ohlcvConfirmed = false;
            }
          } catch (err) {
            console.log(`[reentry] OHLCV check failed: ${err.message}, proceeding`);
          }
        }
        if (ohlcvConfirmed && canOpenMorePositions()) {
          const reentryDecision = {
            verdict: 'BUY',
            confidence: 85,
            selected_candidate_id: candidateId,
            selected_mint: signals.mint,
            selected_row: candidateById(candidateId),
            reason: `Re-entry: mint recovered to ${Math.round(currentMcap / 1000)}k after SL at ${Math.round(watch.sl_mcap / 1000)}k (original position #${watch.original_position_id})`,
            risks: ['reentry_position'],
            suggested_tp_percent: reentryStrat.tp_percent ?? 300,
            suggested_sl_percent: reentryStrat.sl_percent ?? -60,
            raw: null,
          };
          await handleApprovedBuy(
            reentryDecision.selected_row,
            reentryDecision,
            null,
            [],
            candidateId,
          );
          // Mark watch as triggered after position is created
          const openPos = db.prepare("SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(signals.mint);
          if (openPos) markReentryTriggered(watch.id, openPos.id);
          return;
        }
      }
    }
  }

  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }
  await captureInsightXOverviewForCandidate(candidate, candidateId);

  const strat = activeStrategy();
  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());
  queueCandidateObservation({
    candidate,
    candidateId,
    screeningEventId: candidate.screeningEventId,
    batchId,
    stage: 'llm_decision',
    action: currentDecision.verdict === 'BUY' ? 'buy_selected' : 'watch',
    eligibilityReason: currentDecision.reason || currentDecision.verdict,
  });

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  const agentEnabled = boolSetting('agent_enabled', true);
  const confidenceThreshold = effectiveLlmMinConfidence(strat, numSetting('llm_min_confidence', 75));
  const mode = tradingMode();
  const maxOpenPositions = Number.isFinite(Number(strat.max_open_positions))
    ? Number(strat.max_open_positions)
    : numSetting('max_open_positions', 3);
  if (shouldApproveEntry({ selectedRow, agentEnabled, decision: batchDecision, confidenceThreshold })) {
    if (!canOpenMorePositions()) {
      console.log(`[agent] max open positions reached (${openPositionCount()}/${maxOpenPositions}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        mode,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions, openPositions: openPositionCount() },
      });
      queueCandidateObservation({
        candidate: selectedRow.candidate,
        candidateId: selectedRow.id,
        batchId,
        stage: 'entry_decision',
        action: 'entry_skipped_max_positions',
        eligibilityReason: 'max_open_positions',
      });
      return;
    }
    await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      mode,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled,
        confidenceThreshold,
        openPositions: openPositionCount(),
        maxOpenPositions,
      },
    });
    queueCandidateObservation({
      candidate,
      candidateId,
      screeningEventId: candidate.screeningEventId,
      batchId,
      stage: 'entry_decision',
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      eligibilityReason: batchDecision.reason || 'entry_not_approved',
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    queueCandidateObservation({
      candidate: freshSelectedRow.candidate,
      candidateId: freshSelectedRow.id,
      batchId,
      stage: 'execution_refresh',
      action: 'entry_rejected_fresh_filters',
      eligibilityReason: freshSelectedRow.candidate.filters?.primaryFailureCode || 'fresh_execution_guard_failed',
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  // OHLCV entry confirmation — reject local-top entries
  if (boolSetting('entry_confirm_enabled', false)) {
    try {
      const mint = freshSelectedRow.candidate.token.mint;
      const ohlcv = await fetchBirdeyeOhlcv(mint, { interval: '1m', count: 15 });
      const entrySignals = computeEntrySignals(ohlcv.candles || []);
      if (!entrySignals.confirm) {
        updateCandidateStatus(freshSelectedRow.id, 'entry_rejected_ohlcv');
        logDecisionEvent({
          batchId,
          triggerCandidateId,
          selectedRow: freshSelectedRow,
          rows: executionRows,
          decision,
          mode,
          action: 'entry_rejected_ohlcv',
          guardrails: { entrySignals },
        });
        queueCandidateObservation({
          candidate: freshSelectedRow.candidate,
          candidateId: freshSelectedRow.id,
          batchId,
          stage: 'entry_confirmation',
          action: 'entry_rejected_ohlcv',
          eligibilityReason: entrySignals.reject_reason || 'ohlcv_entry_score_low',
        });
        console.log(`[entry-confirm] ${mint.slice(0, 8)} rejected: ${entrySignals.reject_reason || 'score=' + entrySignals.score} (RSI=${entrySignals.rsi?.toFixed(1)}, VWAP=${entrySignals.vwap_position}, vol=${entrySignals.volume_trend})`);
        await sendTelegram([
          '⏸️ <b>Entry rejected by OHLCV confirmation</b>',
          '',
          candidateSummary(freshSelectedRow.candidate, decision),
          '',
          `Reason: ${escapeHtml(entrySignals.reject_reason || 'low score')}`,
          `Score: ${entrySignals.score}, RSI: ${entrySignals.rsi?.toFixed(1) || 'n/a'}`,
        ].join('\n'));
        return;
      }
      console.log(`[entry-confirm] ${mint.slice(0, 8)} confirmed: score=${entrySignals.score} RSI=${entrySignals.rsi?.toFixed(1)} VWAP=${entrySignals.vwap_position}`);
    } catch (err) {
      // Don't block entry on OHLCV fetch failure — log and proceed
      console.log(`[entry-confirm] OHLCV check failed for ${freshSelectedRow.candidate.token.mint.slice(0, 8)}: ${err.message}, proceeding with entry`);
    }
  }

  if (mode === 'dry_run') {
    const positionId = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'dry_run_entry',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { positionId },
    });
    queueCandidateObservation({
      candidate: freshSelectedRow.candidate,
      candidateId: freshSelectedRow.id,
      batchId,
      positionId,
      stage: 'entry_decision',
      action: 'dry_run_entry',
      eligibilityReason: 'dry_run_entry_opened',
    });
    await sendPositionOpen(positionId);
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    queueCandidateObservation({
      candidate: freshSelectedRow.candidate,
      candidateId: freshSelectedRow.id,
      batchId,
      stage: 'entry_decision',
      action: 'confirm_intent_created',
      eligibilityReason: 'confirm_intent_created',
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    queueCandidateObservation({
      candidate: freshSelectedRow.candidate,
      candidateId: freshSelectedRow.id,
      batchId,
      stage: 'entry_decision',
      action: 'live_entry_failed',
      eligibilityReason: err.message,
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
