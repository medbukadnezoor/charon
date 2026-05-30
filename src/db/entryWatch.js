import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';
import { numSetting } from './settings.js';
import { insertProviderCall } from './observations.js';

const WATCH_STATUSES = new Set(['active', 'triggered', 'expired', 'invalidated', 'cancelled']);

function intOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function truncateError(value) {
  if (!value) return null;
  return String(value).slice(0, 512);
}

function normalize(row) {
  return row ? { ...row, snapshot: safeJson(row.snapshot_json, {}) } : null;
}

export function activeEntryWatchCount(watchType = null) {
  if (watchType) {
    return db.prepare(`
      SELECT COUNT(*) AS count
      FROM entry_watchlist
      WHERE status = 'active' AND watch_type = ? AND expires_at_ms > ?
    `).get(watchType, now()).count;
  }
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM entry_watchlist
    WHERE status = 'active' AND expires_at_ms > ?
  `).get(now()).count;
}

export function getActiveEntryWatch(mint, strategyId = null, watchType = null) {
  const row = strategyId
    ? db.prepare(`
        SELECT * FROM entry_watchlist
        WHERE mint = ? AND strategy_id = ? AND (? IS NULL OR watch_type = ?) AND status = 'active' AND expires_at_ms > ?
        ORDER BY created_at_ms DESC
        LIMIT 1
      `).get(mint, strategyId, watchType, watchType, now())
    : db.prepare(`
        SELECT * FROM entry_watchlist
        WHERE mint = ? AND (? IS NULL OR watch_type = ?) AND status = 'active' AND expires_at_ms > ?
        ORDER BY created_at_ms DESC
        LIMIT 1
      `).get(mint, watchType, watchType, now());
  return normalize(row);
}

export function insertEntryWatch({
  mint,
  watchType = 'entry_reject',
  cohort = null,
  strategyId = null,
  originalCandidateId,
  originalDecisionId = null,
  originalBatchId = null,
  originalRejectReason = null,
  originalEntryScore = null,
  originalCandleSource = null,
  originalCandleCount = null,
  originalMcap = null,
  originalPrice = null,
  rejectionHighPrice = null,
  rejectionHighMcap = null,
  nextCheckAtMs = null,
  windowMs = 60 * 60_000,
  snapshot = {},
} = {}) {
  const atMs = now();
  const existing = getActiveEntryWatch(mint, strategyId, watchType);
  if (existing) return { id: existing.id, inserted: false };
  const result = db.prepare(`
    INSERT INTO entry_watchlist (
      mint, status, watch_type, cohort, strategy_id, original_candidate_id, original_decision_id,
      original_batch_id, original_reject_reason, original_entry_score,
      original_candle_source, original_candle_count, original_mcap, original_price,
      rejection_high_price, rejection_high_mcap, best_low_price, best_low_mcap,
      attempt_count, next_check_at_ms, expires_at_ms, snapshot_json,
      created_at_ms, updated_at_ms
    ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
  `).run(
    mint,
    watchType,
    cohort,
    strategyId,
    intOrNull(originalCandidateId),
    intOrNull(originalDecisionId),
    intOrNull(originalBatchId),
    originalRejectReason,
    numberOrNull(originalEntryScore),
    originalCandleSource,
    intOrNull(originalCandleCount),
    numberOrNull(originalMcap),
    numberOrNull(originalPrice),
    numberOrNull(rejectionHighPrice),
    numberOrNull(rejectionHighMcap),
    numberOrNull(rejectionHighPrice),
    numberOrNull(rejectionHighMcap),
    intOrNull(nextCheckAtMs) ?? atMs,
    atMs + Math.max(1, intOrNull(windowMs) ?? 60 * 60_000),
    json(snapshot),
    atMs,
    atMs,
  );
  return { id: Number(result.lastInsertRowid), inserted: true };
}

export function listDueEntryWatches({ limit = 3, atMs = now() } = {}) {
  return db.prepare(`
    SELECT * FROM entry_watchlist
    WHERE status = 'active'
      AND next_check_at_ms <= ?
      AND expires_at_ms > ?
    ORDER BY next_check_at_ms ASC, id ASC
    LIMIT ?
  `).all(atMs, atMs, Math.max(1, intOrNull(limit) ?? 3)).map(normalize);
}

export function listDueEntryWatchesByType({ watchType, limit = 3, atMs = now() } = {}) {
  return db.prepare(`
    SELECT * FROM entry_watchlist
    WHERE status = 'active'
      AND watch_type = ?
      AND next_check_at_ms <= ?
      AND expires_at_ms > ?
    ORDER BY next_check_at_ms ASC, id ASC
    LIMIT ?
  `).all(watchType, atMs, atMs, Math.max(1, intOrNull(limit) ?? 3)).map(normalize);
}

export function expireDueEntryWatches(atMs = now()) {
  return db.prepare(`
    UPDATE entry_watchlist
    SET status = 'expired',
      last_check_at_ms = ?,
      last_check_reason = 'expired',
      updated_at_ms = ?
    WHERE status = 'active' AND expires_at_ms <= ?
  `).run(atMs, atMs, atMs).changes;
}

export function markEntryWatchChecked(id, {
  nextCheckAtMs,
  reason,
  entryScore = null,
  candleSource = null,
  candleCount = null,
  lowPrice = null,
  lowMcap = null,
  error = null,
  atMs = now(),
} = {}) {
  const row = db.prepare('SELECT best_low_price, best_low_mcap FROM entry_watchlist WHERE id = ?').get(id);
  const bestLowPrice = numberOrNull(lowPrice) == null
    ? row?.best_low_price ?? null
    : Math.min(...[row?.best_low_price, lowPrice].map(numberOrNull).filter(value => value != null));
  const bestLowMcap = numberOrNull(lowMcap) == null
    ? row?.best_low_mcap ?? null
    : Math.min(...[row?.best_low_mcap, lowMcap].map(numberOrNull).filter(value => value != null));
  db.prepare(`
    UPDATE entry_watchlist
    SET attempt_count = attempt_count + 1,
      next_check_at_ms = ?,
      last_check_at_ms = ?,
      last_check_reason = ?,
      last_entry_score = ?,
      last_candle_source = ?,
      last_candle_count = ?,
      best_low_price = ?,
      best_low_mcap = ?,
      last_error = ?,
      updated_at_ms = ?
    WHERE id = ?
  `).run(
    intOrNull(nextCheckAtMs) ?? atMs,
    atMs,
    reason || null,
    numberOrNull(entryScore),
    candleSource,
    intOrNull(candleCount),
    bestLowPrice,
    bestLowMcap,
    truncateError(error),
    atMs,
    id,
  );
}

export function markEntryWatchStatus(id, status, { reason = null, atMs = now() } = {}) {
  if (!WATCH_STATUSES.has(status)) throw new Error(`Invalid entry watch status: ${status}`);
  db.prepare(`
    UPDATE entry_watchlist
    SET status = ?,
      last_check_at_ms = ?,
      last_check_reason = ?,
      updated_at_ms = ?
    WHERE id = ?
  `).run(status, atMs, reason, atMs, id);
}

export function markEntryWatchTriggered(id, { candidateId = null, positionId = null, reason = 'triggered', atMs = now() } = {}) {
  db.prepare(`
    UPDATE entry_watchlist
    SET status = 'triggered',
      triggered_candidate_id = ?,
      triggered_position_id = ?,
      triggered_at_ms = ?,
      last_check_at_ms = ?,
      last_check_reason = ?,
      updated_at_ms = ?
    WHERE id = ?
  `).run(intOrNull(candidateId), intOrNull(positionId), atMs, atMs, reason, atMs, id);
}

function budgetStartMs(atMs = now()) {
  const configured = Math.max(0, Math.trunc(numSetting('entry_watch_birdeye_budget_start_ms', 0)));
  const date = new Date(atMs);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.max(dayStart, configured);
}

export function entryWatchBirdeyeCuUsedToday(atMs = now()) {
  return birdeyeCuUsedToday({ costKind: 'birdeye_entry_watch_cu', atMs });
}

export function birdeyeCuUsedToday({ costKind = 'birdeye_entry_watch_cu', atMs = now() } = {}) {
  return db.prepare(`
    SELECT COALESCE(SUM(native_cost_unit_estimate), 0) AS total
    FROM provider_call_ledger
    WHERE provider = 'birdeye'
      AND native_cost_unit_kind = ?
      AND status IN ('ok', 'error')
      AND at_ms >= ?
  `).get(costKind, budgetStartMs(atMs)).total || 0;
}

export function reserveEntryWatchBirdeyeBudget({ watchId = null, mint = null, estimatedCu = 3, atMs = now() } = {}) {
  return reserveBirdeyeCuBudget({
    watchId,
    mint,
    estimatedCu,
    atMs,
    capSettingKey: 'entry_watch_birdeye_daily_cu_cap',
    capFallback: 300,
    costKind: 'birdeye_entry_watch_cu',
    endpoint: 'entry_watch_budget',
    skipReason: 'entry_watch_birdeye_daily_cu_cap_reached',
  });
}

export function reserveWatchDipBirdeyeBudget({ watchId = null, mint = null, estimatedCu = 3, atMs = now() } = {}) {
  return reserveBirdeyeCuBudget({
    watchId,
    mint,
    estimatedCu,
    atMs,
    capSettingKey: 'llm_watch_dip_birdeye_daily_cu_cap',
    capFallback: 10_000,
    costKind: 'birdeye_watch_dip_cu',
    endpoint: 'llm_watch_dip_budget',
    skipReason: 'llm_watch_dip_birdeye_daily_cu_cap_reached',
  });
}

function reserveBirdeyeCuBudget({
  watchId = null,
  mint = null,
  estimatedCu = 3,
  atMs = now(),
  capSettingKey,
  capFallback,
  costKind,
  endpoint,
  skipReason,
} = {}) {
  const cap = Math.max(0, Math.trunc(numSetting(capSettingKey, capFallback)));
  const cost = Math.max(1, Number(estimatedCu) || 3);
  const used = Number(birdeyeCuUsedToday({ costKind, atMs }) || 0);
  if (cap > 0 && used + cost > cap) {
    insertProviderCall({
      atMs,
      sourceInstance: 'primary',
      executionLane: 'primary_live',
      provider: 'birdeye',
      endpoint,
      mint,
      status: 'skipped',
      skipReason,
      costKind,
      costEstimate: 0,
      payloadRef: watchId == null ? null : `entry_watch:${watchId}`,
    });
    return { ok: false, cap, used, cost };
  }
  insertProviderCall({
    atMs,
    sourceInstance: 'primary',
    executionLane: 'primary_live',
    provider: 'birdeye',
    endpoint,
    mint,
    status: 'ok',
    costKind,
    costEstimate: cost,
    payloadRef: watchId == null ? null : `entry_watch:${watchId}`,
  });
  return { ok: true, cap, used, cost };
}
