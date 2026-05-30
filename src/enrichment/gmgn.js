import { randomUUID } from 'node:crypto';
import { GMGN_API_KEY, GMGN_CACHE_TTL_MS, GMGN_ENABLED } from '../config.js';
import { now, sleep } from '../utils.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { insertProviderCall } from '../db/observations.js';
import { normalizeTrendingRiskFields } from './trendingRisk.js';

const gmgnCache = new Map();
let lastGmgnRequestAt = 0;
let gmgnQueue = Promise.resolve();
const gmgnBackoff = {
  tokenUntil: 0,
  tokenReason: '',
  trendingUntil: 0,
  trendingReason: '',
  klineUntil: 0,
  klineReason: '',
};

const TOKEN_KLINE_ENDPOINT = '/v1/market/token_kline';
const SUPPORTED_KLINE_RESOLUTIONS = new Set(['1m', '5m', '15m', '1h', '4h', '1d']);

async function paceGmgnRequest() {
  const delayMs = Math.max(0, numSetting('gmgn_request_delay_ms', 2500));
  if (!delayMs) return;
  const elapsed = now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = now();
}

function enqueueGmgn(work) {
  const run = gmgnQueue.then(work, work);
  gmgnQueue = run.catch(() => {});
  return run;
}

function gmgnErrorText(status, payload, fallback) {
  const raw = String(payload?.raw || payload?.message || payload?.error || fallback || '');
  if (/<title>\s*Just a moment/i.test(raw) || /challenge-platform|cf_chl/i.test(raw)) {
    return 'Cloudflare managed challenge';
  }
  return `${status || ''} ${payload?.code || ''} ${raw}`.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter(item => item != null && item !== '')) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { params = {} } = {}) {
  if (!GMGN_ENABLED) throw new Error('GMGN disabled');
  return enqueueGmgn(async () => {
    const url = new URL(`${process.env.GMGN_HOST || 'https://openapi.gmgn.ai'}${pathname}`);
    appendParams(url, {
      ...params,
      timestamp: Math.floor(now() / 1000),
      client_id: randomUUID(),
    });
    const maxRetries = Math.max(0, Math.floor(numSetting('gmgn_max_retries', 2)));
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await paceGmgnRequest();
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'X-APIKEY': GMGN_API_KEY,
          'Content-Type': 'application/json',
        },
      });
      const text = await res.text().catch(() => '');
      let payload = {};
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        payload = { raw: text };
      }
      if (res.ok) return payload;
      const message = gmgnErrorText(res.status, payload, `GMGN ${pathname} ${res.status}`);
      const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
      if (rateLimited && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const resetAt = Number(res.headers.get('x-ratelimit-reset') || payload?.reset_at);
        const resetWaitMs = Number.isFinite(resetAt) && resetAt > 0 ? Math.max(0, resetAt * 1000 - now()) : null;
        const backoffMs = resetWaitMs ?? (Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : /temporarily banned/i.test(String(message))
            ? 60_000
            : Math.min(30_000, 3000 * 2 ** attempt));
        await sleep(backoffMs);
        continue;
      }
      const error = new Error(message);
      error.response = { status: res.status, data: payload, headers: Object.fromEntries(res.headers.entries()) };
      throw error;
    }
    throw new Error(`GMGN ${pathname} failed`);
  });
}

function gmgnBackoffKey(kind) {
  if (kind === 'trending') return 'trendingUntil';
  if (kind === 'kline') return 'klineUntil';
  return 'tokenUntil';
}

function gmgnReasonKey(kind) {
  if (kind === 'trending') return 'trendingReason';
  if (kind === 'kline') return 'klineReason';
  return 'tokenReason';
}

function gmgnBackoffActive(kind) {
  return now() < Number(gmgnBackoff[gmgnBackoffKey(kind)] || 0);
}

function setGmgnBackoff(kind, err) {
  const status = err.response?.status;
  if (status !== 403 && status !== 429) return;
  const body = err.response?.data || {};
  const resetAtMs = Number(body.reset_at || 0) * 1000;
  const challenge = /Cloudflare managed challenge/i.test(String(err.message));
  const fallbackMs = challenge ? 30 * 60 * 1000 : status === 403 ? 10 * 60 * 1000 : 60 * 1000;
  const until = resetAtMs > now() ? resetAtMs : now() + fallbackMs;
  const reason = gmgnErrorText(status, body, err.message);
  gmgnBackoff[gmgnBackoffKey(kind)] = until;
  gmgnBackoff[gmgnReasonKey(kind)] = reason;
  console.log(`[gmgn:${kind}] backing off until ${new Date(until).toISOString()} (${reason})`);
}

