// ---------------------------------------------------------------------------
// Wallet Harvester — Pure Technical Indicator Functions (S3)
//
// No external dependencies. All functions are pure (no side effects).
// ---------------------------------------------------------------------------

export interface Candle {
  timestamp: number;  // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------------------------------------------------------------------
// RSI — Wilder's Smoothed RSI
// ---------------------------------------------------------------------------

/**
 * Wilder's RSI.
 * Returns null if closes.length < period + 1.
 */
export function rsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  // Compute deltas
  const deltas: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    deltas.push(closes[i]! - closes[i - 1]!);
  }

  // Initial average gain/loss over the first `period` deltas
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    const d = deltas[i]!;
    if (d > 0) avgGain += d;
    else avgLoss += -d;
  }
  avgGain /= period;
  avgLoss /= period;

  // Wilder's smoothing for subsequent deltas
  for (let i = period; i < deltas.length; i++) {
    const d = deltas[i]!;
    const gain = d > 0 ? d : 0;
    const loss = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ---------------------------------------------------------------------------
// EMA — Simple Exponential Moving Average
// ---------------------------------------------------------------------------

/**
 * Returns EMA array of same length as values.
 * Uses SMA of first `period` values as seed.
 * Values before the first full period are filled with the SMA seed.
 */
export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  if (period <= 0) return [...values];

  const result: number[] = new Array(values.length) as number[];
  const k = 2 / (period + 1);

  // Seed: SMA of first `period` values (or all if shorter)
  const seedLen = Math.min(period, values.length);
  let sum = 0;
  for (let i = 0; i < seedLen; i++) sum += values[i]!;
  const seed = sum / seedLen;

  // Fill pre-period with seed
  for (let i = 0; i < seedLen; i++) result[i] = seed;

  // EMA from period onwards
  let prev = seed;
  for (let i = seedLen; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    result[i] = prev;
  }

  return result;
}

// ---------------------------------------------------------------------------
// VWAP
// ---------------------------------------------------------------------------

/**
 * VWAP over all provided candles.
 * Typical price = (high + low + close) / 3.
 * Returns null if no candles or total volume is 0.
 */
export function vwap(candles: Candle[]): number | null {
  if (candles.length === 0) return null;
  let numerator = 0;
  let denominator = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    numerator += typicalPrice * c.volume;
    denominator += c.volume;
  }
  if (denominator === 0) return null;
  return numerator / denominator;
}

// ---------------------------------------------------------------------------
// Bollinger Bands
// ---------------------------------------------------------------------------

/**
 * Bollinger Bands using the last `period` values of closes.
 * middle = SMA(period)
 * upper  = middle + multiplier * stddev
 * lower  = middle - multiplier * stddev
 * position: 0.0 = at lower band, 1.0 = at upper band (clamped to [0,1] if bands are flat)
 * Returns null if closes.length < period.
 */
export function bollingerBands(
  closes: number[],
  period: number,
  multiplier: number,
  currentPrice: number,
): { upper: number; middle: number; lower: number; position: number } | null {
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  let sum = 0;
  for (const v of window) sum += v;
  const middle = sum / period;

  let variance = 0;
  for (const v of window) variance += (v - middle) ** 2;
  const stddev = Math.sqrt(variance / period);

  const upper = middle + multiplier * stddev;
  const lower = middle - multiplier * stddev;

  const bandwidth = upper - lower;
  let position: number;
  if (bandwidth === 0) {
    position = 0.5;
  } else {
    position = (currentPrice - lower) / bandwidth;
  }

  return { upper, middle, lower, position };
}

// ---------------------------------------------------------------------------
// ATR — Average True Range
// ---------------------------------------------------------------------------

/**
 * ATR(period) using Wilder's smoothing.
 * Returns null if candles.length < period + 1.
 */
export function atr(candles: Candle[], period: number): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i]!;
    const prev = candles[i - 1]!;
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  // Initial ATR = simple average of first `period` TR values
  let atrVal = 0;
  for (let i = 0; i < period; i++) atrVal += trueRanges[i]!;
  atrVal /= period;

  // Wilder's smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]!) / period;
  }

  return atrVal;
}

// ---------------------------------------------------------------------------
// Volume Ratio
// ---------------------------------------------------------------------------

/**
 * Current candle volume / average(last N candles volume).
 * "Current" = last element of volumes, "last N" includes the current.
 * Returns null if volumes.length < period.
 */
export function volumeRatio(volumes: number[], period: number): number | null {
  if (volumes.length < period) return null;

  const window = volumes.slice(-period);
  let sum = 0;
  for (const v of window) sum += v;
  const avg = sum / period;

  if (avg === 0) return null;

  const current = window[window.length - 1]!;
  return current / avg;
}

// ---------------------------------------------------------------------------
// Momentum
// ---------------------------------------------------------------------------

/**
 * % change from closes[closes.length - 1 - periods] to closes[closes.length - 1].
 * Returns null if not enough data.
 */
export function momentum(closes: number[], periods: number): number | null {
  if (closes.length < periods + 1) return null;

  const current = closes[closes.length - 1]!;
  const past = closes[closes.length - 1 - periods]!;

  if (past === 0) return null;
  return ((current - past) / past) * 100;
}

// ---------------------------------------------------------------------------
// EMA Cross
// ---------------------------------------------------------------------------

/**
 * Returns 'bullish' | 'bearish' | 'crossing' based on fast vs slow EMA at
 * the last two candles.
 * Returns null if not enough data for the slow EMA.
 */
export function emaCross(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
): "bullish" | "bearish" | "crossing" | null {
  if (closes.length < slowPeriod) return null;

  const fastEmaArr = ema(closes, fastPeriod);
  const slowEmaArr = ema(closes, slowPeriod);

  const lastIdx = closes.length - 1;
  const prevIdx = lastIdx - 1;

  const fastLast = fastEmaArr[lastIdx]!;
  const slowLast = slowEmaArr[lastIdx]!;

  // Detect crossing using previous bar relationship
  if (prevIdx >= 0) {
    const fastPrev = fastEmaArr[prevIdx]!;
    const slowPrev = slowEmaArr[prevIdx]!;

    const wasBullish = fastPrev > slowPrev;
    const isBullish = fastLast > slowLast;

    if (wasBullish !== isBullish) return "crossing";
  }

  if (fastLast > slowLast) return "bullish";
  if (fastLast < slowLast) return "bearish";
  return "crossing";
}
