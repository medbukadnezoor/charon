import { db } from './connection.js';
import { boolSetting, setting } from './settings.js';
import {
  INSTANCE_ID,
  LEDGER_WRITER_ENABLED,
  TELEMETRY_FOLLOWUP_BUCKETS_MS,
  TELEMETRY_INITIAL_OBSERVE_DELAY_MS,
} from '../config.js';
import { now, json, safeJson } from '../utils.js';
import {
  validateDecisionAction,
  validateDecisionStage,
  validateExecutionLane,
  validateProvider,
  validateProviderCallStatus,
  validateSourceInstance,
  validateWatchTier,
} from '../telemetry/laneTags.js';
import {
  deltaFromSnapshots,
  executionLaneForRuntime,
  normalizedFeatureSnapshot,
  riskScoreFromSnapshot,
  snapshotColumnValues,
  tierFromSnapshot,
} from '../telemetry/snapshot.js';

function truncateError(value) {
  if (value == null) return null;
  return String(value).replace(/\s+/g, ' ').slice(0, 512);
}

function intOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function configuredBuckets() {
  const raw = setting('telemetry_followup_buckets_ms', TELEMETRY_FOLLOWUP_BUCKETS_MS.join(','));
  const parsed = String(raw)
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isFinite(value) && value > 0);
  return parsed.length ? parsed : TELEMETRY_FOLLOWUP_BUCKETS_MS;
}

function watchWindowForTier(tier) {
  const key = tier === 'A' ? 'telemetry_tier_a_watch_ms' : tier === 'B' ? 'telemetry_tier_b_watch_ms' : 'telemetry_tier_c_watch_ms';
  const fallback = tier === 'A' ? 24 * 60 * 60_000 : tier === 'B' ? 6 * 60 * 60_000 : 60 * 60_000;
  return Number(setting(key, String(fallback))) || fallback;
}

function initialObserveDelay(windowMs) {
  const raw = Number(setting('telemetry_initial_observe_delay_ms', String(TELEMETRY_INITIAL_OBSERVE_DELAY_MS)));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.trunc(raw), windowMs);
}

function scheduleForTier(tier, createdAtMs) {
  const windowMs = watchWindowForTier(tier);
  const maxUntil = createdAtMs + windowMs;
  const buckets = configuredBuckets().filter(bucket => bucket <= windowMs);
  const initialDelayMs = initialObserveDelay(windowMs);
  return {
    tier,
    createdAtMs,
    maxUntil,
    buckets,
    initialDelayMs,
    nextObserveAt: createdAtMs + initialDelayMs,
    completedBuckets: [],
  };
}

function tierRank(tier) {
  return tier === 'A' ? 3 : tier === 'B' ? 2 : 1;
}

function strongerTier(a, b) {
  return tierRank(a) >= tierRank(b) ? a : b;
}

function decisionEvent({ stage, action, candidateId, screeningEventId, batchId, positionId, atMs, key }) {
  return {
    stage,
    action,
    candidateId: intOrNull(candidateId),
    screeningEventId: intOrNull(screeningEventId),
    batchId: intOrNull(batchId),
    positionId: intOrNull(positionId),
    atMs,
    key,
  };
}

function mergeDecisionEvents(existing, next) {
  const seen = new Set();
  const merged = [];
  for (const event of [...(Array.isArray(existing) ? existing : []), next]) {
    if (!event?.key || seen.has(event.key)) continue;
    seen.add(event.key);
    merged.push(event);
  }
  return merged.slice(-20);
}

function activeObservationRow({ mint, sourceInstance, executionLane, atMs }) {
  return db.prepare(`
    SELECT * FROM token_observation_queue
    WHERE mint = ?
      AND source_instance = ?
      AND execution_lane = ?
      AND watch_status IN ('active', 'promoted')
      AND status IN ('pending', 'leased')
      AND max_observation_until_ms >= ?
    ORDER BY
      CASE tier WHEN 'A' THEN 3 WHEN 'B' THEN 2 ELSE 1 END DESC,
      created_at_ms ASC,
      id ASC
    LIMIT 1
  `).get(mint, sourceInstance, executionLane, atMs) || null;
}

