import { now } from '../utils.js';
import { activeStrategy, numSetting } from '../db/settings.js';
import { candidateById, updateCandidateStatus } from '../db/candidates.js';
import { logDecisionEvent } from '../db/decisions.js';
import { canOpenMorePositions, openPositionCount } from '../db/positions.js';
import {
  activeEntryWatchCount,
  expireDueEntryWatches,
  insertEntryWatch,
  listDueEntryWatchesByType,
  markEntryWatchChecked,
  markEntryWatchStatus,
  markEntryWatchTriggered,
} from '../db/entryWatch.js';
import { queueCandidateObservation } from '../db/observations.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { fetchEntryWatchCandlesWithBudget, fetchWatchDipFinalComposite, fetchWatchDipRoutineCandles } from '../enrichment/entryCandles.js';
import { computeEntrySignals, isWatchableEntryReject } from '../analysis/ohlcvSignals.js';
import { computeWatchDipTrigger, evaluateWatchDipEligibility, watchDipExecutionOverrides } from '../analysis/watchDip.js';
import { tradingMode } from '../db/positions.js';
import { sendTelegram } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { escapeHtml, short } from '../format.js';

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolFromStrategy(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function entryWatchConfig(strat = activeStrategy()) {
  return {
    enabled: boolFromStrategy(strat.entry_watch_enabled, false),
    windowMs: Math.max(60_000, Number(strat.entry_watch_window_ms ?? 60 * 60_000) || 60 * 60_000),
    recheckMs: Math.max(60_000, Number(strat.entry_watch_recheck_ms ?? 5 * 60_000) || 5 * 60_000),
    maxAttempts: Math.max(1, Math.trunc(Number(strat.entry_watch_max_attempts ?? 6) || 6)),
    maxActive: Math.max(0, Math.trunc(Number(strat.entry_watch_max_active ?? 10) || 10)),
    llmTtlMs: Math.max(60_000, Number(strat.entry_watch_llm_ttl_ms ?? 30 * 60_000) || 30 * 60_000),
    minEntryScore: Number(strat.entry_watch_min_entry_score ?? 45) || 45,
    minPullbackPct: Math.max(0, Number(strat.entry_watch_min_pullback_pct ?? 8) || 8),
    maxPullbackPct: Math.max(0, Number(strat.entry_watch_max_pullback_pct ?? 45) || 45),
    requireFreshFilters: boolFromStrategy(strat.entry_watch_require_fresh_filters, true),
    evalLimit: Math.max(1, Math.trunc(numSetting('entry_watch_eval_limit', 3))),
  };
}

function watchDipConfig(strat = activeStrategy()) {
  return {
    enabled: boolFromStrategy(strat.llm_watch_dip_enabled, false),
    windowMs: Math.max(60_000, Number(strat.llm_watch_dip_window_ms ?? 2 * 60 * 60_000) || 2 * 60 * 60_000),
    recheckMs: Math.max(60_000, Number(strat.llm_watch_dip_recheck_ms ?? 5 * 60_000) || 5 * 60_000),
    maxAttempts: Math.max(1, Math.trunc(Number(strat.llm_watch_dip_max_attempts ?? 24) || 24)),
    maxActive: Math.max(0, Math.trunc(Number(strat.llm_watch_dip_max_active ?? 60) || 60)),
    requireFreshFilters: boolFromStrategy(strat.llm_watch_dip_require_fresh_filters, true),
    evalLimit: Math.max(1, Math.trunc(numSetting('llm_watch_dip_eval_limit', 5))),
    requireStrongLive: boolFromStrategy(strat.llm_watch_dip_require_strong_source_live, true),
    allowMediumDryRun: boolFromStrategy(strat.llm_watch_dip_allow_medium_dry_run, true),
  };
}

export function shouldStartEntryWatch(entrySignals, strat = activeStrategy()) {
  const cfg = entryWatchConfig(strat);
  if (!cfg.enabled) return { start: false, reason: 'entry_watch_disabled' };
  if (cfg.maxActive <= 0) return { start: false, reason: 'entry_watch_capacity_zero' };
  if (activeEntryWatchCount('entry_reject') >= cfg.maxActive) return { start: false, reason: 'entry_watch_capacity_full' };
  if (!isWatchableEntryReject(entrySignals, { minEntryScore: cfg.minEntryScore })) {
    return { start: false, reason: 'entry_reject_not_watchable' };
  }
  return { start: true, reason: 'watchable_timing_reject', config: cfg };
}

export async function startEntryWatchFromReject({
  selectedRow,
  decision,
  batchId = null,
  triggerCandidateId = null,
  rows = [],
  mode,
  entrySignals,
} = {}) {
  const strat = activeStrategy();
  const verdict = shouldStartEntryWatch(entrySignals, strat);
  if (!verdict.start) return verdict;
  const cfg = verdict.config;
  const candidate = selectedRow.candidate;
  const price = numberOrNull(candidate.metrics?.priceUsd);
  const mcap = numberOrNull(candidate.metrics?.marketCapUsd ?? candidate.metrics?.graduatedMarketCapUsd);
  const watch = insertEntryWatch({
    mint: candidate.token.mint,
    watchType: 'entry_reject',
    strategyId: strat.id,
    originalCandidateId: selectedRow.id,
    originalDecisionId: decision.id || null,
    originalBatchId: batchId,
    originalRejectReason: entrySignals.reject_reason || 'ohlcv_entry_score_low',
    originalEntryScore: entrySignals.score,
    originalCandleSource: entrySignals.candle_source,
    originalCandleCount: entrySignals.candle_count,
    originalMcap: mcap,
    originalPrice: price,
    rejectionHighPrice: price,
    rejectionHighMcap: mcap,
    nextCheckAtMs: now() + cfg.recheckMs,
    windowMs: cfg.windowMs,
    snapshot: {
      candidate,
      decision,
      entrySignals,
      config: cfg,
    },
  });
  updateCandidateStatus(selectedRow.id, 'entry_watch');
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode,
    action: 'entry_watch_started',
    guardrails: { entryWatchId: watch.id, entrySignals, reason: verdict.reason },
  });
  queueCandidateObservation({
    candidate,
    candidateId: selectedRow.id,
    batchId,
    stage: 'entry_confirmation',
    action: 'entry_watch_started',
    eligibilityReason: entrySignals.reject_reason || 'watchable_timing_reject',
  });
  await sendTelegram([
    '⏳ <b>Entry watch started</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Reason: ${escapeHtml(entrySignals.reject_reason || 'timing reject')}`,
    `Candles: ${escapeHtml(entrySignals.candle_source || 'unknown')} (${entrySignals.candle_count || 0})`,
    `Recheck: ${Math.round(cfg.recheckMs / 60000)}m, expires: ${Math.round(cfg.windowMs / 60000)}m`,
  ].join('\n'));
  return { ...verdict, watchId: watch.id, inserted: watch.inserted };
}

