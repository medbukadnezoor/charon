// ---------------------------------------------------------------------------
// Wallet Harvester — Trade Context Enricher (S3)
//
// Enriches each trade with OHLCV price context and technical indicators from
// Birdeye BDS. All indicator computation uses the pure functions in
// indicators.ts. No live API calls are made in the check script — a mock
// fetch can be injected.
// ---------------------------------------------------------------------------

import type pino from "pino";
import type { HarvesterStore } from "./store.js";
import type { TradeContextRecord } from "./types.js";
import { BirdeyeClient } from "./birdeye.js";
import type { BirdeyeFetch } from "./birdeye.js";
import {
  rsi,
  ema,
  vwap,
  bollingerBands,
  atr,
  volumeRatio,
  momentum,
  emaCross,
} from "./indicators.js";
import type { Candle } from "./indicators.js";

// ---------------------------------------------------------------------------
// Config / result types
// ---------------------------------------------------------------------------

export interface TradeContextConfig {
  birdeyeApiKey: string;
  birdeyeBaseUrl?: string;
  birdeyeDailyCuCap?: number;
  /** Use 5m candles for trades within this many days of now; else 1h. Default 7 */
  recentDaysThreshold?: number;
  /** Default 60 candles before trade */
  candlesBefore?: number;
  /** Default 30 candles after trade */
  candlesAfter?: number;
  /** Delay between distinct (mint, timeframe) OHLCV calls in ms. Default 1000 */
  rateLimitMs?: number;
}

export interface TradeContextResult {
  tradesProcessed: number;
  tradesEnriched: number;
  tradesSkipped: number;
  cuConsumed: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TradeWithId {
  id: number;
  mint: string;
  timestamp: number;
  positionId: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CANDLE_SECONDS: Record<string, number> = {
  "5m": 300,
  "1h": 3600,
};

const DEFAULT_RECENT_DAYS = 7;
const DEFAULT_CANDLES_BEFORE = 60;
const DEFAULT_CANDLES_AFTER = 30;
const DEFAULT_RATE_LIMIT_MS = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(r => setTimeout(r, ms));
}

function getTimeframe(tradeTimestamp: number, recentDaysThreshold: number): "5m" | "1h" {
  const cutoff = Math.floor(Date.now() / 1000) - recentDaysThreshold * 86400;
  return tradeTimestamp >= cutoff ? "5m" : "1h";
}

/** Extract candles from Birdeye OHLCV V3 response */
function extractCandles(response: unknown): Candle[] {
  const obj = response as Record<string, unknown>;
  const data = obj.data as Record<string, unknown>;
  const items = (data.items ?? data.ohlcv) as Array<Record<string, unknown>>;

  return items.map(item => ({
    timestamp: (item.unixTime ?? item.unix_time ?? item.time ?? item.timestamp) as number,
    open: (item.open ?? item.o) as number,
    high: (item.high ?? item.h) as number,
    low: (item.low ?? item.l) as number,
    close: (item.close ?? item.c) as number,
    volume: (item.volume ?? item.v) as number,
  }));
}

/** Find the candle whose interval contains the given trade timestamp */
function findCandleForTrade(candles: Candle[], tradeTimestamp: number, candleSeconds: number): number {
  // Candles are sorted ascending by timestamp (interval start).
  // Find the last candle whose timestamp <= tradeTimestamp and next start > tradeTimestamp
  let best = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.timestamp <= tradeTimestamp) {
      // This candle starts at or before the trade — check it covers the trade
      if (tradeTimestamp < c.timestamp + candleSeconds || best === -1) {
        best = i;
      }
    }
  }
  return best;
}

