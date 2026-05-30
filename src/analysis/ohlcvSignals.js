function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value) {
  const parsed = finiteNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function emptySignals(status = 'unsupported') {
  return {
    staircase_without_pullback_n: null,
    staircase_warning: null,
    three_candle_dip_confirmed: null,
    ath_high: null,
    ath_distance_pct: null,
    in_fib_618_zone: null,
    ohlcv_coverage_status: status,
  };
}

function isFinalized(row) {
  return row?.ohlcv_finalized === true
    || row?.ohlcv_finalized === 1
    || row?.ohlcv_finalized === '1'
    || row?.ohlcv_finalized === 'true';
}

function candleColor(row) {
  const open = finiteNumber(row.ohlcv_open);
  const close = finiteNumber(row.ohlcv_close);
  if (open == null || close == null) return null;
  if (close > open) return 'green';
  if (close < open) return 'red';
  return 'flat';
}

function normalizeRows(observations, asOfMs) {
  const cutoff = finiteInteger(asOfMs);
  return (Array.isArray(observations) ? observations : [])
    .filter(row => {
      if (cutoff == null) return true;
      const observedAt = finiteInteger(row?.observed_at_ms);
      return observedAt != null && observedAt <= cutoff;
    })
    .filter(isFinalized)
    .map(row => ({
      ...row,
      observed_at_ms: finiteInteger(row.observed_at_ms),
      ohlcv_open: finiteNumber(row.ohlcv_open),
      ohlcv_high: finiteNumber(row.ohlcv_high),
      ohlcv_low: finiteNumber(row.ohlcv_low),
      ohlcv_close: finiteNumber(row.ohlcv_close),
    }))
    .filter(row => row.ohlcv_open != null && row.ohlcv_high != null && row.ohlcv_low != null && row.ohlcv_close != null)
    .sort((a, b) => (Number(a.observed_at_ms || 0) - Number(b.observed_at_ms || 0)));
}

function coverageStatus(count) {
  if (count >= 10) return 'ok';
  if (count >= 3) return 'sparse';
  return 'unsupported';
}

function trailingStaircaseCount(rows, pullbackThresholdPct) {
  let count = 0;
  let runningHigh = null;

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (candleColor(row) !== 'green') break;
    const high = finiteNumber(row.ohlcv_high);
    const low = finiteNumber(row.ohlcv_low);
    if (high == null || low == null) break;
    runningHigh = runningHigh == null ? high : Math.max(runningHigh, high);
    if (runningHigh > 0) {
      const pullbackPct = ((runningHigh - low) / runningHigh) * 100;
      if (pullbackPct >= pullbackThresholdPct) break;
    }
    count += 1;
  }

  return count;
}

export function computeOhlcvSignals(observations, {
  asOfMs = null,
  pullbackThresholdPct = 2,
  staircaseWarningThreshold = 5,
} = {}) {
  const rows = normalizeRows(observations, asOfMs);
  const status = coverageStatus(rows.length);
  if (rows.length < 3) return emptySignals(status);

  const latest = rows.at(-1);
  const athHigh = Math.max(...rows.map(row => row.ohlcv_high).filter(value => value != null));
  const latestClose = latest?.ohlcv_close ?? null;
  const athDistancePct = athHigh > 0 && latestClose != null
    ? ((latestClose - athHigh) / athHigh) * 100
    : null;
  const colors = rows.slice(-4).map(candleColor);
  const threeCandleDipConfirmed = colors.length === 4
    && colors[0] === 'red'
    && colors[1] === 'red'
    && colors[2] === 'red'
    && colors[3] === 'green';
  const staircaseCount = trailingStaircaseCount(rows, pullbackThresholdPct);

  return {
    staircase_without_pullback_n: staircaseCount,
    staircase_warning: staircaseCount >= staircaseWarningThreshold,
    three_candle_dip_confirmed: threeCandleDipConfirmed,
    ath_high: Number.isFinite(athHigh) ? athHigh : null,
    ath_distance_pct: athDistancePct,
    in_fib_618_zone: athDistancePct != null && athDistancePct >= -61.8 && athDistancePct <= -50,
    ohlcv_coverage_status: status,
  };
}