export function shouldStartWatchDip(candidate, decision, strat = activeStrategy()) {
  const cfg = watchDipConfig(strat);
  if (!cfg.enabled) return { start: false, reason: 'llm_watch_dip_disabled' };
  if (cfg.maxActive <= 0) return { start: false, reason: 'llm_watch_dip_capacity_zero' };
  if (activeEntryWatchCount('llm_watch_dip') >= cfg.maxActive) return { start: false, reason: 'llm_watch_dip_capacity_full' };
  const eligibility = evaluateWatchDipEligibility(candidate, decision, strat);
  if (!eligibility.eligible) return { start: false, reason: eligibility.reason, eligibility };
  return { start: true, reason: eligibility.reason, cohort: eligibility.cohort, eligibility, config: cfg };
}

export async function startWatchDipFromLlmWatch({
  selectedRow,
  decision,
  batchId = null,
  triggerCandidateId = null,
  rows = [],
  mode,
} = {}) {
  const strat = activeStrategy();
  const candidate = selectedRow?.candidate;
  const verdict = shouldStartWatchDip(candidate, decision, strat);
  if (!verdict.start) {
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode,
      action: 'llm_watch_dip_not_started',
      guardrails: { reason: verdict.reason, eligibility: verdict.eligibility || null },
    });
    return verdict;
  }
  const cfg = verdict.config;
  const price = numberOrNull(candidate.metrics?.priceUsd);
  const mcap = numberOrNull(candidate.metrics?.marketCapUsd ?? candidate.metrics?.graduatedMarketCapUsd);
  const watch = insertEntryWatch({
    mint: candidate.token.mint,
    watchType: 'llm_watch_dip',
    cohort: verdict.cohort,
    strategyId: strat.id,
    originalCandidateId: selectedRow.id,
    originalDecisionId: decision.id || null,
    originalBatchId: batchId,
    originalRejectReason: verdict.reason,
    originalEntryScore: decision.confidence,
    originalMcap: mcap,
    originalPrice: price,
    rejectionHighPrice: price,
    rejectionHighMcap: mcap,
    nextCheckAtMs: now() + cfg.recheckMs,
    windowMs: cfg.windowMs,
    snapshot: {
      candidate,
      decision,
      eligibility: verdict.eligibility,
      config: cfg,
    },
  });
  updateCandidateStatus(selectedRow.id, 'llm_watch_dip');
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode,
    action: 'llm_watch_dip_started',
    guardrails: { entryWatchId: watch.id, cohort: verdict.cohort, eligibility: verdict.eligibility, reason: verdict.reason },
  });
  queueCandidateObservation({
    candidate,
    candidateId: selectedRow.id,
    batchId,
    stage: 'entry_confirmation',
    action: 'llm_watch_dip_started',
    eligibilityReason: verdict.reason,
  });
  await sendTelegram([
    '⏳ <b>LLM watch-dip started</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Cohort: ${escapeHtml(verdict.cohort || 'unknown')}`,
    `Reason: ${escapeHtml(verdict.reason)}`,
    `Recheck: ${Math.round(cfg.recheckMs / 60000)}m, expires: ${Math.round(cfg.windowMs / 60000)}m`,
  ].join('\n'));
  return { ...verdict, watchId: watch.id, inserted: watch.inserted };
}