function rowDecisionEvent(row) {
  return decisionEvent({
    stage: row.decision_stage,
    action: row.decision_action,
    candidateId: row.candidate_id,
    screeningEventId: row.screening_event_id,
    batchId: row.batch_id,
    positionId: row.position_id,
    atMs: Number(row.updated_at_ms || row.created_at_ms || now()),
    key: row.decision_event_key,
  });
}

function mergeScheduleRows(rows, tier) {
  const schedules = rows.map(row => safeJson(row.schedule_json, {}));
  return {
    ...scheduleForTier(tier, Number(rows[0]?.created_at_ms || now())),
    ...schedules[0],
    tier,
    maxUntil: Math.max(
      ...rows.map(row => Number(row.max_observation_until_ms || 0)),
      ...schedules.map(schedule => Number(schedule.maxUntil || 0)),
    ),
    buckets: [...new Set(schedules.flatMap(schedule => Array.isArray(schedule.buckets) ? schedule.buckets : []))].sort((a, b) => a - b),
    completedBuckets: [...new Set(schedules.flatMap(schedule => Array.isArray(schedule.completedBuckets) ? schedule.completedBuckets : []))].sort((a, b) => a - b),
  };
}

function mergedSnapshotForRows(rows) {
  const snapshots = rows.map(row => safeJson(row.baseline_snapshot_json, {}));
  const lastRow = rows[rows.length - 1] || rows[0];
  let events = [];
  for (const [index, row] of rows.entries()) {
    const snapshotEvents = snapshots[index]?.decisionEvents;
    events = mergeDecisionEvents(events, rowDecisionEvent(row));
    if (Array.isArray(snapshotEvents)) {
      for (const event of snapshotEvents) events = mergeDecisionEvents(events, event);
    }
  }
  return {
    ...(snapshots[0] || {}),
    latestDecisionStage: lastRow?.decision_stage || snapshots[0]?.latestDecisionStage || null,
    latestDecisionAction: lastRow?.decision_action || snapshots[0]?.latestDecisionAction || null,
    decisionEvents: events.length ? events : [rowDecisionEvent(lastRow)],
  };
}

export function reconcileObservationQueueState({ atMs = now(), staleLeaseMs = 10 * 60_000 } = {}) {
  db.prepare(`
    UPDATE token_observation_queue
    SET status = 'pending', lease_owner = NULL, claimed_at_ms = NULL, updated_at_ms = ?
    WHERE status = 'leased' AND claimed_at_ms < ?
  `).run(atMs, atMs - staleLeaseMs);

  let backfilledRows = 0;
  const missingRows = db.prepare(`
    SELECT * FROM token_observation_queue
    WHERE status IN ('pending', 'leased')
      AND watch_status IN ('active', 'promoted')
      AND (baseline_snapshot_json IS NULL OR json_extract(baseline_snapshot_json, '$.decisionEvents') IS NULL)
  `).all();
  const backfill = db.prepare(`
    UPDATE token_observation_queue
    SET baseline_snapshot_json = ?, updated_at_ms = MAX(updated_at_ms, ?)
    WHERE id = ?
  `);
  const backfillTx = db.transaction(() => {
    for (const row of missingRows) {
      const snapshot = mergedSnapshotForRows([row]);
      backfill.run(json(snapshot), atMs, row.id);
      backfilledRows++;
    }
  });
  backfillTx();

  const groups = db.prepare(`
    SELECT mint, source_instance, execution_lane, COUNT(*) AS count
    FROM token_observation_queue
    WHERE status IN ('pending', 'leased')
      AND watch_status IN ('active', 'promoted')
    GROUP BY mint, source_instance, execution_lane
    HAVING COUNT(*) > 1
  `).all();
  let mergedRows = 0;
  const updateKeep = db.prepare(`
    UPDATE token_observation_queue
    SET decision_stage = ?, decision_action = ?, tier = ?, updated_at_ms = ?,
      max_observation_until_ms = MAX(max_observation_until_ms, ?),
      baseline_snapshot_json = ?, schedule_json = ?
    WHERE id = ?
  `);
  const dropDuplicate = db.prepare(`
    UPDATE token_observation_queue
    SET status = 'dropped', watch_status = 'dropped', eligibility_reason = ?, lease_owner = NULL,
      claimed_at_ms = NULL, updated_at_ms = ?
    WHERE id = ? AND status != 'leased'
  `);
  const mergeTx = db.transaction(() => {
    for (const group of groups) {
      const rows = db.prepare(`
        SELECT * FROM token_observation_queue
        WHERE status IN ('pending', 'leased')
          AND watch_status IN ('active', 'promoted')
          AND mint = ? AND source_instance = ? AND execution_lane = ?
        ORDER BY
          CASE status WHEN 'leased' THEN 4 ELSE 0 END DESC,
          CASE tier WHEN 'A' THEN 3 WHEN 'B' THEN 2 ELSE 1 END DESC,
          created_at_ms ASC,
          id ASC
      `).all(group.mint, group.source_instance, group.execution_lane);
      if (rows.length < 2) continue;
      const leasedRows = rows.filter(row => row.status === 'leased');
      if (leasedRows.length > 1) continue;
      const keep = rows[0];
      const drop = rows.slice(1);
      if (drop.some(row => row.status === 'leased')) continue;
      const tier = rows.reduce((best, row) => strongerTier(best, row.tier), keep.tier);
      const snapshot = mergedSnapshotForRows(rows);
      const schedule = mergeScheduleRows(rows, tier);
      updateKeep.run(
        snapshot.latestDecisionStage,
        snapshot.latestDecisionAction,
        tier,
        atMs,
        schedule.maxUntil,
        json(snapshot),
        json(schedule),
        keep.id,
      );
      for (const row of drop) {
        const result = dropDuplicate.run(`merged_into_queue:${keep.id}`, atMs, row.id);
        mergedRows += result.changes;
      }
    }
  });
  mergeTx();
  return { backfilledRows, duplicateGroups: groups.length, mergedRows };
}