// --- Helper functions for entry/cutoff signals ---

function computeRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function computeVwapPosition(candles) {
  let cumVol = 0, cumVolPrice = 0;
  for (const c of candles) {
    if (!Number.isFinite(c.v) || !Number.isFinite(c.c)) continue;
    const typical = (c.h + c.l + c.c) / 3;
    cumVol += c.v;
    cumVolPrice += typical * c.v;
  }
  if (cumVol === 0) return 'unknown';
  const vwap = cumVolPrice / cumVol;
  const lastClose = candles[candles.length - 1]?.c;
  if (!Number.isFinite(lastClose) || !Number.isFinite(vwap) || vwap === 0) return 'unknown';
  const pctAbove = ((lastClose - vwap) / vwap) * 100;
  if (pctAbove > 15) return 'far_above';
  if (pctAbove > 5) return 'above';
  if (pctAbove >= -5) return 'at';
  return 'below';
}

function computeVolumeTrend(volumes) {
  if (volumes.length < 6) return 'unknown';
  const recent = volumes.slice(-3);
  const prior = volumes.slice(-6, -3);
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const priorAvg = prior.reduce((a, b) => a + b, 0) / prior.length;
  if (priorAvg === 0) return 'unknown';
  const ratio = recentAvg / priorAvg;
  // Exhaustion spike: last candle volume > 3x average
  const lastVol = volumes[volumes.length - 1];
  const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
  if (lastVol > avgVol * 3) return 'exhaustion_spike';
  if (ratio > 1.3) return 'increasing';
  if (ratio < 0.7) return 'declining';
  return 'stable';
}

function analyzeCandleStructure(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return 'unknown';
  let upperWickCount = 0, strongGreenCount = 0, dojiCount = 0, lowerWickCount = 0;
  for (const c of candles) {
    if (!Number.isFinite(c.o) || !Number.isFinite(c.h) || !Number.isFinite(c.l) || !Number.isFinite(c.c)) continue;
    const body = Math.abs(c.c - c.o);
    const range = c.h - c.l;
    if (range === 0) { dojiCount++; continue; }
    const upperWick = c.h - Math.max(c.o, c.c);
    const lowerWick = Math.min(c.o, c.c) - c.l;
    if (upperWick / range > 0.5) upperWickCount++;
    else if (lowerWick / range > 0.5) lowerWickCount++;
    else if (c.c > c.o && body / range > 0.6) strongGreenCount++;
    else if (body / range < 0.2) dojiCount++;
  }
  if (upperWickCount >= candles.length * 0.6) return 'upper_wicks';
  if (lowerWickCount >= candles.length * 0.6) return 'lower_wicks';
  if (strongGreenCount >= candles.length * 0.6) return 'strong_green';
  if (dojiCount >= candles.length * 0.5) return 'doji';
  return 'mixed';
}

// --- Entry confirmation signals ---

/**
 * Compute entry confirmation signals from raw OHLCV candles.
 * @param {Array} candles - Birdeye OHLCV candles [{o, h, l, c, v, unixTime}]
 * @param {Object} opts - { rsiPeriod: 14, vwapLookback: 15 }
 * @returns {{ confirm: boolean, reject_reason: string|null, rsi: number|null, vwap_position: string, volume_trend: string, candle_structure: string, score: number }}
 */