function pullbackPct(watch, candidate, entrySignals) {
  const current = numberOrNull(candidate.metrics?.priceUsd)
    ?? numberOrNull(candidate.metrics?.marketCapUsd ?? candidate.metrics?.graduatedMarketCapUsd);
  const high = numberOrNull(watch.rejection_high_price) ?? numberOrNull(watch.rejection_high_mcap);
  if (current == null || high == null || high <= 0) return null;
  return ((high - current) / high) * 100;
}

async function evaluateOneEntryWatch(watch, { handleApprovedBuy } = {}) {
  const atMs = now();
  const cfg = entryWatchConfig(activeStrategy());
  if (atMs >= Number(watch.expires_at_ms)) {
    markEntryWatchStatus(watch.id, 'expired', { reason: 'expired', atMs });
    return { status: 'expired', watchId: watch.id };
  }
  if (Number(watch.attempt_count || 0) >= cfg.maxAttempts) {
    markEntryWatchStatus(watch.id, 'expired', { reason: 'max_attempts', atMs });
    return { status: 'expired', watchId: watch.id };
  }
  if (!canOpenMorePositions()) {
    markEntryWatchChecked(watch.id, {
      nextCheckAtMs: atMs + cfg.recheckMs,
      reason: 'max_open_positions',
      atMs,
    });
    return { status: 'deferred', reason: 'max_open_positions', watchId: watch.id };
  }
  const originalRow = candidateById(watch.original_candidate_id);
  if (!originalRow) {
    markEntryWatchStatus(watch.id, 'invalidated', { reason: 'missing_original_candidate', atMs });
    return { status: 'invalidated', reason: 'missing_original_candidate', watchId: watch.id };
  }
  const freshRow = await refreshCandidateForExecution(originalRow);
  if (cfg.requireFreshFilters && !freshRow.candidate.filters?.passed) {
    markEntryWatchStatus(watch.id, 'invalidated', { reason: freshRow.candidate.filters?.primaryFailureCode || 'fresh_filters_failed', atMs });
    return { status: 'invalidated', reason: 'fresh_filters_failed', watchId: watch.id };
  }

  const candleResult = await fetchEntryWatchCandlesWithBudget(watch.mint, { watchId: watch.id, interval: '1m', count: 15, atMs });
  if (candleResult.budgetDeferred) {
    markEntryWatchChecked(watch.id, {
      nextCheckAtMs: atMs + Math.max(cfg.recheckMs, numSetting('entry_watch_budget_cooldown_ms', 60 * 60_000)),
      reason: 'entry_watch_budget_deferred',
      atMs,
    });
    return { status: 'budget_deferred', watchId: watch.id, budget: candleResult.budget };
  }
  const ohlcv = candleResult.ohlcv || {};
  const entrySignals = computeEntrySignals(ohlcv.candles || []);
  const enrichedSignals = {
    ...entrySignals,
    candle_source: ohlcv.source || 'unknown',
    candle_count: ohlcv.candles?.length || 0,
    fallback_trace: ohlcv.fallbackTrace || [],
    pair_address: ohlcv.pairAddress || null,
    gmgn_kline_count: ohlcv.gmgnKlineCount ?? (ohlcv.provider === 'gmgn' ? ohlcv.candles?.length || 0 : null),
  };
  const pullback = pullbackPct(watch, freshRow.candidate, enrichedSignals);
  const currentPrice = numberOrNull(freshRow.candidate.metrics?.priceUsd);
  const currentMcap = numberOrNull(freshRow.candidate.metrics?.marketCapUsd ?? freshRow.candidate.metrics?.graduatedMarketCapUsd);
  const reason = !enrichedSignals.confirm
    ? (enrichedSignals.reject_reason || 'ohlcv_still_not_confirmed')
    : pullback == null
      ? 'pullback_unavailable'
      : pullback < cfg.minPullbackPct
        ? 'pullback_too_small'
        : pullback > cfg.maxPullbackPct
          ? 'pullback_too_deep'
          : atMs - Number(watch.created_at_ms || atMs) > cfg.llmTtlMs
            ? 'llm_ttl_expired'
            : 'entry_watch_triggered';

  markEntryWatchChecked(watch.id, {
    nextCheckAtMs: atMs + cfg.recheckMs,
    reason,
    entryScore: enrichedSignals.score,
    candleSource: enrichedSignals.candle_source,
    candleCount: enrichedSignals.candle_count,
    lowPrice: currentPrice,
    lowMcap: currentMcap,
    atMs,
  });

  logDecisionEvent({
    batchId: watch.original_batch_id,
    triggerCandidateId: watch.original_candidate_id,
    selectedRow: freshRow,
    rows: [freshRow],
    decision: watch.snapshot?.decision || {},
    mode: 'entry_watch',
    action: reason === 'entry_watch_triggered' ? 'entry_watch_triggered' : 'entry_watch_checked',
    guardrails: { entryWatchId: watch.id, entrySignals: enrichedSignals, pullbackPct: pullback, reason },
  });

  if (reason !== 'entry_watch_triggered') {
    if (Number(watch.attempt_count || 0) + 1 >= cfg.maxAttempts) {
      markEntryWatchStatus(watch.id, 'expired', { reason: 'max_attempts', atMs });
    }
    return { status: 'checked', reason, watchId: watch.id };
  }

  const decision = {
    ...(watch.snapshot?.decision || {}),
    verdict: 'BUY',
    selected_candidate_id: freshRow.id,
    selected_mint: watch.mint,
    selected_row: freshRow,
    reason: `Entry watch triggered after OHLCV timing improved for ${short(watch.mint)}.`,
    risks: [...(watch.snapshot?.decision?.risks || []), 'entry_watch_delayed_entry'],
    raw: {
      ...(watch.snapshot?.decision?.raw || {}),
      entry_watch_id: watch.id,
      entry_watch_pullback_pct: pullback,
    },
  };
  const entryResult = await handleApprovedBuy(freshRow, decision, watch.original_batch_id, [freshRow], watch.original_candidate_id, {
    entrySource: 'entry_watch',
    entryWatchId: watch.id,
    skipEntryWatchOnReject: true,
  });
  if (['dry_run_entry', 'confirm_intent_created', 'live_entry_executed'].includes(entryResult?.action)) {
    markEntryWatchTriggered(watch.id, {
      candidateId: freshRow.id,
      positionId: entryResult.positionId || entryResult.intentId || null,
      reason: entryResult.action,
      atMs,
    });
    return { status: 'triggered', watchId: watch.id, entryResult };
  }
  markEntryWatchStatus(watch.id, 'invalidated', { reason: entryResult?.action || 'entry_not_opened', atMs });
  return { status: 'invalidated', reason: entryResult?.action || 'entry_not_opened', watchId: watch.id, entryResult };
}