function gmgnStatusText(kind) {
  if (!GMGN_ENABLED) return 'off';
  const key = gmgnBackoffKey(kind);
  if (!gmgnBackoffActive(kind)) return 'ok';
  const seconds = Math.max(1, Math.ceil((Number(gmgnBackoff[key]) - now()) / 1000));
  return `blocked ${seconds}s`;
}

function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(info?.price);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  return Number.isFinite(price) && Number.isFinite(supply) ? price * supply : null;
}

function tokenPriceFromGmgn(info) {
  const price = Number(info?.price);
  return Number.isFinite(price) ? price : null;
}

async function fetchGmgnTokenInfo(mint, useCache = true) {
  if (process.env.CHARON_PROVIDER_STUBS === 'true') {
    return {
      address: mint,
      name: 'Shadow Candidate',
      symbol: 'SHADOW',
      market_cap: 100000,
      price: 0.0001,
      liquidity: 25000,
      holder_count: 100,
      total_fee: 0,
      trade_fee: 0,
      link: { gmgn: `https://gmgn.ai/sol/token/${mint}` },
    };
  }
  if (!GMGN_ENABLED) return null;
  const cached = gmgnCache.get(mint);
  if (useCache && cached && now() - cached.at < GMGN_CACHE_TTL_MS) return cached.data;
  if (gmgnBackoffActive('token')) {
    gmgnCache.set(mint, { at: now(), data: null });
    return null;
  }

  try {
    const payload = await gmgnFetch('/v1/token/info', {
      params: { chain: 'sol', address: mint },
    });
    const data = payload?.data?.data || payload?.data || payload;
    gmgnCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    setGmgnBackoff('token', err);
    if (err.response?.status !== 403 && err.response?.status !== 429) {
      console.log(`[gmgn] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    }
    gmgnCache.set(mint, { at: now(), data: null });
    return null;
  }
}

function normalizedTrendingRows(payload) {
  const rows = payload?.data?.data?.rank
    || payload?.data?.rank
    || payload?.rank
    || payload?.data?.data
    || payload?.data
    || [];
  return Array.isArray(rows) ? rows : [];
}

function normalizeGmgnTrendingRow(row, interval, rank, providerSideFilters = []) {
  const risk = normalizeTrendingRiskFields(row, {
    source: 'gmgn_market_rank',
    providerSideFilters,
  });
  return {
    ...row,
    rug_ratio: risk.rug_ratio,
    bundler_rate: risk.bundler_rate,
    is_wash_trading: risk.is_wash_trading,
    risk_field_availability: risk.risk_field_availability,
    interval,
    rank,
    source: 'gmgn_market_rank',
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intervalMs(interval) {
  const match = String(interval || '').match(/^(\d+)([smhd])$/);
  if (!match) return 60_000;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 60 * 60_000;
  return value * 24 * 60 * 60_000;
}

function unwrapKlineList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.items)) return payload.items;
  return [];
}

function normalizeKlineCandle(row, resolution) {
  const timeMs = numberOrNull(row.time ?? row.unixTime ?? row.unix_time ?? row.t);
  const unixTime = timeMs == null ? null : timeMs > 10_000_000_000 ? Math.floor(timeMs / 1000) : Math.floor(timeMs);
  return {
    unixTime,
    type: resolution,
    o: numberOrNull(row.open ?? row.o),
    h: numberOrNull(row.high ?? row.h),
    l: numberOrNull(row.low ?? row.l),
    c: numberOrNull(row.close ?? row.c),
    v: numberOrNull(row.volume ?? row.v ?? row.v_usd ?? row.volume_usd) ?? 0,
    amount: numberOrNull(row.amount),
    source: 'gmgn_kline',
  };
}

function latestKlineCandle(candles, { interval = '1m', atMs = now() } = {}) {
  const row = candles[candles.length - 1] || null;
  if (!row) return null;
  const startMs = numberOrNull(row.unixTime) == null ? null : Number(row.unixTime) * 1000;
  const durationMs = intervalMs(interval);
  return {
    interval,
    startMs,
    endMs: startMs == null ? null : startMs + durationMs,
    open: row.o,
    high: row.h,
    low: row.l,
    close: row.c,
    volume: row.v,
    finalized: startMs == null ? null : atMs - startMs >= durationMs,
    source: 'gmgn_kline',
  };
}

function klineCacheKey(params) {
  return Object.entries(params)
    .filter(([, value]) => value != null && value !== '')
    .map(([key, value]) => `${key}=${value}`)
    .join(';');
}

function recordKlineCall({
  mint,
  atMs = now(),
  status,
  latencyMs = null,
  cacheKey = null,
  retryAfterMs = null,
  skipReason = null,
  errorClass = null,
  errorMessage = null,
} = {}) {
  insertProviderCall({
    atMs,
    provider: 'gmgn',
    endpoint: TOKEN_KLINE_ENDPOINT,
    mint,
    status,
    latencyMs,
    cacheKey,
    retryAfterMs,
    skipReason,
    costKind: 'gmgn_kline_weight',
    costEstimate: 2,
    errorClass,
    errorMessage,
  });
}

function stubGmgnKline(params = {}) {
  if (process.env.CHARON_PROVIDER_STUB_EMPTY_GMGN_KLINE === 'true') {
    return { payload: { list: [] }, latencyMs: 1 };
  }
  const to = Number(params.to || now());
  const resolution = params.resolution || '1m';
  const step = intervalMs(resolution);
  const count = Math.max(1, Math.trunc(Number(process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT || 8)));
  const list = Array.from({ length: count }, (_, index) => {
    const price = 0.0001 + (index * 0.000002);
    return {
      time: to - ((count - index) * step),
      open: String(price),
      high: String(price * 1.05),
      low: String(price * 0.96),
      close: String(price * 1.02),
      volume: String(100 + index),
      amount: String(1000 + index),
    };
  });
  return { payload: { list }, latencyMs: 1 };
}

async function fetchGmgnKline(mint, {
  atMs = now(),
  interval = '1m',
  count = 15,
  fromMs = null,
  toMs = atMs,
} = {}) {
  if (!SUPPORTED_KLINE_RESOLUTIONS.has(interval)) {
    const err = new Error(`GMGN kline resolution ${interval} is unsupported`);
    err.status = 400;
    throw err;
  }
  const durationMs = intervalMs(interval) * Math.max(1, Math.trunc(Number(count) || 1));
  const params = {
    chain: 'sol',
    address: mint,
    resolution: interval,
    from: fromMs ?? (toMs - durationMs),
    to: toMs,
  };
  const startedAt = now();
  const key = klineCacheKey(params);
  try {
    if (process.env.CHARON_PROVIDER_STUBS !== 'true' && !boolSetting('gmgn_kline_enabled', false)) {
      const err = new Error('gmgn_kline_enabled=false');
      err.skipReason = 'gmgn_kline_disabled';
      throw err;
    }
    if (process.env.CHARON_PROVIDER_STUBS !== 'true' && gmgnBackoffActive('kline')) {
      const err = new Error(`GMGN kline backoff active: ${gmgnStatusText('kline')}`);
      err.skipReason = 'gmgn_kline_backoff';
      throw err;
    }
    const result = process.env.CHARON_PROVIDER_STUBS === 'true'
      ? stubGmgnKline(params)
      : { payload: await gmgnFetch(TOKEN_KLINE_ENDPOINT, { params }), latencyMs: now() - startedAt };
    const data = result.payload?.data ?? result.payload;
    if (data?.code != null && Number(data.code) !== 0) {
      const err = new Error(String(data.message || data.error || `GMGN kline code ${data.code}`).slice(0, 240));
      err.response = { status: Number(data.code), data };
      throw err;
    }
    const candles = unwrapKlineList(data)
      .map(row => normalizeKlineCandle(row, interval))
      .filter(row => row.unixTime != null && row.o != null && row.h != null && row.l != null && row.c != null)
      .sort((a, b) => a.unixTime - b.unixTime);
    recordKlineCall({
      mint,
      atMs: startedAt,
      status: 'ok',
      latencyMs: result.latencyMs,
      cacheKey: key,
    });
    return {
      payload: data,
      latencyMs: result.latencyMs,
      endpoint: TOKEN_KLINE_ENDPOINT,
      source: 'gmgn_kline',
      candles,
      normalized: latestKlineCandle(candles, { interval, atMs: toMs }),
    };
  } catch (err) {
    setGmgnBackoff('kline', err);
    const retryAfterMs = err.response?.headers?.['x-ratelimit-reset']
      ? Math.max(0, Number(err.response.headers['x-ratelimit-reset']) * 1000 - now())
      : null;
    recordKlineCall({
      mint,
      atMs: startedAt,
      status: err.skipReason ? 'skipped' : 'error',
      cacheKey: key,
      retryAfterMs,
      skipReason: err.skipReason || null,
      errorClass: err.response?.data?.error || err.name || 'Error',
      errorMessage: err.message,
    });
    throw err;
  }
}

export {
  gmgnFetch,
  fetchGmgnTokenInfo,
  fetchGmgnKline,
  gmgnBackoffActive,
  setGmgnBackoff,
  gmgnStatusText,
  marketCapFromGmgn,
  tokenPriceFromGmgn,
  normalizedTrendingRows,
  normalizeGmgnTrendingRow,
};
