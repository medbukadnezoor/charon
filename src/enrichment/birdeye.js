import { BIRDEYE_API_KEY, JSON_HEADERS, TELEMETRY_PROVIDER_TIMEOUT_MS, TELEMETRY_PROVIDER_MIN_INTERVAL_MS } from '../config.js';
import { now, sleep } from '../utils.js';

const BASE_URL = 'https://public-api.birdeye.so';
let lastRequestAt = 0;

function providerStubsEnabled() {
  return process.env.CHARON_PROVIDER_STUBS === 'true';
}

async function paceBirdeye() {
  const elapsed = now() - lastRequestAt;
  const waitMs = Math.max(0, TELEMETRY_PROVIDER_MIN_INTERVAL_MS - elapsed);
  if (waitMs > 0) await sleep(waitMs);
  lastRequestAt = now();
}

function requireBirdeyeKey() {
  if (!BIRDEYE_API_KEY) {
    const err = new Error('BIRDEYE_API_KEY missing');
    err.status = 401;
    throw err;
  }
}

async function birdeyeGet(pathname, params = {}) {
  if (providerStubsEnabled()) return stubBirdeye(pathname, params);
  requireBirdeyeKey();
  await paceBirdeye();
  const url = new URL(pathname, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEMETRY_PROVIDER_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        ...JSON_HEADERS,
        'X-API-KEY': BIRDEYE_API_KEY,
        'x-chain': 'solana',
      },
      signal: controller.signal,
    });
    const text = await res.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text.slice(0, 512) };
    }
    if (!res.ok) {
      const err = new Error(String(payload?.message || payload?.error || payload?.raw || `Birdeye ${res.status}`).slice(0, 512));
      err.status = res.status;
      err.payload = payload;
      err.retryAfterMs = Number(res.headers.get('retry-after')) ? Number(res.headers.get('retry-after')) * 1000 : null;
      throw err;
    }
    return {
      payload,
      latencyMs: now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function unwrapData(payload) {
  return payload?.data?.items || payload?.data?.list || payload?.data || payload;
}

function intervalMs(interval) {
  const match = String(interval || '').match(/^(\d+)([smhd])$/);
  if (!match) return 5 * 60_000;
  const value = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return value * 1000;
  if (unit === 'm') return value * 60_000;
  if (unit === 'h') return value * 60 * 60_000;
  return value * 24 * 60 * 60_000;
}

function latestCandle(payload, { interval = '5m', atMs = now() } = {}) {
  const rows = unwrapData(payload);
  const items = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
  const row = items[items.length - 1] || null;
  if (!row) return null;
  const startSec = Number(row.unixTime ?? row.unix_time ?? row.t ?? row.time);
  const startMs = Number.isFinite(startSec) ? startSec * 1000 : null;
  const durationMs = intervalMs(interval);
  return {
    interval: row.type || null,
    startMs,
    endMs: startMs ? startMs + durationMs : null,
    open: Number(row.o ?? row.open),
    high: Number(row.h ?? row.high),
    low: Number(row.l ?? row.low),
    close: Number(row.c ?? row.close),
    volume: Number(row.v_usd ?? row.volume_usd ?? row.v ?? row.volume),
    finalized: startMs ? atMs - startMs >= durationMs : null,
  };
}

function normalizeMarketData(payload) {
  const data = unwrapData(payload) || {};
  return {
    priceUsd: numberOrNull(data.price ?? data.price_usd ?? data.last_price),
    marketCapUsd: numberOrNull(data.market_cap ?? data.marketCap ?? data.mc),
    liquidityUsd: numberOrNull(data.liquidity ?? data.liquidity_usd),
    volume24hUsd: numberOrNull(data.volume_24h_usd ?? data.volume24h ?? data.v24hUSD ?? data.volume24hUSD),
    holderCount: integerOrNull(data.holder ?? data.holder_count ?? data.holderCount),
  };
}

function normalizeHolders(payload) {
  const data = unwrapData(payload) || {};
  const rows = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : Array.isArray(data.holders) ? data.holders : [];
  const holders = rows.map((row, index) => ({
    address: row.owner || row.address || row.wallet || null,
    amount: numberOrNull(row.amount ?? row.ui_amount),
    percent: numberOrNull(row.percentage ?? row.percent),
    rank: index + 1,
  }));
  const top20 = holders.slice(0, 20);
  return {
    holderCount: integerOrNull(data.total ?? data.count ?? holders.length) ?? holders.length,
    topHolderPercent: numberOrNull(top20[0]?.percent),
    top20HolderPercent: top20.reduce((sum, row) => sum + Number(row.percent || 0), 0) || null,
  };
}

function priceForMint(row, mint) {
  if (row.from?.address === mint) return numberOrNull(row.from?.price);
  if (row.to?.address === mint) return numberOrNull(row.to?.price);
  return numberOrNull(row.price ?? row.token_price ?? row.price_usd);
}

function candleFromTokenTxs(payload, { mint, interval = '5m', atMs = now() } = {}) {
  const rows = unwrapData(payload);
  const items = Array.isArray(rows) ? rows : Array.isArray(rows?.items) ? rows.items : [];
  const durationMs = intervalMs(interval);
  const startMs = atMs - durationMs;
  const points = items
    .map(row => ({
      atMs: numberOrNull(row.block_unix_time) == null ? null : Number(row.block_unix_time) * 1000,
      price: priceForMint(row, mint),
      volume: numberOrNull(row.volume_usd),
    }))
    .filter(row => row.atMs != null && row.atMs >= startMs && row.atMs <= atMs && row.price != null)
    .sort((a, b) => a.atMs - b.atMs);
  if (!points.length) return null;
  return {
    interval,
    startMs,
    endMs: atMs,
    open: points[0].price,
    high: Math.max(...points.map(point => point.price)),
    low: Math.min(...points.map(point => point.price)),
    close: points[points.length - 1].price,
    volume: points.reduce((sum, point) => sum + Number(point.volume || 0), 0),
    finalized: false,
    source: 'token_txs',
    sampleCount: points.length,
  };
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function stubBirdeye(pathname, params = {}) {
  if (/ohlcv/.test(pathname)) {
    if (process.env.CHARON_PROVIDER_STUB_EMPTY_OHLCV === 'true') {
      return {
        payload: { data: { items: [] } },
        latencyMs: 1,
      };
    }
    const endSec = Number(params.time_to || Math.floor(now() / 1000));
    return {
      payload: {
        data: {
          items: [{
            unixTime: endSec - 300,
            o: 0.0001,
            h: 0.00016,
            l: 0.00008,
            c: 0.00014,
            v: 12345,
          }],
        },
      },
      latencyMs: 1,
    };
  }
  if (/token\/txs/.test(pathname)) {
    const endSec = Number(params.before_time || Math.floor(now() / 1000));
    const mint = params.address || 'StubMint111111111111111111111111111111111';
    return {
      payload: {
        data: {
          items: [
            {
              block_unix_time: endSec - 45,
              volume_usd: 10,
              from: { address: mint, price: 0.0001 },
              to: { address: 'So11111111111111111111111111111111111111112', price: 160 },
            },
            {
              block_unix_time: endSec - 15,
              volume_usd: 20,
              from: { address: 'So11111111111111111111111111111111111111112', price: 160 },
              to: { address: mint, price: 0.00015 },
            },
          ],
        },
      },
      latencyMs: 1,
    };
  }
  if (/holder/.test(pathname)) {
    return {
      payload: {
        data: {
          total: 123,
          items: [
            { owner: 'Holder1111111111111111111111111111111111', percentage: 12.5 },
            { owner: 'Holder2222222222222222222222222222222222', percentage: 8.5 },
          ],
        },
      },
      latencyMs: 1,
    };
  }
  return {
    payload: {
      data: {
        price: 0.00014,
        market_cap: 140000,
        liquidity: 25000,
        volume_24h_usd: 90000,
        holder_count: 123,
      },
    },
    latencyMs: 1,
  };
}

export async function fetchBirdeyeMarketData(mint) {
  const result = await birdeyeGet('/defi/v3/token/market-data', {
    address: mint,
    ui_amount_mode: 'scaled',
  });
  return {
    ...result,
    endpoint: '/defi/v3/token/market-data',
    normalized: normalizeMarketData(result.payload),
  };
}

export async function fetchBirdeyeHolders(mint) {
  const result = await birdeyeGet('/defi/v3/token/holder', {
    address: mint,
    offset: 0,
    limit: 20,
  });
  return {
    ...result,
    endpoint: '/defi/v3/token/holder',
    normalized: normalizeHolders(result.payload),
  };
}

export async function fetchBirdeyeOhlcv(mint, { atMs = now(), interval = '5m', count = 2 } = {}) {
  const to = Math.floor(atMs / 1000);
  const result = await birdeyeGet('/defi/v3/ohlcv', {
    address: mint,
    type: interval,
    currency: 'usd',
    time_to: to,
    mode: 'count',
    count_limit: count,
    padding: false,
    ui_amount_mode: 'scaled',
  });
  const candle = latestCandle(result.payload, { interval, atMs });
  const candles = Array.isArray(result.payload?.items) ? result.payload.items : [];
  return {
    ...result,
    endpoint: '/defi/v3/ohlcv',
    normalized: candle ? { ...candle, interval } : null,
    candles,
  };
}

export async function fetchBirdeyeTokenTxCandle(mint, { atMs = now(), interval = '5m' } = {}) {
  const to = Math.floor(atMs / 1000);
  const from = Math.floor((atMs - intervalMs(interval)) / 1000);
  const result = await birdeyeGet('/defi/v3/token/txs', {
    address: mint,
    offset: 0,
    limit: 100,
    sort_by: 'block_unix_time',
    sort_type: 'desc',
    tx_type: 'swap',
    after_time: from,
    before_time: to,
    ui_amount_mode: 'scaled',
  });
  const candle = candleFromTokenTxs(result.payload, { mint, interval, atMs });
  return {
    ...result,
    endpoint: '/defi/v3/token/txs',
    normalized: candle,
  };
}