function eventKey({ mint, stage, action, candidateId = null, batchId = null, sourceInstance = INSTANCE_ID, atBucketMs = null }) {
  const bucket = atBucketMs ?? Math.floor(now() / 60_000);
  return [sourceInstance, mint, stage, action, candidateId ?? 'no_candidate', batchId ?? 'no_batch', bucket].join(':');
}

function shouldWriteTelemetry() {
  return LEDGER_WRITER_ENABLED || boolSetting('ledger_writer_enabled', false);
}

export function queueCandidateObservation({
  candidate,
  candidateId = null,
  screeningEventId = null,
  batchId = null,
  positionId = null,
  stage = 'candidate_filter',
  action = null,
  executionLane = executionLaneForRuntime(),
  sourceInstance = INSTANCE_ID,
  eligibilityReason = null,
  atMs = now(),
} = {}) {
  if (!shouldWriteTelemetry()) return { queued: false, reason: 'writer_disabled' };
  try {
    const mint = candidate?.token?.mint;
    if (!mint) throw new Error('queueCandidateObservation requires candidate.token.mint');
    const decisionAction = action || (candidate.filters?.passed ? 'passed' : 'filtered');
    validateSourceInstance(sourceInstance);
    validateExecutionLane(executionLane);
    validateDecisionStage(stage);
    validateDecisionAction(decisionAction);
    const snapshot = normalizedFeatureSnapshot(candidate);
    const tier = tierFromSnapshot(snapshot, decisionAction);
    validateWatchTier(tier);
    const schedule = scheduleForTier(tier, atMs);
    const key = eventKey({ mint, stage, action: decisionAction, candidateId, batchId, sourceInstance, atBucketMs: Math.floor(atMs / 60_000) });
    const risk = riskScoreFromSnapshot(snapshot);
    const status = tier === 'C' && risk >= 0.75 ? 'dropped' : 'pending';
    const watchStatus = status === 'dropped' ? 'dropped' : 'active';
    const nextEvent = decisionEvent({ stage, action: decisionAction, candidateId, screeningEventId, batchId, positionId, atMs, key });
    const activeRow = status !== 'dropped' ? activeObservationRow({ mint, sourceInstance, executionLane, atMs }) : null;
    if (activeRow) {
      const existingSnapshot = safeJson(activeRow.baseline_snapshot_json, {});
      const existingSchedule = safeJson(activeRow.schedule_json, {});
      const mergedTier = strongerTier(activeRow.tier, tier);
      const mergedSchedule = {
        ...scheduleForTier(mergedTier, Number(activeRow.created_at_ms || atMs)),
        ...existingSchedule,
        tier: mergedTier,
        maxUntil: Math.max(Number(existingSchedule.maxUntil || 0), schedule.maxUntil, Number(activeRow.max_observation_until_ms || 0)),
        buckets: [...new Set([...(existingSchedule.buckets || []), ...schedule.buckets])].sort((a, b) => a - b),
        completedBuckets: Array.isArray(existingSchedule.completedBuckets) ? existingSchedule.completedBuckets : [],
      };
      const decisionEvents = mergeDecisionEvents(existingSnapshot.decisionEvents, nextEvent);
      const mergedSnapshot = {
        ...existingSnapshot,
        latestDecisionStage: stage,
        latestDecisionAction: decisionAction,
        decisionEvents,
      };
      db.prepare(`
        UPDATE token_observation_queue
        SET updated_at_ms = ?,
          tier = ?,
          decision_stage = ?,
          decision_action = ?,
          candidate_id = COALESCE(candidate_id, ?),
          screening_event_id = COALESCE(screening_event_id, ?),
          batch_id = COALESCE(batch_id, ?),
          position_id = COALESCE(position_id, ?),
          strategy_id = COALESCE(strategy_id, ?),
          eligibility_reason = COALESCE(?, eligibility_reason),
          filter_blocker_count = MAX(filter_blocker_count, ?),
          rug_risk_score = MAX(COALESCE(rug_risk_score, 0), ?),
          max_observation_until_ms = MAX(max_observation_until_ms, ?),
          baseline_snapshot_json = ?,
          schedule_json = ?
        WHERE id = ?
      `).run(
        atMs,
        mergedTier,
        stage,
        decisionAction,
        intOrNull(candidateId),
        intOrNull(screeningEventId),
        intOrNull(batchId),
        intOrNull(positionId),
        snapshot.filterPassed ? candidate.filters?.strategy || candidate.signals?.strategy || null : candidate.filters?.strategy || null,
        eligibilityReason || snapshot.primaryFailureCode || 'candidate_seen',
        intOrNull(snapshot.failureCount) ?? 0,
        risk,
        mergedSchedule.maxUntil,
        json(mergedSnapshot),
        json(mergedSchedule),
        activeRow.id,
      );
      return {
        queued: true,
        merged: true,
        id: Number(activeRow.id),
        key,
        status: activeRow.status,
        tier: mergedTier,
      };
    }
    const insertSnapshot = {
      ...snapshot,
      latestDecisionStage: stage,
      latestDecisionAction: decisionAction,
      decisionEvents: [nextEvent],
    };
    const result = db.prepare(`
      INSERT INTO token_observation_queue (
        mint, source_instance, execution_lane, decision_stage, decision_action, decision_event_key,
        candidate_id, screening_event_id, batch_id, position_id, strategy_id, status, tier, watch_status,
        eligibility_reason, filter_blocker_count, rug_risk_score, next_observe_at_ms,
        max_observation_until_ms, created_at_ms, updated_at_ms, baseline_snapshot_json, schedule_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(decision_event_key) DO UPDATE SET
        updated_at_ms = excluded.updated_at_ms,
        candidate_id = COALESCE(token_observation_queue.candidate_id, excluded.candidate_id),
        batch_id = COALESCE(token_observation_queue.batch_id, excluded.batch_id),
        position_id = COALESCE(token_observation_queue.position_id, excluded.position_id)
    `).run(
      mint,
      sourceInstance,
      executionLane,
      stage,
      decisionAction,
      key,
      intOrNull(candidateId),
      intOrNull(screeningEventId),
      intOrNull(batchId),
      intOrNull(positionId),
      snapshot.filterPassed ? candidate.filters?.strategy || candidate.signals?.strategy || null : candidate.filters?.strategy || null,
      status,
      tier,
      watchStatus,
      eligibilityReason || snapshot.primaryFailureCode || 'candidate_seen',
      intOrNull(snapshot.failureCount) ?? 0,
      risk,
      schedule.nextObserveAt,
      schedule.maxUntil,
      atMs,
      atMs,
      json(insertSnapshot),
      json(schedule),
    );
    return {
      queued: true,
      id: Number(result.lastInsertRowid || db.prepare('SELECT id FROM token_observation_queue WHERE decision_event_key = ?').get(key)?.id),
      key,
      status,
      tier,
    };
  } catch (err) {
    console.log(`[telemetry] queue writer failed: ${truncateError(err.message)}`);
    return { queued: false, reason: 'writer_error', error: truncateError(err.message) };
  }
}

