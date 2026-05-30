import { db } from '../db/connection.js';
import {
  claimDueObservationRows,
  failObservationQueueRow,
  finishCollectorRun,
  finishObservationQueueRow,
  insertProviderCall,
  insertTokenObservation,
  postponeObservationQueueRow,
  startCollectorRun,
} from '../db/observations.js';
import {
  TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS,
  TELEMETRY_BIRDEYE_BUDGET_START_MS,
  TELEMETRY_BIRDEYE_DAILY_CALL_CAP,
  TELEMETRY_BIRDEYE_ENDPOINTS,
  TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED,
  TELEMETRY_COLLECTOR_ID,
  TELEMETRY_COLLECTOR_MODE,
  TELEMETRY_MAX_QUEUE_ATTEMPTS,
  TELEMETRY_COLLECTOR_ENABLED,
  TELEMETRY_MIN_OBSERVE_AGE_MS,
  TELEMETRY_MIN_WATCH_TIER,
  TELEMETRY_OHLCV_INTERVAL,
} from '../config.js';
import { fetchBirdeyeHolders, fetchBirdeyeMarketData, fetchBirdeyeOhlcv, fetchBirdeyeTokenTxCandle } from '../enrichment/birdeye.js';
import { now, json, safeJson } from '../utils.js';
import { setting, boolSetting, numSetting } from '../db/settings.js';

const ENDPOINT_POLICY = {
  '/defi/v3/token/market-data': { ttlMs: 5 * 60_000, costKind: 'birdeye_api_call', costEstimate: 1 },
  '/defi/v3/token/holder': { ttlMs: 15 * 60_000, costKind: 'birdeye_api_call', costEstimate: 1 },
  '/defi/v3/ohlcv': { ttlMs: 5 * 60_000, costKind: 'birdeye_api_call', costEstimate: 1 },
  '/defi/v3/token/txs': { ttlMs: 60_000, costKind: 'birdeye_api_call', costEstimate: 1 },
};

const ENDPOINT_ALIASES = {
  market: '/defi/v3/token/market-data',
  'market-data': '/defi/v3/token/market-data',
  holders: '/defi/v3/token/holder',
  holder: '/defi/v3/token/holder',
  ohlcv: '/defi/v3/ohlcv',
  txs: '/defi/v3/token/txs',
  'token-txs': '/defi/v3/token/txs',
};

