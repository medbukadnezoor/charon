import { boolSetting, numSetting, setting } from '../db/settings.js';
import { reserveEntryWatchBirdeyeBudget, reserveWatchDipBirdeyeBudget } from '../db/entryWatch.js';
import { fetchBirdeyeEntryCandles } from './birdeye.js';
import { fetchGmgnKline } from './gmgn.js';
import { now } from '../utils.js';

const SUPPORTED_PROVIDERS = new Set(['birdeye', 'gmgn']);

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

export function resolveEntryCandleProviderOrder(purpose = 'entry_confirm', override = null) {
  const raw = Array.isArray(override)
    ? override.join(',')
    : override || setting(
      purpose === 'entry_watch' ? 'entry_watch_ohlcv_provider_order' : 'entry_confirm_ohlcv_provider_order',
      purpose === 'entry_watch' ? 'gmgn,birdeye' : 'birdeye,gmgn',
    );
  const providers = String(raw || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => SUPPORTED_PROVIDERS.has(value));
  return providers.length ? [...new Set(providers)] : ['birdeye'];
}

function insufficientResult({
  mint,
  interval,
  count,
  candles = [],
  fallbackTrace = [],
  errors = [],
  best = null,
} = {}) {
  return {
    ...(best || {}),
    source: 'insufficient',
    endpoint: best?.endpoint || 'entry_candles',
    candles,
    interval,
    count,
    mint,
    fallbackTrace,
    providerErrors: errors,
  };
}

function enough(result, minCandles) {
  return (result?.candles?.length || 0) >= minCandles;
}

export async function fetchEntryCandles(mint, {
  atMs = now(),
  interval = '1m',
  count = 15,
  minCandles = 5,
  purpose = 'entry_confirm',
  providerOrder = null,
} = {}) {
  const order = resolveEntryCandleProviderOrder(purpose, providerOrder);
  const fallbackTrace = [];
  const errors = [];
  let best = null;
  for (const provider of order) {
    try {
      let result;
      if (provider === 'birdeye') {
        result = await fetchBirdeyeEntryCandles(mint, { atMs, interval, count, minCandles });
      } else if (provider === 'gmgn') {
        const multiplier = Math.max(1, Math.trunc(numSetting('gmgn_kline_lookback_multiplier', 3)));
        const fromMs = atMs - (intervalMs(interval) * Math.max(1, Math.trunc(Number(count) || 1)) * multiplier);
        result = await fetchGmgnKline(mint, { atMs, interval, count: count * multiplier, fromMs, toMs: atMs });
      } else {
        continue;
      }
      const providerTrace = result.fallbackTrace || [result.source || provider];
      fallbackTrace.push(...providerTrace.map(step => step.startsWith(provider) ? step : `${provider}:${step}`));
      if (!best || (result.candles?.length || 0) > (best.candles?.length || 0)) best = result;
      if (enough(result, minCandles)) {
        return {
          ...result,
          source: result.source || provider,
          provider,
          fallbackTrace,
          gmgnKlineCount: provider === 'gmgn' ? result.candles?.length || 0 : best?.gmgnKlineCount,
        };
      }
    } catch (err) {
      fallbackTrace.push(`${provider}:error`);
      errors.push({ provider, message: err.message, status: err.status || null, skipReason: err.skipReason || null });
    }
  }
  return insufficientResult({
    mint,
    interval,
    count,
    candles: best?.candles || [],
    fallbackTrace,
    errors,
    best,
  });
}

export async function fetchEntryWatchCandlesWithBudget(mint, {
  watchId = null,
  atMs = now(),
  interval = '1m',
  count = 15,
  minCandles = 5,
  providerOrder = null,
} = {}) {
  const order = resolveEntryCandleProviderOrder('entry_watch', providerOrder);
  const fallbackTrace = [];
  let best = null;
  for (const provider of order) {
    if (provider === 'birdeye') {
      const budget = reserveEntryWatchBirdeyeBudget({ watchId, mint, estimatedCu: 3, atMs });
      if (!budget.ok) {
        return { budgetDeferred: true, budget, best };
      }
    }
    const result = await fetchEntryCandles(mint, {
      atMs,
      interval,
      count,
      minCandles,
      purpose: 'entry_watch',
      providerOrder: [provider],
    });
    fallbackTrace.push(...(result.fallbackTrace || []));
    if (!best || (result.candles?.length || 0) > (best.candles?.length || 0)) best = result;
    if (enough(result, minCandles)) {
      return { ohlcv: { ...result, fallbackTrace }, budgetDeferred: false };
    }
  }
  return {
    ohlcv: {
      ...(best || {}),
      source: 'insufficient',
      candles: best?.candles || [],
      fallbackTrace,
    },
    budgetDeferred: false,
  };
}