export function computeEntrySignals(candles, { rsiPeriod = 14, vwapLookback = 15 } = {}) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return { confirm: false, reject_reason: 'insufficient_candles', rsi: null, vwap_position: 'unknown', volume_trend: 'unknown', candle_structure: 'unknown', score: 0 };
  }

  const closes = candles.map(c => c.c).filter(v => Number.isFinite(v));
  const volumes = candles.map(c => c.v).filter(v => Number.isFinite(v));
  const highs = candles.map(c => c.h).filter(v => Number.isFinite(v));
  const lows = candles.map(c => c.l).filter(v => Number.isFinite(v));

  if (closes.length < 5) return { confirm: false, reject_reason: 'insufficient_valid_data', rsi: null, vwap_position: 'unknown', volume_trend: 'unknown', candle_structure: 'unknown', score: 0 };

  // RSI calculation
  const rsi = computeRsi(closes, rsiPeriod);

  // VWAP position (price relative to volume-weighted average)
  const vwapPosition = computeVwapPosition(candles);

  // Volume trend (last 5 candles vs prior 5)
  const volumeTrend = computeVolumeTrend(volumes);

  // Candle structure (last 3 candles)
  const candleStructure = analyzeCandleStructure(candles.slice(-3));

  // Scoring: each factor contributes to entry confidence
  let score = 50; // neutral baseline
  let rejectReason = null;

  // RSI scoring
  if (rsi !== null) {
    if (rsi > 75) { score -= 30; rejectReason = 'rsi_overbought'; }
    else if (rsi > 65) { score -= 15; }
    else if (rsi >= 40 && rsi <= 60) { score += 10; }
    else if (rsi < 30) { score += 15; } // oversold = potential reversal
  }

  // VWAP scoring
  if (vwapPosition === 'far_above') { score -= 20; if (!rejectReason) rejectReason = 'extended_above_vwap'; }
  else if (vwapPosition === 'above') { score -= 5; }
  else if (vwapPosition === 'at') { score += 10; }
  else if (vwapPosition === 'below') { score += 5; }

  // Volume scoring
  if (volumeTrend === 'increasing') { score += 10; }
  else if (volumeTrend === 'exhaustion_spike') { score -= 15; if (!rejectReason) rejectReason = 'volume_exhaustion'; }
  else if (volumeTrend === 'declining') { score -= 5; }

  // Candle structure scoring
  if (candleStructure === 'upper_wicks') { score -= 20; if (!rejectReason) rejectReason = 'rejection_wicks'; }
  else if (candleStructure === 'strong_green') { score += 10; }
  else if (candleStructure === 'doji') { score -= 5; }

  const confirm = score >= 45 && !rejectReason;

  return { confirm, reject_reason: rejectReason, rsi, vwap_position: vwapPosition, volume_trend: volumeTrend, candle_structure: candleStructure, score };
}

export function computeStrictEntryShadowPolicy(entrySignals = {}, {
  minScore = 60,
  minCandles = 15,
  rejectRsiUnavailable = true,
  maxRsi = 70,
  maxMcapDisagreementPercent = 100,
  mcapDisagreementPercent = null,
} = {}) {
  const reasons = [];
  const score = Number(entrySignals.score ?? 0);
  const candleCount = Number(entrySignals.candle_count ?? 0);
  const rsi = entrySignals.rsi == null ? null : Number(entrySignals.rsi);
  const disagreement = mcapDisagreementPercent == null ? null : Number(mcapDisagreementPercent);

  if (score < Number(minScore)) reasons.push('strict_score_low');
  if (candleCount < Number(minCandles)) reasons.push('strict_insufficient_candles');
  if (rejectRsiUnavailable && !Number.isFinite(rsi)) reasons.push('strict_rsi_unavailable');
  if (Number.isFinite(rsi) && rsi > Number(maxRsi)) reasons.push('strict_rsi_overbought');
  if (Number.isFinite(disagreement) && disagreement > Number(maxMcapDisagreementPercent)) {
    reasons.push('strict_mcap_disagreement');
  }

  return {
    pass: reasons.length === 0,
    reasons,
    thresholds: {
      minScore: Number(minScore),
      minCandles: Number(minCandles),
      rejectRsiUnavailable: Boolean(rejectRsiUnavailable),
      maxRsi: Number(maxRsi),
      maxMcapDisagreementPercent: Number(maxMcapDisagreementPercent),
    },
    observed: {
      score,
      candleCount,
      rsi: Number.isFinite(rsi) ? rsi : null,
      vwapPosition: entrySignals.vwap_position || 'unknown',
      volumeTrend: entrySignals.volume_trend || 'unknown',
      candleStructure: entrySignals.candle_structure || 'unknown',
      candleSource: entrySignals.candle_source || 'unknown',
      mcapDisagreementPercent: Number.isFinite(disagreement) ? disagreement : null,
      originalConfirm: Boolean(entrySignals.confirm),
      originalRejectReason: entrySignals.reject_reason || null,
    },
  };
}

