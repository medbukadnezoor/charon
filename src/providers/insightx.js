import { db } from '../db/connection.js';
import { boolSetting, numSetting, setting } from '../db/settings.js';
import { json, now, safeJson } from '../utils.js';

const PROVIDER = 'insightx';
const ENDPOINT = '/dex-metrics/v1/sol';
const BASE_URL = 'https://api.insightx.network';
const DEFAULT_SAMPLE_RATE = 0.005;
const DEFAULT_RPM_CAP = 5;
const DEFAULT_MONTHLY_CAP = 500;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;

let authKillSwitch = false;
let authKillSwitchReason = null;
let bucketWindowStartMs = 0;
let bucketUsed = 0;
let throttledCount = 0;
let quotaSkipLoggedForMonth = null;

function settingFrom(input, key, fallback) {
  if (input && Object.prototype.hasOwnProperty.call(input, key)) return input[key];
  return setting(key, fallback);
}

function boolFrom(input, key, fallback = false) {
  const value = settingFrom(input, key, fallback ? 'true' : 'false');
  if (value === true || value === 1) return true;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return fallback;
}

function numFrom(input, key, fallback = 0) {
  if (input && Object.prototype.hasOwnProperty.call(input, key)) {
    const value = Number(input[key]);
    return Number.isFinite(value) ? value : fallback;
  }
  return numSetting(key, fallback);
}

function monthStartUtcMs(atMs = now()) {
  const date = new Date(atMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextMonthStartUtcMs(atMs = now()) {
  const date = new Date(atMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function monthlyUsage(atMs = now()) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM provider_call_ledger
    WHERE provider = ?
      AND at_ms >= ?
      AND status IN ('ok', 'throttled', 'error')
  `).get(PROVIDER, monthStartUtcMs(atMs));
  return Number(row?.count || 0);
}

function currentRpmCap(settings = null) {
  return Math.max(1, Math.trunc(numFrom(settings, 'insightx_rpm_cap', DEFAULT_RPM_CAP)));
}

function currentMonthlyCap(settings = null) {
  return Math.max(0, Math.trunc(numFrom(settings, 'insightx_monthly_cap', DEFAULT_MONTHLY_CAP)));
}

function apiKey(env = process.env) {
  return env.INSIGHTX_API_KEY || '';
}

export function isEnabled(settings = null, { env = process.env, atMs = now() } = {}) {
  if (!boolFrom(settings, 'insightx_enabled', false)) return false;
  if (!apiKey(env)) return false;
  if (authKillSwitch) return false;
  const monthlyCap = currentMonthlyCap(settings);
  if (monthlyCap <= 0) return false;
  return monthlyUsage(atMs) < monthlyCap;
}

export function getQuotaState({ settings = null, atMs = now() } = {}) {
  const rpmCap = currentRpmCap(settings);
  const monthlyCap = currentMonthlyCap(settings);
  const inWindow = atMs - bucketWindowStartMs < 60_000;
  return {
    rpm_used: inWindow ? bucketUsed : 0,
    rpm_cap: rpmCap,
    monthly_used: monthlyUsage(atMs),
    monthly_cap: monthlyCap,
    monthly_reset_at_ms: nextMonthStartUtcMs(atMs),
    throttled_count: throttledCount,
    auth_kill_switch: authKillSwitch,
    auth_kill_switch_reason: authKillSwitchReason,
  };
}

function reserveToken(settings = null, atMs = now()) {
  const rpmCap = currentRpmCap(settings);
  if (!bucketWindowStartMs || atMs - bucketWindowStartMs >= 60_000) {
    bucketWindowStartMs = atMs;
    bucketUsed = 0;
  }
  if (bucketUsed >= rpmCap) return false;
  bucketUsed += 1;
  return true;
}

function cacheKey(mint) {
  return `${PROVIDER}:overview:${mint}`;
}

function readCache(mint, ttlMs, atMs = now()) {
  const key = cacheKey(mint);
  const row = db.prepare('SELECT * FROM provider_response_cache WHERE cache_key = ?').get(key);
  if (!row) return { hit: false, key };
  const ageMs = atMs - Number(row.fetched_at_ms || 0);
  const effectiveTtlMs = Math.max(0, Number(row.ttl_ms || ttlMs));
  if (ageMs > effectiveTtlMs) return { hit: false, key, stale: true, ageMs };
  return { hit: true, key, ageMs, payload: safeJson(row.response_json, null) };
}

function writeCache({ mint, payload, ttlMs, atMs = now() }) {
  const key = cacheKey(mint);
  db.prepare(`
    INSERT INTO provider_response_cache (
      cache_key, provider, endpoint, mint, time_bucket, fetched_at_ms, ttl_ms, status, response_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET
      fetched_at_ms = excluded.fetched_at_ms,
      ttl_ms = excluded.ttl_ms,
      status = excluded.status,
      response_json = excluded.response_json
  `).run(key, PROVIDER, ENDPOINT, mint, null, atMs, ttlMs, 'ok', json(payload));
  return key;
}

function writeLedger({
  atMs = now(),
  mint,
  status,
  latencyMs = null,
  cacheKey: key = null,
  ttlMs = null,
  retryAfterMs = null,
  skipReason = null,
  errorClass = null,
  errorMessage = null,
} = {}) {
  db.prepare(`
    INSERT INTO provider_call_ledger (
      at_ms, source_instance, execution_lane, queue_id, observation_id, provider, endpoint,
      mint, status, latency_ms, cache_key, time_bucket, ttl_ms, cache_age_ms,
      attempt_count, retry_after_ms, skip_reason, native_cost_unit_kind,
      native_cost_unit_estimate, error_class, error_message, payload_ref
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    atMs,
    null,
    null,
    null,
    null,
    PROVIDER,
    ENDPOINT,
    mint,
    status,
    Number.isFinite(Number(latencyMs)) ? Math.trunc(Number(latencyMs)) : null,
    key,
    null,
    Number.isFinite(Number(ttlMs)) ? Math.trunc(Number(ttlMs)) : null,
    null,
    1,
    Number.isFinite(Number(retryAfterMs)) ? Math.trunc(Number(retryAfterMs)) : null,
    skipReason,
    'insightx_api_call',
    status === 'ok' ? 1 : 0,
    errorClass,
    errorMessage ? String(errorMessage).replace(/\s+/g, ' ').slice(0, 512) : null,
    null,
  );
}

function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : null;
}

function parseResponse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text).slice(0, 512) };
  }
}