function lastClose(candles = []) {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const close = Number(candles[index]?.c);
    if (Number.isFinite(close) && close > 0) return close;
  }
  return null;
}

function sourceConfidence(gmgn, birdeye, { maxDisagreementPct = 20 } = {}) {
  const gmgnClose = lastClose(gmgn?.candles || []);
  const birdeyeClose = lastClose(birdeye?.candles || []);
  if (gmgnClose != null && birdeyeClose != null) {
    const denominator = Math.max(Math.abs(gmgnClose), Math.abs(birdeyeClose));
    const disagreementPct = denominator > 0 ? (Math.abs(gmgnClose - birdeyeClose) / denominator) * 100 : null;
    return {
      confidence: disagreementPct != null && disagreementPct <= maxDisagreementPct ? 'strong' : 'weak',
      gmgnLastClose: gmgnClose,
      birdeyeLastClose: birdeyeClose,
      disagreementPct,
    };
  }
  if (gmgnClose != null || birdeyeClose != null) {
    return {
      confidence: 'medium',
      gmgnLastClose: gmgnClose,
      birdeyeLastClose: birdeyeClose,
      disagreementPct: null,
    };
  }
  return {
    confidence: 'none',
    gmgnLastClose: null,
    birdeyeLastClose: null,
    disagreementPct: null,
  };
}

export async function fetchWatchDipRoutineCandles(mint, {
  atMs = now(),
  interval = '1m',
  count = 15,
  minCandles = 5,
} = {}) {
  return fetchEntryCandles(mint, {
    atMs,
    interval,
    count,
    minCandles,
    purpose: 'entry_watch',
    providerOrder: setting('llm_watch_dip_routine_provider_order', 'gmgn').split(','),
  });
}

export async function fetchWatchDipFinalComposite(mint, {
  watchId = null,
  atMs = now(),
  interval = '1m',
  count = 15,
  minCandles = 5,
  maxDisagreementPct = numSetting('llm_watch_dip_source_agreement_pct', 20),
} = {}) {
  const budget = reserveWatchDipBirdeyeBudget({ watchId, mint, estimatedCu: 3, atMs });
  if (!budget.ok) return { budgetDeferred: true, budget };
  const [gmgn, birdeye] = await Promise.allSettled([
    fetchEntryCandles(mint, {
      atMs,
      interval,
      count,
      minCandles,
      purpose: 'entry_watch',
      providerOrder: ['gmgn'],
    }),
    fetchEntryCandles(mint, {
      atMs,
      interval,
      count,
      minCandles,
      purpose: 'entry_confirm',
      providerOrder: setting('llm_watch_dip_final_provider_order', 'birdeye').split(','),
    }),
  ]);
  const gmgnResult = gmgn.status === 'fulfilled' ? gmgn.value : null;
  const birdeyeResult = birdeye.status === 'fulfilled' ? birdeye.value : null;
  const agreement = sourceConfidence(gmgnResult, birdeyeResult, { maxDisagreementPct });
  const preferred = (birdeyeResult?.candles?.length || 0) >= minCandles ? birdeyeResult : gmgnResult;
  return {
    budgetDeferred: false,
    budget,
    ohlcv: preferred ? {
      ...preferred,
      source: preferred.source || preferred.provider || 'unknown',
      fallbackTrace: [
        ...(gmgnResult?.fallbackTrace || []).map(step => `gmgn:${step}`),
        ...(birdeyeResult?.fallbackTrace || []).map(step => `birdeye:${step}`),
      ],
    } : null,
    gmgn: gmgnResult,
    birdeye: birdeyeResult,
    sourceConfidence: agreement.confidence,
    sourceAgreement: agreement,
    providerErrors: [
      gmgn.status === 'rejected' ? { provider: 'gmgn', message: gmgn.reason?.message || String(gmgn.reason) } : null,
      birdeye.status === 'rejected' ? { provider: 'birdeye', message: birdeye.reason?.message || String(birdeye.reason) } : null,
    ].filter(Boolean),
  };
}

export function gmgnKlineEntryWatchEnabled() {
  return boolSetting('gmgn_kline_enabled', false)
    && resolveEntryCandleProviderOrder('entry_watch').includes('gmgn');
}