function sourceAllowedForMode(sourceConfidence, mode, cfg) {
  if (sourceConfidence === 'strong') return true;
  if (mode === 'dry_run' && cfg.allowMediumDryRun && sourceConfidence === 'medium') return true;
  if (mode === 'live' && cfg.requireStrongLive) return false;
  return sourceConfidence === 'medium';
}

async function evaluateOneWatchDip(watch, { handleApprovedBuy } = {}) {
  const atMs = now();
  const strat = activeStrategy();
  const cfg = watchDipConfig(strat);
  if (atMs >= Number(watch.expires_at_ms)) {
    markEntryWatchStatus(watch.id, 'expired', { reason: 'expired', atMs });
    return { status: 'expired', watchId: watch.id };
  }
  if (Number(watch.attempt_count || 0) >= cfg.maxAttempts) {
    markEntryWatchStatus(watch.id, 'expired', { reason: 'max_attempts', atMs });
    return { status: 'expired', watchId: watch.id };
  }
  if (!canOpenMorePositions()) {
    markEntryWatchChecked(watch.id, { nextCheckAtMs: atMs + cfg.recheckMs, reason: 'max_open_positions', atMs });
    return { status: 'deferred', reason: 'max_open_positions', watchId: watch.id };
  }
  const originalRow = candidateById(watch.original_candidate_id);
  if (!originalRow) {
    markEntryWatchStatus(watch.id, 'invalidated', { reason: 'missing_original_candidate', atMs });
    return { status: 'invalidated', reason: 'missing_original_candidate', watchId: watch.id };
  }
  const freshRow = await refreshCandidateForExecution(originalRow);
  if (cfg.requireFreshFilters && !freshRow.candidate.filters?.passed) {
    markEntryWatchStatus(watch.id, 'invalidated', { reason: freshRow.candidate.filters?.primaryFailureCode || 'fresh_filters_failed', atMs });
    return { status: 'invalidated', reason: 'fresh_filters_failed', watchId: watch.id };
  }

  const routine = await fetchWatchDipRoutineCandles(watch.mint, { atMs, interval: '1m', count: 30, minCandles: 5 });
  const routineCandles = routine.candles || [];
  const trigger = computeWatchDipTrigger(watch, freshRow.candidate, routineCandles, strat);
  const currentPrice = numberOrNull(freshRow.candidate.metrics?.priceUsd);
  const currentMcap = numberOrNull(freshRow.candidate.metrics?.marketCapUsd ?? freshRow.candidate.metrics?.graduatedMarketCapUsd);

  if (!trigger.trigger) {
    markEntryWatchChecked(watch.id, {
      nextCheckAtMs: atMs + cfg.recheckMs,
      reason: trigger.reason,
      candleSource: routine.source || 'unknown',
      candleCount: routineCandles.length,
      lowPrice: currentPrice,
      lowMcap: currentMcap,
      atMs,
    });
    logDecisionEvent({
      batchId: watch.original_batch_id,
      triggerCandidateId: watch.original_candidate_id,
      selectedRow: freshRow,
      rows: [freshRow],
      decision: watch.snapshot?.decision || {},
      mode: 'llm_watch_dip',
      action: 'llm_watch_dip_checked',
      guardrails: { entryWatchId: watch.id, cohort: watch.cohort, trigger, providerTrace: routine.fallbackTrace || [] },
    });
    if (Number(watch.attempt_count || 0) + 1 >= cfg.maxAttempts) {
      markEntryWatchStatus(watch.id, 'expired', { reason: 'max_attempts', atMs });
    }
    return { status: 'checked', reason: trigger.reason, watchId: watch.id };
  }

  const final = await fetchWatchDipFinalComposite(watch.mint, { watchId: watch.id, atMs, interval: '1m', count: 30, minCandles: 5 });
  if (final.budgetDeferred) {
    markEntryWatchChecked(watch.id, {
      nextCheckAtMs: atMs + Math.max(cfg.recheckMs, numSetting('entry_watch_budget_cooldown_ms', 60 * 60_000)),
      reason: 'llm_watch_dip_budget_deferred',
      candleSource: routine.source || 'unknown',
      candleCount: routineCandles.length,
      lowPrice: currentPrice,
      lowMcap: currentMcap,
      atMs,
    });
    return { status: 'budget_deferred', watchId: watch.id, budget: final.budget };
  }
  const mode = tradingMode();
  if (!sourceAllowedForMode(final.sourceConfidence, mode, cfg)) {
    markEntryWatchChecked(watch.id, {
      nextCheckAtMs: atMs + cfg.recheckMs,
      reason: 'llm_watch_dip_source_not_strong',
      candleSource: final.ohlcv?.source || routine.source || 'unknown',
      candleCount: final.ohlcv?.candles?.length || routineCandles.length,
      lowPrice: currentPrice,
      lowMcap: currentMcap,
      atMs,
    });
    return { status: 'deferred', reason: 'llm_watch_dip_source_not_strong', watchId: watch.id, sourceConfidence: final.sourceConfidence };
  }
  const finalTrigger = computeWatchDipTrigger(watch, freshRow.candidate, final.ohlcv?.candles || [], strat);
  if (!finalTrigger.trigger) {
    markEntryWatchChecked(watch.id, {
      nextCheckAtMs: atMs + cfg.recheckMs,
      reason: finalTrigger.reason,
      candleSource: final.ohlcv?.source || 'unknown',
      candleCount: final.ohlcv?.candles?.length || 0,
      lowPrice: currentPrice,
      lowMcap: currentMcap,
      atMs,
    });
    return { status: 'checked', reason: finalTrigger.reason, watchId: watch.id };
  }

  markEntryWatchChecked(watch.id, {
    nextCheckAtMs: atMs + cfg.recheckMs,
    reason: 'llm_watch_dip_triggered',
    candleSource: final.ohlcv?.source || 'unknown',
    candleCount: final.ohlcv?.candles?.length || 0,
    lowPrice: currentPrice,
    lowMcap: currentMcap,
    atMs,
  });

  const decision = {
    ...(watch.snapshot?.decision || {}),
    ...watchDipExecutionOverrides(strat),
    verdict: 'BUY',
    selected_candidate_id: freshRow.id,
    selected_mint: watch.mint,
    selected_row: freshRow,
    reason: `LLM watch-dip triggered for ${short(watch.mint)} after pullback/reclaim confirmation.`,
    risks: [...(watch.snapshot?.decision?.risks || []), 'llm_watch_dip_delayed_entry'],
    raw: {
      ...(watch.snapshot?.decision?.raw || {}),
      llm_watch_dip_id: watch.id,
      llm_watch_dip_trigger: finalTrigger,
      source_confidence: final.sourceConfidence,
      source_agreement: final.sourceAgreement,
    },
  };
  logDecisionEvent({
    batchId: watch.original_batch_id,
    triggerCandidateId: watch.original_candidate_id,
    selectedRow: freshRow,
    rows: [freshRow],
    decision,
    mode: 'llm_watch_dip',
    action: 'llm_watch_dip_triggered',
    guardrails: {
      entryWatchId: watch.id,
      cohort: watch.cohort,
      trigger: finalTrigger,
      sourceConfidence: final.sourceConfidence,
      sourceAgreement: final.sourceAgreement,
      providerTrace: final.ohlcv?.fallbackTrace || [],
      budget: final.budget,
    },
  });
  const entryResult = await handleApprovedBuy(freshRow, decision, watch.original_batch_id, [freshRow], watch.original_candidate_id, {
    entrySource: 'llm_watch_dip',
    entryWatchId: watch.id,
    skipEntryWatchOnReject: true,
    skipOhlcvConfirmation: true,
  });
  if (['dry_run_entry', 'confirm_intent_created', 'live_entry_executed'].includes(entryResult?.action)) {
    markEntryWatchTriggered(watch.id, {
      candidateId: freshRow.id,
      positionId: entryResult.positionId || entryResult.intentId || null,
      reason: entryResult.action,
      atMs,
    });
    return { status: 'triggered', watchId: watch.id, entryResult };
  }
  markEntryWatchStatus(watch.id, 'invalidated', { reason: entryResult?.action || 'entry_not_opened', atMs });
  return { status: 'invalidated', reason: entryResult?.action || 'entry_not_opened', watchId: watch.id, entryResult };
}

