import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn } from '../utils.js';

const HIGH_DISAGREEMENT_PERCENT = 50;
const NEAR_THRESHOLD_PERCENT = 10;

async function defaultFetchGmgn(mint, useCache) {
  const { fetchGmgnTokenInfo } = await import('./gmgn.js');
  return fetchGmgnTokenInfo(mint, useCache);
}

async function defaultFetchAsset(mint, options) {
  const { fetchJupiterAsset } = await import('./jupiter.js');
  return fetchJupiterAsset(mint, options);
}

function positiveReading(source, value, { priceUsd = null, fallback = false, stale = false } = {}) {
  const marketCapUsd = Number(value);
  if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0) return null;
  const price = Number(priceUsd);
  return {
    source,
    marketCapUsd,
    priceUsd: Number.isFinite(price) && price > 0 ? price : null,
    fallback,
    stale,
  };
}

function sourceReadings({ gmgn, jupiterAsset, trendingToken, fallbackMarketCapUsd, fallbackPriceUsd, fallbackReadings = [] }) {
  const fallbackEntries = Array.isArray(fallbackReadings) && fallbackReadings.length
    ? fallbackReadings
    : [{ source: 'fallback_market_cap', marketCapUsd: fallbackMarketCapUsd, priceUsd: fallbackPriceUsd }];
  return [
    positiveReading('gmgn_market_cap', marketCapFromGmgn(gmgn), {
      priceUsd: tokenPriceFromGmgn(gmgn),
    }),
    positiveReading('jupiter_mcap', jupiterAsset?.mcap, {
      priceUsd: jupiterAsset?.usdPrice,
    }),
    positiveReading('jupiter_fdv', jupiterAsset?.fdv, {
      priceUsd: jupiterAsset?.usdPrice,
    }),
    positiveReading('trending_market_cap', trendingToken?.market_cap, {
      priceUsd: trendingToken?.price,
    }),
    ...fallbackEntries.map(entry => positiveReading(entry.source || 'fallback_market_cap', entry.marketCapUsd, {
      priceUsd: entry.priceUsd,
      fallback: true,
      stale: true,
    })),
  ].filter(Boolean);
}

function disagreementPercent(readings, chosen) {
  if (!chosen || readings.length < 2) return 0;
  const values = readings.map(reading => Number(reading.marketCapUsd)).filter(value => Number.isFinite(value) && value > 0);
  if (values.length < 2) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  return chosen.marketCapUsd > 0 ? (max - min) / chosen.marketCapUsd * 100 : 0;
}

function nearThreshold(marketCapUsd, thresholds = {}) {
  const value = Number(marketCapUsd);
  if (!Number.isFinite(value) || value <= 0) return false;
  const min = Number(thresholds.minMarketCapUsd);
  const max = Number(thresholds.maxMarketCapUsd);
  const nearMin = Number.isFinite(min) && min > 0 && Math.abs(value - min) / min * 100 <= NEAR_THRESHOLD_PERCENT;
  const nearMax = Number.isFinite(max) && max > 0 && Math.abs(value - max) / max * 100 <= NEAR_THRESHOLD_PERCENT;
  return nearMin || nearMax;
}

function compactProvider(provider) {
  if (!provider || typeof provider !== 'object') return null;
  return {
    name: provider.name ?? null,
    symbol: provider.symbol ?? null,
    mcap: provider.mcap ?? provider.market_cap ?? null,
    fdv: provider.fdv ?? null,
    price: provider.price ?? provider.usdPrice ?? null,
  };
}

export async function sampleMarketCap({
  mint,
  context = 'unknown',
  gmgn = undefined,
  jupiterAsset = undefined,
  trendingToken = null,
  fallbackMarketCapUsd = null,
  fallbackPriceUsd = null,
  fallbackReadings = [],
  useCache = true,
  thresholds = {},
  logger = console.log,
  fetchGmgn = defaultFetchGmgn,
  fetchAsset = defaultFetchAsset,
} = {}) {
  if (!mint) throw new Error('sampleMarketCap requires mint');
  const sampledAtMs = now();
  const uncachedRequested = useCache === false;
  const selectedGmgn = gmgn === undefined ? await fetchGmgn(mint, useCache) : gmgn;
  const selectedAsset = jupiterAsset === undefined ? await fetchAsset(mint, { useCache }) : jupiterAsset;
  const readings = sourceReadings({
    gmgn: selectedGmgn,
    jupiterAsset: selectedAsset,
    trendingToken,
    fallbackMarketCapUsd,
    fallbackPriceUsd,
    fallbackReadings,
  });
  const chosen = readings[0] || null;
  const marketCapUsd = chosen?.marketCapUsd ?? null;
  const priceUsd = firstPositiveNumber(chosen?.priceUsd, tokenPriceFromGmgn(selectedGmgn), selectedAsset?.usdPrice, trendingToken?.price, fallbackPriceUsd);
  const disagreement = disagreementPercent(readings, chosen);
  const highDisagreement = disagreement >= HIGH_DISAGREEMENT_PERCENT;
  const thresholdNear = nearThreshold(marketCapUsd, thresholds);
  const fallbackUsed = Boolean(chosen?.fallback);
  const sample = {
    context,
    mint,
    marketCapUsd,
    priceUsd,
    source: chosen?.source ?? null,
    readings,
    disagreementPercent: disagreement,
    sampledAtMs,
    flags: {
      fallbackUsed,
      staleFallbackUsed: Boolean(chosen?.stale),
      highDisagreement,
      nearThreshold: thresholdNear,
      uncachedRequested,
    },
    providers: {
      gmgn: compactProvider(selectedGmgn),
      jupiterAsset: compactProvider(selectedAsset),
      trending: compactProvider(trendingToken),
    },
  };

  if ((highDisagreement || thresholdNear) && logger) {
    logger(`[mcap-sampler] ${context} ${mint.slice(0, 8)} source=${sample.source || 'none'} mcap=${marketCapUsd ?? 'missing'} disagreement=${disagreement.toFixed(1)}% fallback=${fallbackUsed}`);
  }

  return {
    ...sample,
    gmgn: selectedGmgn,
    jupiterAsset: selectedAsset,
  };
}