function overviewUrl(mint, baseUrl = BASE_URL) {
  return new URL(`${ENDPOINT}/${encodeURIComponent(mint)}`, baseUrl).toString();
}

export function shouldSampleInsightX(mint, {
  sampleRate = numSetting('insightx_sample_rate', DEFAULT_SAMPLE_RATE),
  decider = null,
  salt = new Date(now()).toISOString().slice(0, 10),
} = {}) {
  if (!mint) return false;
  const rate = Number(sampleRate);
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  if (decider) return Boolean(decider({ mint, sampleRate: rate, salt }));
  const hashInput = `${mint}:${salt}`;
  let hash = 2166136261;
  for (let i = 0; i < hashInput.length; i++) {
    hash ^= hashInput.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) / 0x100000000) < rate;
}

export async function enrichOverview(mint, {
  settings = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  atMs = now(),
  baseUrl = BASE_URL,
} = {}) {
  if (!mint) return null;
  if (!isEnabled(settings, { env, atMs })) return null;

  const ttlMs = Math.max(0, Math.trunc(numFrom(settings, 'insightx_cache_ttl_ms', DEFAULT_CACHE_TTL_MS)));
  const cached = readCache(mint, ttlMs, atMs);
  if (cached.hit) return cached.payload;

  const monthlyCap = currentMonthlyCap(settings);
  const monthKey = monthStartUtcMs(atMs);
  if (monthlyUsage(atMs) >= monthlyCap) {
    if (quotaSkipLoggedForMonth !== monthKey) quotaSkipLoggedForMonth = monthKey;
    return null;
  }
  if (!reserveToken(settings, atMs)) return null;
  if (typeof fetchImpl !== 'function') return null;

  const started = now();
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.trunc(numFrom(settings, 'insightx_request_timeout_ms', DEFAULT_TIMEOUT_MS)));
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const key = cached.key;
  try {
    const response = await fetchImpl(overviewUrl(mint, baseUrl), {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey(env)}`,
        'X-API-KEY': apiKey(env),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = parseResponse(text);
    const latencyMs = now() - started;
    if (response.status === 429) {
      throttledCount += 1;
      writeLedger({
        atMs,
        mint,
        status: 'throttled',
        latencyMs,
        cacheKey: key,
        ttlMs,
        retryAfterMs: retryAfterMs(response.headers),
        errorClass: 'rate_limit',
        errorMessage: payload?.message || payload?.error || 'InsightX rate limited',
      });
      return null;
    }
    if (response.status === 401 || response.status === 403) {
      authKillSwitch = true;
      authKillSwitchReason = `http_${response.status}`;
      writeLedger({
        atMs,
        mint,
        status: 'error',
        latencyMs,
        cacheKey: key,
        ttlMs,
        errorClass: 'auth_failed',
        errorMessage: `InsightX auth failed with HTTP ${response.status}`,
      });
      return null;
    }
    if (!response.ok) {
      writeLedger({
        atMs,
        mint,
        status: 'error',
        latencyMs,
        cacheKey: key,
        ttlMs,
        errorClass: `http_${response.status}`,
        errorMessage: payload?.message || payload?.error || `InsightX HTTP ${response.status}`,
      });
      return null;
    }
    const writtenKey = writeCache({ mint, payload, ttlMs, atMs: now() });
    writeLedger({ atMs, mint, status: 'ok', latencyMs, cacheKey: writtenKey, ttlMs });
    return payload;
  } catch (err) {
    writeLedger({
      atMs,
      mint,
      status: 'error',
      latencyMs: now() - started,
      cacheKey: key,
      ttlMs,
      errorClass: err?.name === 'AbortError' ? 'timeout' : 'network',
      errorMessage: err?.name === 'AbortError' ? 'InsightX request timeout' : err?.message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function __resetInsightXForTests() {
  authKillSwitch = false;
  authKillSwitchReason = null;
  bucketWindowStartMs = 0;
  bucketUsed = 0;
  throttledCount = 0;
  quotaSkipLoggedForMonth = null;
}