class BudgetExceededError extends Error {
  constructor(message = 'birdeye_budget_exceeded') {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

function stringSetting(key, fallback) {
  const value = setting(key, fallback);
  return value == null || value === '' ? fallback : String(value);
}

function normalizedCollectorMode() {
  return stringSetting('telemetry_collector_mode', TELEMETRY_COLLECTOR_MODE).toLowerCase();
}

function configuredEndpointSet(mode = normalizedCollectorMode()) {
  const raw = stringSetting('telemetry_birdeye_endpoints', TELEMETRY_BIRDEYE_ENDPOINTS);
  const selected = raw
    ? raw.split(',').map(value => ENDPOINT_ALIASES[value.trim().toLowerCase()] || value.trim()).filter(Boolean)
    : mode === 'outcome_ohlcv'
      ? ['/defi/v3/ohlcv']
      : Object.keys(ENDPOINT_POLICY);
  return new Set(selected.filter(endpoint => ENDPOINT_POLICY[endpoint]));
}

function tokenTxFallbackEnabled(mode = normalizedCollectorMode()) {
  if (mode === 'outcome_ohlcv') {
    return boolSetting('telemetry_birdeye_token_tx_fallback_enabled', false);
  }
  return boolSetting('telemetry_birdeye_token_tx_fallback_enabled', TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED);
}

function dailyCallCap() {
  return Math.max(0, Math.trunc(numSetting('telemetry_birdeye_daily_call_cap', TELEMETRY_BIRDEYE_DAILY_CALL_CAP)));
}

function budgetCooldownMs() {
  return Math.max(60_000, Math.trunc(numSetting('telemetry_birdeye_budget_cooldown_ms', TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS)));
}

function budgetStartMs(atMs = now()) {
  const configured = Math.max(0, Math.trunc(numSetting('telemetry_birdeye_budget_start_ms', TELEMETRY_BIRDEYE_BUDGET_START_MS)));
  return Math.max(utcDayStartMs(atMs), configured);
}

function minWatchTier() {
  const tier = stringSetting('telemetry_min_watch_tier', TELEMETRY_MIN_WATCH_TIER).toUpperCase();
  return ['A', 'B', 'C'].includes(tier) ? tier : 'C';
}

function minObserveAgeMs() {
  return Math.max(0, Math.trunc(numSetting('telemetry_min_observe_age_ms', TELEMETRY_MIN_OBSERVE_AGE_MS)));
}

function utcDayStartMs(atMs = now()) {
  const date = new Date(atMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function birdeyeNetworkCallsToday(atMs = now()) {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM provider_call_ledger
    WHERE provider = 'birdeye'
      AND endpoint != 'budget_policy'
      AND status IN ('ok', 'error')
      AND at_ms >= ?
  `).get(budgetStartMs(atMs)).count;
}

function hasBirdeyeBudget(atMs = now()) {
  const cap = dailyCallCap();
  if (cap <= 0) return true;
  return Number(birdeyeNetworkCallsToday(atMs) || 0) < cap;
}

function collectorPolicy() {
  const mode = normalizedCollectorMode();
  return {
    mode,
    endpoints: configuredEndpointSet(mode),
    tokenTxFallbackEnabled: tokenTxFallbackEnabled(mode),
    minTier: minWatchTier(),
    minCreatedAgeMs: minObserveAgeMs(),
  };
}

function timeBucket(endpoint, atMs = now()) {
  const ttl = ENDPOINT_POLICY[endpoint]?.ttlMs || 5 * 60_000;
  return String(Math.floor(atMs / ttl));
}

function cacheKey(provider, endpoint, mint, bucket, variant = 'default') {
  return [provider, endpoint, variant, mint, bucket].join(':');
}

function freshCache(provider, endpoint, mint, atMs = now(), variant = 'default') {
  const policy = ENDPOINT_POLICY[endpoint];
  const bucket = timeBucket(endpoint, atMs);
  const key = cacheKey(provider, endpoint, mint, bucket, variant);
  const row = db.prepare('SELECT * FROM provider_response_cache WHERE cache_key = ?').get(key);
  if (!row) return { hit: false, key, bucket, policy };
  const ageMs = atMs - Number(row.fetched_at_ms || 0);
  if (ageMs > Number(row.ttl_ms || 0)) return { hit: false, key, bucket, policy, stale: true, ageMs };
  return {
    hit: true,
    key,
    bucket,
    policy,
    ageMs,
    payload: safeJson(row.response_json, {}),
  };
}

function writeCache({ provider, endpoint, mint, bucket, policy, payload, atMs = now(), status = 'ok', variant = 'default' }) {
  const key = cacheKey(provider, endpoint, mint, bucket, variant);
  db.prepare(`
    INSERT INTO provider_response_cache (
      cache_key, provider, endpoint, mint, time_bucket, fetched_at_ms, ttl_ms, status, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      fetched_at_ms = CASE WHEN excluded.fetched_at_ms > provider_response_cache.fetched_at_ms THEN excluded.fetched_at_ms ELSE provider_response_cache.fetched_at_ms END,
      ttl_ms = excluded.ttl_ms,
      status = excluded.status,
      response_json = CASE WHEN excluded.fetched_at_ms > provider_response_cache.fetched_at_ms THEN excluded.response_json ELSE provider_response_cache.response_json END
  `).run(key, provider, endpoint, mint, bucket, atMs, policy.ttlMs, status, json(payload));
  return key;
}

async function callWithCache({ queueRow, endpoint, fetcher, counters, variant = 'default' }) {
  const atMs = now();
  const cached = freshCache('birdeye', endpoint, queueRow.mint, atMs, variant);
  if (cached.hit) {
    counters.cacheHitCount++;
    insertProviderCall({
      atMs,
      sourceInstance: queueRow.source_instance,
      executionLane: queueRow.execution_lane,
      queueId: queueRow.id,
      provider: 'birdeye',
      endpoint,
      mint: queueRow.mint,
      status: 'cache_hit',
      cacheKey: cached.key,
      timeBucket: cached.bucket,
      ttlMs: cached.policy.ttlMs,
      cacheAgeMs: cached.ageMs,
      costKind: cached.policy.costKind,
      costEstimate: 0,
    });
    return cached.payload;
  }

  if (!hasBirdeyeBudget(atMs)) {
    throw new BudgetExceededError();
  }

  try {
    const result = await fetcher(queueRow.mint);
    const key = writeCache({
      provider: 'birdeye',
      endpoint,
      mint: queueRow.mint,
      bucket: cached.bucket,
      policy: cached.policy,
      payload: result,
      atMs: now(),
      variant,
    });
    counters.providerOkCount++;
    insertProviderCall({
      atMs,
      sourceInstance: queueRow.source_instance,
      executionLane: queueRow.execution_lane,
      queueId: queueRow.id,
      provider: 'birdeye',
      endpoint,
      mint: queueRow.mint,
      status: 'ok',
      latencyMs: result.latencyMs,
      cacheKey: key,
      timeBucket: cached.bucket,
      ttlMs: cached.policy.ttlMs,
      costKind: cached.policy.costKind,
      costEstimate: cached.policy.costEstimate,
    });
    return result;
  } catch (err) {
    counters.providerErrorCount++;
    insertProviderCall({
      atMs,
      sourceInstance: queueRow.source_instance,
      executionLane: queueRow.execution_lane,
      queueId: queueRow.id,
      provider: 'birdeye',
      endpoint,
      mint: queueRow.mint,
      status: 'error',
      cacheKey: cached.key,
      timeBucket: cached.bucket,
      ttlMs: cached.policy?.ttlMs,
      retryAfterMs: err.retryAfterMs,
      costKind: cached.policy?.costKind,
      costEstimate: 0,
      errorClass: err.status ? `http_${err.status}` : err.name,
      errorMessage: err.message,
    });
    throw err;
  }
}

function mergeProviderSnapshot(queueRow, market, holders) {
  const baseline = safeJson(queueRow.baseline_snapshot_json, {});
  return {
    ...baseline,
    ...(market?.normalized || {}),
    ...(holders?.normalized || {}),
  };
}

function shouldDropBeforeExpensiveFollowup(queueRow) {
  return queueRow.tier === 'C' && Number(queueRow.attempt_count || 0) > 1;
}

function endpointEnabled(policy, endpoint) {
  return policy.endpoints.has(endpoint);
}

function recordBudgetSkip(queueRow, counters, reason = 'birdeye_daily_call_cap_reached') {
  const atMs = now();
  counters.budgetSkipCount++;
  insertProviderCall({
    atMs,
    sourceInstance: queueRow.source_instance,
    executionLane: queueRow.execution_lane,
    queueId: queueRow.id,
    provider: 'birdeye',
    endpoint: 'budget_policy',
    mint: queueRow.mint,
    status: 'skipped',
    skipReason: reason,
    costKind: 'birdeye_api_call',
    costEstimate: 0,
  });
  postponeObservationQueueRow({
    row: queueRow,
    nextObserveAtMs: atMs + budgetCooldownMs(),
    reason,
    atMs,
  });
}

async function observeQueueRow(queueRow, counters, policy = collectorPolicy()) {
  if (shouldDropBeforeExpensiveFollowup(queueRow)) {
    counters.droppedCount++;
    insertProviderCall({
      sourceInstance: queueRow.source_instance,
      executionLane: queueRow.execution_lane,
      queueId: queueRow.id,
      provider: 'birdeye',
      endpoint: 'budget_policy',
      mint: queueRow.mint,
      status: 'skipped',
      skipReason: 'tier_c_expensive_followup_blocked',
      costKind: 'birdeye_api_call',
      costEstimate: 0,
    });
    finishObservationQueueRow({ row: queueRow, droppedReason: 'tier_c_expensive_followup_blocked' });
    return;
  }

  if (!hasBirdeyeBudget()) {
    recordBudgetSkip(queueRow, counters);
    return;
  }

  let market = null;
  let holders = null;
  let ohlcv = null;
  let candleSource = 'not_requested';
  try {
    if (endpointEnabled(policy, '/defi/v3/token/market-data')) {
      market = await callWithCache({
        queueRow,
        endpoint: '/defi/v3/token/market-data',
        fetcher: fetchBirdeyeMarketData,
        counters,
      });
    }
    if (endpointEnabled(policy, '/defi/v3/token/holder')) {
      holders = await callWithCache({
        queueRow,
        endpoint: '/defi/v3/token/holder',
        fetcher: fetchBirdeyeHolders,
        counters,
      });
    }
    if (endpointEnabled(policy, '/defi/v3/ohlcv')) {
      ohlcv = await callWithCache({
        queueRow,
        endpoint: '/defi/v3/ohlcv',
        fetcher: (mint) => fetchBirdeyeOhlcv(mint, { atMs: now(), interval: TELEMETRY_OHLCV_INTERVAL }),
        counters,
        variant: `interval=${TELEMETRY_OHLCV_INTERVAL};mode=count;count_limit=2`,
      });
      candleSource = ohlcv?.normalized ? 'ohlcv' : 'unavailable';
    }
    if (!ohlcv?.normalized && policy.tokenTxFallbackEnabled && endpointEnabled(policy, '/defi/v3/token/txs')) {
      ohlcv = await callWithCache({
        queueRow,
        endpoint: '/defi/v3/token/txs',
        fetcher: (mint) => fetchBirdeyeTokenTxCandle(mint, { atMs: now(), interval: TELEMETRY_OHLCV_INTERVAL }),
        counters,
        variant: `interval=${TELEMETRY_OHLCV_INTERVAL};tx_type=swap`,
      });
      candleSource = ohlcv?.normalized ? 'token_txs' : 'unavailable';
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      recordBudgetSkip(queueRow, counters);
      return;
    }
    throw err;
  }

  if (!market && !holders && !ohlcv) {
    counters.budgetSkipCount++;
    insertProviderCall({
      sourceInstance: queueRow.source_instance,
      executionLane: queueRow.execution_lane,
      queueId: queueRow.id,
      provider: 'birdeye',
      endpoint: 'budget_policy',
      mint: queueRow.mint,
      status: 'skipped',
      skipReason: 'no_birdeye_endpoints_enabled',
      costKind: 'birdeye_api_call',
      costEstimate: 0,
    });
    finishObservationQueueRow({ row: queueRow, droppedReason: 'no_birdeye_endpoints_enabled' });
    return;
  }

  const providerSet = [
    'birdeye',
    endpointEnabled(policy, '/defi/v3/token/market-data') ? 'market' : null,
    endpointEnabled(policy, '/defi/v3/token/holder') ? 'holders' : null,
    endpointEnabled(policy, '/defi/v3/ohlcv') ? 'ohlcv' : null,
    candleSource === 'token_txs' ? 'txs' : null,
  ].filter(Boolean).join('_');

  const snapshot = mergeProviderSnapshot(queueRow, market, holders);
  const observationId = insertTokenObservation({
    queueRow,
    featureSnapshot: snapshot,
    providerSet,
    qualityFlags: {
      activeCandle: ohlcv?.normalized?.finalized === false,
      ohlcvAvailable: Boolean(ohlcv?.normalized),
      ohlcvUnavailable: endpointEnabled(policy, '/defi/v3/ohlcv') && !ohlcv?.normalized,
      candleSource,
      providerErrors: false,
      collectorMode: policy.mode,
      endpoints: [...policy.endpoints],
    },
    payloadRefs: {
      marketData: market ? 'provider_response_cache:/defi/v3/token/market-data' : null,
      holders: holders ? 'provider_response_cache:/defi/v3/token/holder' : null,
      ohlcv: ohlcv ? 'provider_response_cache:/defi/v3/ohlcv' : null,
      tokenTxs: candleSource === 'token_txs' ? 'provider_response_cache:/defi/v3/token/txs' : null,
    },
    ohlcv: ohlcv?.normalized || null,
  });
  counters.observedCount++;
  for (const endpoint of Object.keys(ENDPOINT_POLICY)) {
    db.prepare(`
      UPDATE provider_call_ledger
      SET observation_id = ?
      WHERE queue_id = ? AND observation_id IS NULL AND endpoint = ?
    `).run(observationId, queueRow.id, endpoint);
  }
  finishObservationQueueRow({ row: queueRow });
}

export async function runTelemetryCollector({ limit = 10, requireEnabled = false, collectorId = TELEMETRY_COLLECTOR_ID } = {}) {
  if (requireEnabled && !TELEMETRY_COLLECTOR_ENABLED) {
    throw new Error('TELEMETRY_COLLECTOR_ENABLED must be true for this collector run');
  }
  const policy = collectorPolicy();
  const counters = {
    claimedCount: 0,
    observedCount: 0,
    providerOkCount: 0,
    providerErrorCount: 0,
    cacheHitCount: 0,
    budgetSkipCount: 0,
    staleSkipCount: 0,
    droppedCount: 0,
    stuckLeaseCount: 0,
    overdueCount: 0,
  };
  const runId = startCollectorRun({ collectorId });
  let status = 'ok';
  let lastError = null;
  try {
    const rows = claimDueObservationRows({
      limit,
      leaseOwner: collectorId,
      minTier: policy.minTier,
      minCreatedAgeMs: policy.minCreatedAgeMs,
    });
    counters.claimedCount = rows.length;
    for (const row of rows) {
      try {
        await observeQueueRow(row, counters, policy);
      } catch (err) {
        lastError = err.message;
        console.log(`[telemetry] collector row ${row.id} ${row.mint.slice(0, 8)} failed: ${err.message}`);
        failObservationQueueRow(row, err, { maxAttempts: TELEMETRY_MAX_QUEUE_ATTEMPTS });
      }
    }
  } catch (err) {
    status = 'error';
    lastError = err.message;
    throw err;
  } finally {
    finishCollectorRun(runId, {
      status,
      ...counters,
      lastError,
      summary: counters,
    });
  }
  return counters;
}