function minTierRank(tier) {
  if (tier === 'A') return 3;
  if (tier === 'B') return 2;
  return 1;
}

export function claimDueObservationRows({
  limit = 10,
  leaseOwner = 'collector',
  atMs = now(),
  staleLeaseMs = 10 * 60_000,
  minTier = 'C',
  minCreatedAgeMs = 0,
} = {}) {
  reconcileObservationQueueState({ atMs, staleLeaseMs });
  const minRank = minTierRank(minTier);
  const createdBeforeMs = atMs - Math.max(0, Number(minCreatedAgeMs) || 0);
  const rows = db.prepare(`
    SELECT * FROM token_observation_queue
    WHERE status = 'pending'
      AND watch_status IN ('active', 'promoted')
      AND next_observe_at_ms <= ?
      AND max_observation_until_ms >= ?
      AND created_at_ms <= ?
      AND CASE tier WHEN 'A' THEN 3 WHEN 'B' THEN 2 ELSE 1 END >= ?
      AND id IN (
        SELECT MIN(id)
        FROM token_observation_queue
        WHERE status = 'pending'
          AND watch_status IN ('active', 'promoted')
          AND next_observe_at_ms <= ?
          AND max_observation_until_ms >= ?
          AND created_at_ms <= ?
          AND CASE tier WHEN 'A' THEN 3 WHEN 'B' THEN 2 ELSE 1 END >= ?
        GROUP BY mint, source_instance, execution_lane
      )
    ORDER BY next_observe_at_ms ASC, id ASC
    LIMIT ?
  `).all(atMs, atMs, createdBeforeMs, minRank, atMs, atMs, createdBeforeMs, minRank, limit);
  const claim = db.prepare(`
    UPDATE token_observation_queue
    SET status = 'leased', lease_owner = ?, claimed_at_ms = ?, attempt_count = attempt_count + 1, updated_at_ms = ?
    WHERE id = ? AND status = 'pending'
  `);
  const claimed = [];
  const tx = db.transaction(() => {
    for (const row of rows) {
      const result = claim.run(leaseOwner, atMs, atMs, row.id);
      if (result.changes === 1) claimed.push({ ...row, status: 'leased', lease_owner: leaseOwner, claimed_at_ms: atMs, attempt_count: row.attempt_count + 1 });
    }
  });
  tx();
  return claimed;
}