export function isWatchableEntryReject(entrySignals, {
  minEntryScore = 45,
  scoreSlack = 10,
} = {}) {
  if (!entrySignals || entrySignals.confirm) return false;
  const reason = entrySignals.reject_reason || null;
  const watchableReasons = new Set([
    'rsi_overbought',
    'extended_above_vwap',
    'volume_exhaustion',
    'rejection_wicks',
  ]);
  if (watchableReasons.has(reason)) return true;
  if (reason === null && Number(entrySignals.score) >= Number(minEntryScore) - Number(scoreSlack)) return true;
  return false;
}

// --- Soft-cutoff signals ---

/**
 * Compute soft-cutoff signals for position hold/cut decision.
 * @param {Array} candles - Birdeye OHLCV 5m candles [{o, h, l, c, v, unixTime}]
 * @param {Object} opts - { entryMcap, currentMcap, highWaterMcap }
 * @returns {{ recommendation: 'hold'|'cut'|'tighten', rsi: number|null, momentum: number|null, volume_trend: string, structure: string, distance_from_hwm_pct: number|null }}
 */
export function computeCutoffSignals(candles, { entryMcap = 0, currentMcap = 0, highWaterMcap = 0 } = {}) {
  if (!Array.isArray(candles) || candles.length < 5) {
    return { recommendation: 'cut', rsi: null, momentum: null, volume_trend: 'unknown', structure: 'unknown', distance_from_hwm_pct: null };
  }

  const closes = candles.map(c => c.c).filter(v => Number.isFinite(v));
  const volumes = candles.map(c => c.v).filter(v => Number.isFinite(v));

  if (closes.length < 5) return { recommendation: 'cut', rsi: null, momentum: null, volume_trend: 'unknown', structure: 'unknown', distance_from_hwm_pct: null };

  const rsi = computeRsi(closes, 14);
  const volumeTrend = computeVolumeTrend(volumes);
  const structure = analyzeCandleStructure(candles.slice(-5));
  const distanceFromHwm = highWaterMcap > 0 ? ((currentMcap - highWaterMcap) / highWaterMcap) * 100 : null;

  // Momentum: rate of change over last 5 candles
  const momentum = closes.length >= 5 ? (closes[closes.length - 1] / closes[closes.length - 5] - 1) : null;

  // Decision logic
  let holdScore = 0;

  // RSI
  if (rsi !== null) {
    if (rsi >= 50) holdScore += 1;
    if (rsi >= 60) holdScore += 1;
    if (rsi < 35) holdScore -= 2;
  }

  // Momentum
  if (momentum !== null) {
    if (momentum > 0.05) holdScore += 2;
    else if (momentum > 0) holdScore += 1;
    else if (momentum < -0.1) holdScore -= 2;
    else if (momentum < 0) holdScore -= 1;
  }

  // Volume
  if (volumeTrend === 'increasing') holdScore += 1;
  else if (volumeTrend === 'declining') holdScore -= 1;
  else if (volumeTrend === 'exhaustion_spike') holdScore -= 1;

  // Structure
  if (structure === 'strong_green') holdScore += 1;
  else if (structure === 'upper_wicks') holdScore -= 2;
  else if (structure === 'lower_wicks') holdScore += 1; // buying pressure

  // Distance from HWM
  if (distanceFromHwm !== null) {
    if (distanceFromHwm < -40) holdScore -= 2;
    else if (distanceFromHwm < -20) holdScore -= 1;
  }

  let recommendation;
  if (holdScore >= 2) recommendation = 'hold';
  else if (holdScore <= -2) recommendation = 'cut';
  else recommendation = 'tighten';

  return { recommendation, rsi, momentum, volume_trend: volumeTrend, structure, distance_from_hwm_pct: distanceFromHwm };
}

export const OHLCV_SIGNAL_DEFAULTS = emptySignals();

export const ENTRY_SIGNAL_DEFAULTS = { confirm: false, reject_reason: null, rsi: null, vwap_position: 'unknown', volume_trend: 'unknown', candle_structure: 'unknown', score: 0 };
export const CUTOFF_SIGNAL_DEFAULTS = { recommendation: 'cut', rsi: null, momentum: null, volume_trend: 'unknown', structure: 'unknown', distance_from_hwm_pct: null };