export async function runDueEntryWatches({ limit = null, handleApprovedBuy } = {}) {
  const strat = activeStrategy();
  const cfg = entryWatchConfig(strat);
  const dipCfg = watchDipConfig(strat);
  if (!cfg.enabled && !dipCfg.enabled) return { enabled: false, checked: 0, expired: 0, triggered: 0 };
  const expired = expireDueEntryWatches();
  const due = [
    ...(cfg.enabled ? listDueEntryWatchesByType({ watchType: 'entry_reject', limit: limit ?? cfg.evalLimit }) : []),
    ...(dipCfg.enabled ? listDueEntryWatchesByType({ watchType: 'llm_watch_dip', limit: limit ?? dipCfg.evalLimit }) : []),
  ];
  const result = { enabled: true, checked: 0, expired, triggered: 0, deferred: 0, invalidated: 0, errors: 0 };
  for (const watch of due) {
    try {
      const one = watch.watch_type === 'llm_watch_dip'
        ? await evaluateOneWatchDip(watch, { handleApprovedBuy })
        : await evaluateOneEntryWatch(watch, { handleApprovedBuy });
      if (one.status === 'triggered') result.triggered++;
      else if (one.status === 'expired') result.expired++;
      else if (one.status === 'deferred' || one.status === 'budget_deferred') result.deferred++;
      else if (one.status === 'invalidated') result.invalidated++;
      else result.checked++;
    } catch (err) {
      result.errors++;
      markEntryWatchChecked(watch.id, {
        nextCheckAtMs: now() + cfg.recheckMs,
        reason: 'entry_watch_error',
        error: err.message,
      });
      console.log(`[entry-watch] ${watch.mint.slice(0, 8)} check failed: ${err.message}`);
    }
  }
  return result;
}