export function postponeObservationQueueRow({ row, nextObserveAtMs, reason = null, atMs = now() } = {}) {
  db.prepare(`
    UPDATE token_observation_queue
    SET status = 'pending',
      lease_owner = NULL,
      claimed_at_ms = NULL,
      next_observe_at_ms = ?,
      last_error = ?,
      updated_at_ms = ?
    WHERE id = ?
  `).run(intOrNull(nextObserveAtMs) ?? atMs, truncateError(reason), atMs, row.id);
}

export function insertProviderCall({
  atMs = now(),
  sourceInstance = null,
  executionLane = null,
  queueId = null,
  observationId = null,
  provider,
  endpoint,
  mint = null,
  status,
  latencyMs = null,
  cacheKey = null,
  timeBucket = null,
  ttlMs = null,
  cacheAgeMs = null,
  attemptCount = 1,
  retryAfterMs = null,
  skipReason = null,
  costKind = null,
  costEstimate = null,
  errorClass = null,
  errorMessage = null,
  payloadRef = null,
} = {}) {
  validateProvider(provider);
  validateProviderCallStatus(status);
  const result = db.prepare(`
    INSERT INTO provider_call_ledger (
      at_ms, source_instance, execution_lane, queue_id, observation_id, provider, endpoint,
      mint, status, latency_ms, cache_key, time_bucket, ttl_ms, cache_age_ms,
      attempt_count, retry_after_ms, skip_reason, native_cost_unit_kind,
      native_cost_unit_estimate, error_class, error_message, payload_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    atMs,
    sourceInstance,
    executionLane,
    intOrNull(queueId),
    intOrNull(observationId),
    provider,
    endpoint,
    mint,
    status,
    intOrNull(latencyMs),
    cacheKey,
    timeBucket,
    intOrNull(ttlMs),
    intOrNull(cacheAgeMs),
    intOrNull(attemptCount) ?? 1,
    intOrNull(retryAfterMs),
    skipReason,
    costKind,
    numberOrNull(costEstimate),
    errorClass,
    truncateError(errorMessage),
    payloadRef,
  );
  return Number(result.lastInsertRowid);
}

export function insertTokenObservation({ queueRow, featureSnapshot, providerSet, qualityFlags = {}, payloadRefs = {}, ohlcv = null, atMs = now() }) {
  const baseline = safeJson(queueRow.baseline_snapshot_json, {});
  const snapshot = { ...baseline, ...featureSnapshot };
  const columns = snapshotColumnValues(snapshot);
  const delta = deltaFromSnapshots(baseline, snapshot);
  const result = db.prepare(`
    INSERT INTO token_observations (
      queue_id, mint, observed_at_ms, source_instance, execution_lane, observation_kind,
      provider_set, quality_flags_json, baseline_observation_id, delta_metrics_json,
      price_usd, market_cap_usd, liquidity_usd, volume_24h_usd, holder_count,
      top_holder_percent, top20_holder_percent, fee_claim_sol, gmgn_total_fee_sol,
      saved_wallet_holders, saved_wallet_strong_count, saved_wallet_kol_count,
      trending_source, trending_volume_usd, trending_swaps, trending_rug_ratio,
      trending_bundler_rate, trending_is_wash_trading, ohlcv_interval,
      ohlcv_candle_start_ms, ohlcv_candle_end_ms, ohlcv_open, ohlcv_high,
      ohlcv_low, ohlcv_close, ohlcv_volume, ohlcv_finalized,
      feature_snapshot_json, provider_payload_refs_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    queueRow.id,
    queueRow.mint,
    atMs,
    queueRow.source_instance,
    queueRow.execution_lane,
    queueRow.created_at_ms === queueRow.next_observe_at_ms ? 'baseline' : 'followup',
    providerSet,
    json(qualityFlags),
    db.prepare('SELECT MIN(id) AS id FROM token_observations WHERE queue_id = ?').get(queueRow.id)?.id ?? null,
    json(delta),
    columns.price_usd,
    columns.market_cap_usd,
    columns.liquidity_usd,
    numberOrNull(snapshot.volume24hUsd),
    columns.holder_count,
    columns.top_holder_percent,
    columns.top20_holder_percent,
    columns.fee_claim_sol,
    columns.gmgn_total_fee_sol,
    columns.saved_wallet_holders,
    columns.saved_wallet_strong_count,
    columns.saved_wallet_kol_count,
    columns.trending_source,
    columns.trending_volume_usd,
    columns.trending_swaps,
    columns.trending_rug_ratio,
    columns.trending_bundler_rate,
    columns.trending_is_wash_trading,
    ohlcv?.interval || null,
    intOrNull(ohlcv?.startMs),
    intOrNull(ohlcv?.endMs),
    numberOrNull(ohlcv?.open),
    numberOrNull(ohlcv?.high),
    numberOrNull(ohlcv?.low),
    numberOrNull(ohlcv?.close),
    numberOrNull(ohlcv?.volume),
    ohlcv?.finalized == null ? null : (ohlcv.finalized ? 1 : 0),
    json(snapshot),
    json(payloadRefs),
  );
  return Number(result.lastInsertRowid);
}

export function finishObservationQueueRow({ row, status = 'pending', atMs = now(), error = null, droppedReason = null } = {}) {
  const schedule = safeJson(row.schedule_json, {});
  const completed = Array.isArray(schedule.completedBuckets) ? schedule.completedBuckets : [];
  const elapsed = atMs - Number(row.created_at_ms || atMs);
  const nextBucket = (schedule.buckets || []).find(bucket => bucket > elapsed && !completed.includes(bucket));
  const nextObserveAt = nextBucket ? Number(row.created_at_ms) + nextBucket : null;
  const complete = !nextObserveAt || nextObserveAt > Number(row.max_observation_until_ms);
  const nextStatus = droppedReason ? 'dropped' : complete ? 'observed' : status;
  const watchStatus = droppedReason ? 'dropped' : complete ? 'complete' : row.watch_status;
  db.prepare(`
    UPDATE token_observation_queue
    SET status = ?, watch_status = ?, next_observe_at_ms = COALESCE(?, next_observe_at_ms),
      lease_owner = NULL, claimed_at_ms = NULL, last_error = ?, eligibility_reason = COALESCE(?, eligibility_reason),
      schedule_json = ?, updated_at_ms = ?
    WHERE id = ?
  `).run(
    nextStatus,
    watchStatus,
    nextObserveAt,
    truncateError(error),
    droppedReason,
    json({ ...schedule, completedBuckets: [...new Set([...completed, Math.max(0, elapsed)])] }),
    atMs,
    row.id,
  );
}

export function failObservationQueueRow(row, err, { atMs = now(), maxAttempts = 5 } = {}) {
  const attempt = Number(row.attempt_count || 0);
  const status = attempt >= maxAttempts ? 'error' : 'pending';
  db.prepare(`
    UPDATE token_observation_queue
    SET status = ?, lease_owner = NULL, claimed_at_ms = NULL, last_error = ?, next_observe_at_ms = ?, updated_at_ms = ?
    WHERE id = ?
  `).run(status, truncateError(err.message || err), atMs + Math.min(60 * 60_000, 60_000 * Math.max(1, attempt)), atMs, row.id);
}

export function startCollectorRun({ collectorId, sourceInstance = INSTANCE_ID, executionLane = null, atMs = now() }) {
  const result = db.prepare(`
    INSERT INTO telemetry_collector_runs (
      started_at_ms, collector_id, source_instance, execution_lane, status, summary_json
    ) VALUES (?, ?, ?, ?, 'running', ?)
  `).run(atMs, collectorId, sourceInstance, executionLane, json({}));
  return Number(result.lastInsertRowid);
}

export function finishCollectorRun(runId, patch = {}) {
  const finishedAt = now();
  db.prepare(`
    UPDATE telemetry_collector_runs
    SET finished_at_ms = ?, status = ?, claimed_count = ?, observed_count = ?,
      provider_ok_count = ?, provider_error_count = ?, cache_hit_count = ?,
      budget_skip_count = ?, stale_skip_count = ?, dropped_count = ?,
      stuck_lease_count = ?, overdue_count = ?, last_error = ?, summary_json = ?
    WHERE id = ?
  `).run(
    finishedAt,
    patch.status || 'ok',
    patch.claimedCount || 0,
    patch.observedCount || 0,
    patch.providerOkCount || 0,
    patch.providerErrorCount || 0,
    patch.cacheHitCount || 0,
    patch.budgetSkipCount || 0,
    patch.staleSkipCount || 0,
    patch.droppedCount || 0,
    patch.stuckLeaseCount || 0,
    patch.overdueCount || 0,
    truncateError(patch.lastError),
    json(patch.summary || {}),
    runId,
  );
}

export function telemetryDoctorSummary({
  limit = 20,
  atMs = now(),
  staleCollectorMs = 15 * 60_000,
  staleLeaseMs = 10 * 60_000,
  providerErrorWindowMs = 15 * 60_000,
  overdueGraceMs = 10 * 60_000,
} = {}) {
  const counts = db.prepare(`
    SELECT source_instance, execution_lane, status, watch_status, COUNT(*) AS count, MAX(updated_at_ms) AS newest_ms
    FROM token_observation_queue
    GROUP BY source_instance, execution_lane, status, watch_status
    ORDER BY source_instance, execution_lane, status, watch_status
  `).all();
  const overdue = db.prepare(`
    SELECT COUNT(*) AS count, MIN(next_observe_at_ms) AS oldest_ms
    FROM token_observation_queue
    WHERE status = 'pending' AND watch_status IN ('active', 'promoted') AND next_observe_at_ms < ?
  `).get(atMs);
  const overdueCount = Number(overdue.count || 0);
  const oldestOverdueAgeMs = overdue.oldest_ms ? Math.max(0, atMs - Number(overdue.oldest_ms)) : 0;
  const stuckLeases = db.prepare(`
    SELECT COUNT(*) AS count FROM token_observation_queue
    WHERE status = 'leased' AND claimed_at_ms < ?
  `).get(atMs - staleLeaseMs).count;
  const lastRun = db.prepare('SELECT * FROM telemetry_collector_runs ORDER BY started_at_ms DESC LIMIT 1').get() || null;
  const lastCompletedRun = db.prepare(`
    SELECT * FROM telemetry_collector_runs
    WHERE finished_at_ms IS NOT NULL AND status != 'running'
    ORDER BY finished_at_ms DESC, started_at_ms DESC
    LIMIT 1
  `).get() || null;
  const recentProviderErrors = db.prepare(`
    SELECT provider, endpoint, status, error_class, COUNT(*) AS count, MAX(at_ms) AS newest_ms
    FROM provider_call_ledger
    WHERE status IN ('error', 'stale')
      AND at_ms >= ?
    GROUP BY provider, endpoint, status, error_class
    ORDER BY count DESC
    LIMIT ?
  `).all(atMs - providerErrorWindowMs, limit);
  const providerErrorHistory = db.prepare(`
    SELECT provider, endpoint, status, error_class, COUNT(*) AS count, MAX(at_ms) AS newest_ms
    FROM provider_call_ledger
    WHERE status IN ('error', 'skipped', 'stale')
    GROUP BY provider, endpoint, status, error_class
    ORDER BY newest_ms DESC
    LIMIT ?
  `).all(limit);
  const providerCounts = db.prepare(`
    SELECT provider, endpoint, status, COUNT(*) AS count, MAX(at_ms) AS newest_ms
    FROM provider_call_ledger
    GROUP BY provider, endpoint, status
    ORDER BY provider, endpoint, status
    LIMIT ?
  `).all(limit);
  const observationCoverage = db.prepare(`
    SELECT source_instance, execution_lane,
      COUNT(*) AS observations,
      SUM(CASE WHEN price_usd IS NOT NULL THEN 1 ELSE 0 END) AS with_price,
      SUM(CASE WHEN holder_count IS NOT NULL THEN 1 ELSE 0 END) AS with_holders,
      SUM(CASE WHEN ohlcv_interval IS NOT NULL THEN 1 ELSE 0 END) AS with_ohlcv,
      SUM(CASE WHEN ohlcv_finalized = 0 THEN 1 ELSE 0 END) AS active_candles,
      MAX(observed_at_ms) AS newest_ms
    FROM token_observations
    GROUP BY source_instance, execution_lane
    ORDER BY source_instance, execution_lane
  `).all();
  const latestOhlcvCall = db.prepare(`
    SELECT status, MAX(at_ms) AS newest_ms, COUNT(*) AS count
    FROM provider_call_ledger
    WHERE provider = 'birdeye' AND endpoint = '/defi/v3/ohlcv'
    GROUP BY status
    ORDER BY newest_ms DESC
    LIMIT ?
  `).all(limit);
  const staleCollector = !lastRun || Number(lastRun.finished_at_ms || lastRun.started_at_ms || 0) < atMs - staleCollectorMs;
  const recentRows = db.prepare(`
    SELECT id, mint, source_instance, execution_lane, status, watch_status, tier, next_observe_at_ms, attempt_count, last_error
    FROM token_observation_queue
    ORDER BY updated_at_ms DESC
    LIMIT ?
  `).all(limit);
  const blockers = [];
  if (staleCollector) blockers.push('collector_stale_or_missing');
  if (overdueCount > 0 && (staleCollector || oldestOverdueAgeMs > overdueGraceMs)) blockers.push('overdue_queue_rows');
  if (stuckLeases > 0) blockers.push('stuck_leases');
  const latestRunProviderErrors = Number(lastCompletedRun?.provider_error_count || 0);
  if (latestRunProviderErrors > 0) blockers.push('provider_errors');
  return {
    generated_at_ms: atMs,
    generated_at: new Date(atMs).toISOString(),
    writer_enabled: shouldWriteTelemetry(),
    blockers,
    counts,
    overdue_queue_rows: overdueCount,
    overdue_oldest_age_ms: oldestOverdueAgeMs,
    overdue_grace_ms: overdueGraceMs,
    overdue_backlog_warning: overdueCount > 0 && !blockers.includes('overdue_queue_rows'),
    stuck_leases: stuckLeases,
    stale_collector: staleCollector,
    last_collector_run: lastRun,
    last_completed_collector_run: lastCompletedRun,
    provider_counts: providerCounts,
    observation_coverage: observationCoverage,
    latest_ohlcv_calls: latestOhlcvCall,
    provider_errors: recentProviderErrors,
    provider_error_history: providerErrorHistory,
    provider_error_window_ms: providerErrorWindowMs,
    latest_run_provider_error_count: latestRunProviderErrors,
    recent_queue_rows: recentRows,
  };
}