/** Compute all indicators for a window of candles */
function computeIndicators(
  window: Candle[],
  matchedCandle: Candle,
  timeframe: string,
): Omit<TradeContextRecord, "id" | "tradeId" | "positionId" | "mint" | "computedAtMs"> {
  const closes = window.map(c => c.close);
  const volumes = window.map(c => c.volume);
  const windowHigh = Math.max(...window.map(c => c.high));
  const windowLow = Math.min(...window.map(c => c.low));

  const rsi14 = rsi(closes, 14);
  const vwapVal = vwap(window);
  const bb = bollingerBands(closes, 20, 2, matchedCandle.close);
  const volRatio = volumeRatio(volumes, 20);
  const ema9Arr = ema(closes, 9);
  const ema21Arr = ema(closes, 21);
  const ema9Val = ema9Arr.length > 0 ? (ema9Arr[ema9Arr.length - 1] ?? null) : null;
  const ema21Val = ema21Arr.length > 0 ? (ema21Arr[ema21Arr.length - 1] ?? null) : null;
  const emaTrend = emaCross(closes, 9, 21);
  const atr14 = atr(window, 14);
  const mom5 = momentum(closes, 5);
  const mom15 = momentum(closes, 15);
  const mom60 = momentum(closes, 60);

  const distanceFromHighPct =
    windowHigh > 0 ? ((windowHigh - matchedCandle.close) / windowHigh) * 100 : null;
  const distanceFromLowPct =
    windowLow > 0 ? ((matchedCandle.close - windowLow) / windowLow) * 100 : null;

  return {
    candleOpen: matchedCandle.open,
    candleHigh: matchedCandle.high,
    candleLow: matchedCandle.low,
    candleClose: matchedCandle.close,
    candleVolume: matchedCandle.volume,
    rsi14,
    vwap: vwapVal,
    bbUpper: bb?.upper ?? null,
    bbMiddle: bb?.middle ?? null,
    bbLower: bb?.lower ?? null,
    bbPosition: bb?.position ?? null,
    volumeRatio: volRatio,
    ema9: ema9Val,
    ema21: ema21Val,
    emaTrend: emaTrend,
    distanceFromHighPct,
    distanceFromLowPct,
    atr14,
    momentum5: mom5,
    momentum15: mom15,
    momentum60: mom60,
    timeframe,
    candlesUsed: window.length,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function enrichTradeContext(
  cfg: TradeContextConfig,
  store: HarvesterStore,
  logger: pino.Logger,
  fetchFn?: BirdeyeFetch,
): Promise<TradeContextResult> {
  const startMs = Date.now();

  const recentDays = cfg.recentDaysThreshold ?? DEFAULT_RECENT_DAYS;
  const candlesBefore = cfg.candlesBefore ?? DEFAULT_CANDLES_BEFORE;
  const candlesAfter = cfg.candlesAfter ?? DEFAULT_CANDLES_AFTER;
  const rateLimitMs = cfg.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;

  // Build BirdeyeClient
  const client = new BirdeyeClient(
    {
      state: "batch_only",
      apiKey: cfg.birdeyeApiKey,
      baseUrl: cfg.birdeyeBaseUrl,
      dailyComputeUnitCap: cfg.birdeyeDailyCuCap,
    },
    fetchFn ? { fetch: fetchFn } : {},
  );

  // Get all trades without context
  const tradesRaw = store.getTradesWithoutContext() as Array<{
    id?: number;
    mint: string;
    timestamp: number;
  }>;

  // Attach position ID lookup (best-effort: find position with matching trade_id in trade_ids_json)
  // For simplicity we pass null — position linking can be done via post-join
  const trades: TradeWithId[] = tradesRaw
    .filter(t => t.id !== undefined)
    .map(t => ({
      id: t.id as number,
      mint: t.mint,
      timestamp: t.timestamp,
      positionId: null,
    }));

  if (trades.length === 0) {
    logger.info("No trades require context enrichment");
    return { tradesProcessed: 0, tradesEnriched: 0, tradesSkipped: 0, cuConsumed: 0, durationMs: Date.now() - startMs };
  }

  // Group by (mint, timeframe)
  const groups = new Map<string, TradeWithId[]>();
  for (const trade of trades) {
    const tf = getTimeframe(trade.timestamp, recentDays);
    const key = `${trade.mint}::${tf}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(trade);
  }

  // OHLCV cache: key = "mint::timeframe"
  const ohlcvCache = new Map<string, Candle[] | null>();

  let tradesProcessed = 0;
  let tradesEnriched = 0;
  let tradesSkipped = 0;
  let firstCall = true;

  for (const [groupKey, groupTrades] of groups.entries()) {
    const [mint, timeframe] = groupKey.split("::") as [string, string];
    const candleSeconds = CANDLE_SECONDS[timeframe] ?? 3600;

    // Compute time range for this group
    const minTs = Math.min(...groupTrades.map(t => t.timestamp));
    const maxTs = Math.max(...groupTrades.map(t => t.timestamp));
    const timeFrom = minTs - candlesBefore * candleSeconds;
    const timeTo = maxTs + candlesAfter * candleSeconds;

    // Fetch OHLCV (with rate limiting)
    if (!ohlcvCache.has(groupKey)) {
      if (!firstCall) {
        await sleep(rateLimitMs);
      }
      firstCall = false;

      try {
        const response = await client.getOhlcvV3({
          address: mint,
          type: timeframe,
          timeFrom,
          timeTo,
        });
        const candles = extractCandles(response);
        // Sort ascending
        candles.sort((a, b) => a.timestamp - b.timestamp);
        ohlcvCache.set(groupKey, candles.length > 0 ? candles : null);
        logger.debug(
          { mint: mint.slice(0, 12), timeframe, candles: candles.length },
          "OHLCV fetched",
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // 429 or any HTTP error
        if (errMsg.includes("429") || errMsg.includes("http_error") || errMsg.includes("rate")) {
          logger.warn({ mint: mint.slice(0, 12), timeframe, err: errMsg }, "429/rate-limit — skipping mint");
        } else {
          logger.warn({ mint: mint.slice(0, 12), timeframe, err: errMsg }, "OHLCV fetch failed — skipping mint");
        }
        ohlcvCache.set(groupKey, null);
      }
    }

    const candles = ohlcvCache.get(groupKey) ?? null;

    for (const trade of groupTrades) {
      tradesProcessed++;

      if (!candles || candles.length === 0) {
        tradesSkipped++;
        logger.debug({ tradeId: trade.id, mint: mint.slice(0, 12) }, "no OHLCV data — skipping trade");
        continue;
      }

      // Find matching candle
      const candleIdx = findCandleForTrade(candles, trade.timestamp, candleSeconds);
      if (candleIdx === -1) {
        tradesSkipped++;
        logger.debug({ tradeId: trade.id, mint: mint.slice(0, 12) }, "no matching candle — skipping trade");
        continue;
      }

      // Build window: up to candlesBefore candles ending at candleIdx
      const windowStart = Math.max(0, candleIdx - candlesBefore + 1);
      const window = candles.slice(windowStart, candleIdx + 1);

      if (window.length === 0) {
        tradesSkipped++;
        continue;
      }

      const matchedCandle = candles[candleIdx]!;
      const indicators = computeIndicators(window, matchedCandle, timeframe);

      const record: TradeContextRecord = {
        tradeId: trade.id,
        positionId: trade.positionId,
        mint,
        ...indicators,
        computedAtMs: Date.now(),
      };

      store.upsertTradeContext(record);
      tradesEnriched++;
    }
  }

  const usage = client.usageSummary();

  return {
    tradesProcessed,
    tradesEnriched,
    tradesSkipped,
    cuConsumed: usage.computeUnitsConsumed,
    durationMs: Date.now() - startMs,
  };
}
