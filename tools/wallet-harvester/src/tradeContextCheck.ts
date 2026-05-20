// ---------------------------------------------------------------------------
// Wallet Harvester — Trade Context Check (zero live calls)
//
// Usage:
//   npm run harvest:context-check
//
// Validates all core behaviours of indicators.ts and tradeContext.ts using
// an in-memory SQLite DB and a mock fetch function. No Birdeye API calls.
// ---------------------------------------------------------------------------

import pino from "pino";
import { HarvesterStore } from "./store.js";
import { enrichTradeContext } from "./tradeContext.js";
import type { TradeContextConfig } from "./tradeContext.js";
import type { TradeRecord } from "./types.js";
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
// Assertion helpers
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertClose(a: number, b: number, tol: number, message: string): void {
  if (Math.abs(a - b) > tol) {
    throw new Error(`ASSERTION FAILED: ${message} (got ${a}, expected ~${b}, tol ${tol})`);
  }
}

function assertNotNull<T>(v: T | null | undefined, message: string): T {
  if (v === null || v === undefined) throw new Error(`ASSERTION FAILED: ${message} was null/undefined`);
  return v;
}

// ---------------------------------------------------------------------------
// Constants / fixtures
// ---------------------------------------------------------------------------

const MOCK_BASE_URL = "https://mock.birdeye.test";
const MINT_A = "MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_B = "MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const WALLET_A = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const logger = pino({ level: "silent" });

// Base config shared by all pipeline tests
const BASE_CONTEXT_CFG: TradeContextConfig = {
  birdeyeApiKey: "test-api-key",
  birdeyeBaseUrl: MOCK_BASE_URL,
  birdeyeDailyCuCap: 100_000,
  recentDaysThreshold: 7,
  candlesBefore: 60,
  candlesAfter: 30,
  rateLimitMs: 0,
};

// RSI test sequence (classic Wilder's example)
const RSI_CLOSES = [44, 47, 43, 44, 46, 44, 46, 48, 47, 49, 51, 50, 52, 54, 53, 56, 55, 57, 59, 58];

// ---------------------------------------------------------------------------
// Candle fixture builder
// ---------------------------------------------------------------------------

function buildCandleFixture(
  count: number,
  startUnix = 1_700_000_000,
  intervalSec = 300,
  baseClose = 0.01,
): Candle[] {
  const candles: Candle[] = [];
  let close = baseClose;
  for (let i = 0; i < count; i++) {
    close = close * (1 + (Math.sin(i * 0.3) * 0.01));
    const high = close * 1.005;
    const low = close * 0.995;
    candles.push({
      timestamp: startUnix + i * intervalSec,
      open: close * 0.999,
      high,
      low,
      close,
      volume: 1000 + i * 10,
    });
  }
  return candles;
}

function buildBirdeyeResponse(candles: Candle[]): unknown {
  return {
    success: true,
    data: {
      items: candles.map(c => ({
        unixTime: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// Store factory — in-memory DB
// ---------------------------------------------------------------------------

let tradeCounter = 0;

function makeStore(): HarvesterStore {
  return new HarvesterStore(":memory:");
}

function seedTrade(
  store: HarvesterStore,
  overrides: { walletAddress: string; mint: string; side: "buy" | "sell"; timestamp: number },
): void {
  tradeCounter++;
  store.upsertTrade({
    walletAddress: overrides.walletAddress,
    signature: `sig${tradeCounter.toString().padStart(8, "0")}`,
    mint: overrides.mint,
    side: overrides.side,
    tokenAmount: 1_000_000,
    solAmount: 0.5,
    usdAmount: null,
    priceUsd: null,
    priceSol: 0.0000005,
    timestamp: overrides.timestamp,
    program: "test",
    slot: tradeCounter,
    rawJson: null,
    collectedAtMs: Date.now(),
  } as TradeRecord);
}

// ---------------------------------------------------------------------------
// Test 1: RSI basic — known sequence should yield ≈67-70
// ---------------------------------------------------------------------------

async function test1_rsiBasic(): Promise<void> {
  const result = rsi(RSI_CLOSES, 14);
  const val = assertNotNull(result, "RSI result");
  assert(val >= 67 && val <= 72, `test1: RSI should be in [67,72], got ${val}`);
}

// ---------------------------------------------------------------------------
// Test 2: RSI null on short series
// ---------------------------------------------------------------------------

async function test2_rsiNullOnShortSeries(): Promise<void> {
  const result = rsi([100, 101, 102, 103], 14);
  assert(result === null, `test2: RSI should be null for closes.length < 15, got ${String(result)}`);
}

// ---------------------------------------------------------------------------
// Test 3: EMA convergence — constant input → all EMA values equal constant
// ---------------------------------------------------------------------------

async function test3_emaConvergence(): Promise<void> {
  const constant = 100.0;
  const input = new Array(50).fill(constant) as number[];
  const result = ema(input, 20);
  assert(result.length === 50, `test3: EMA length should be 50, got ${result.length}`);
  for (let i = 0; i < result.length; i++) {
    assertClose(result[i]!, constant, 0.0001, `test3: EMA[${i}]`);
  }
}

// ---------------------------------------------------------------------------
// Test 4: Bollinger Bands — constant close → stddev=0, upper=middle=lower
// ---------------------------------------------------------------------------

async function test4_bollingerBandsFlat(): Promise<void> {
  const closes = new Array(25).fill(50.0) as number[];
  const result = bollingerBands(closes, 20, 2, 50.0);
  const bb = assertNotNull(result, "Bollinger bands result");
  assertClose(bb.upper, 50.0, 0.0001, "test4: upper");
  assertClose(bb.middle, 50.0, 0.0001, "test4: middle");
  assertClose(bb.lower, 50.0, 0.0001, "test4: lower");
  assertClose(bb.position, 0.5, 0.0001, "test4: position");
}

// ---------------------------------------------------------------------------
// Test 5: VWAP — 3 known candles, manual calculation
// ---------------------------------------------------------------------------

async function test5_vwap(): Promise<void> {
  const candles: Candle[] = [
    { timestamp: 1, open: 10, high: 12, low: 8,  close: 11, volume: 100 },
    { timestamp: 2, open: 11, high: 13, low: 9,  close: 12, volume: 200 },
    { timestamp: 3, open: 12, high: 14, low: 10, close: 13, volume: 150 },
  ];
  // tp1 = (12+8+11)/3 = 10.333, tp2 = (13+9+12)/3 = 11.333, tp3 = (14+10+13)/3 = 12.333
  // vwap = (10.333*100 + 11.333*200 + 12.333*150) / (100+200+150)
  //       = (1033.33 + 2266.67 + 1850) / 450 = 5150 / 450 ≈ 11.444
  const expected = (10.333 * 100 + 11.333 * 200 + 12.333 * 150) / 450;
  const result = vwap(candles);
  const val = assertNotNull(result, "VWAP result");
  assertClose(val, expected, 0.001, "test5: VWAP");
}

// ---------------------------------------------------------------------------
// Test 6: ATR basic — known candle sequence, ATR(3) within tolerance
// ---------------------------------------------------------------------------

async function test6_atrBasic(): Promise<void> {
  // Candles: close sequence rising, known TR values
  const candles: Candle[] = [
    { timestamp: 0, open: 10, high: 11, low: 9,  close: 10, volume: 100 },
    { timestamp: 1, open: 10, high: 12, low: 9,  close: 11, volume: 100 },
    { timestamp: 2, open: 11, high: 13, low: 10, close: 12, volume: 100 },
    { timestamp: 3, open: 12, high: 14, low: 11, close: 13, volume: 100 },
  ];
  // TR[1] = max(12-9, |12-10|, |9-10|) = max(3, 2, 1) = 3
  // TR[2] = max(13-10, |13-11|, |10-11|) = max(3, 2, 1) = 3
  // TR[3] = max(14-11, |14-12|, |11-12|) = max(3, 2, 1) = 3
  // ATR(3) seed = (3+3+3)/3 = 3.0
  const result = atr(candles, 3);
  const val = assertNotNull(result, "ATR result");
  assertClose(val, 3.0, 0.001, "test6: ATR(3)");
}

// ---------------------------------------------------------------------------
// Test 7: Volume ratio — last vol=200, prev 19 all=100 → ratio≈2.0
// ---------------------------------------------------------------------------

async function test7_volumeRatio(): Promise<void> {
  const volumes = [...new Array(19).fill(100) as number[], 200];
  const result = volumeRatio(volumes, 20);
  const val = assertNotNull(result, "Volume ratio result");
  // avg of window = (19*100 + 200) / 20 = 2100/20 = 105
  // current = 200
  // ratio = 200/105 ≈ 1.905
  assertClose(val, 200 / 105, 0.001, "test7: volume ratio");
}

// ---------------------------------------------------------------------------
// Test 8: Momentum — closes=[100,110,121,133.1] → momentum(closes,3) ≈ 33.1%
// ---------------------------------------------------------------------------

async function test8_momentum(): Promise<void> {
  const closes = [100, 110, 121, 133.1];
  const result = momentum(closes, 3);
  const val = assertNotNull(result, "Momentum result");
  // (133.1 - 100) / 100 * 100 = 33.1
  assertClose(val, 33.1, 0.01, "test8: momentum(3)");
}

// ---------------------------------------------------------------------------
// Test 9: EMA cross bullish — trending up sequence → fast EMA > slow EMA
// ---------------------------------------------------------------------------

async function test9_emaCrossBullish(): Promise<void> {
  // Build a strongly trending up series of 50 values
  const closes: number[] = [];
  for (let i = 0; i < 50; i++) closes.push(100 + i * 2);

  const result = emaCross(closes, 9, 21);
  assert(result === "bullish" || result === "crossing", `test9: expected bullish/crossing for uptrend, got ${String(result)}`);

  // Verify that fast EMA > slow EMA in a clear uptrend
  const fastArr = ema(closes, 9);
  const slowArr = ema(closes, 21);
  const fastLast = fastArr[fastArr.length - 1]!;
  const slowLast = slowArr[slowArr.length - 1]!;
  assert(fastLast > slowLast, `test9: fast EMA ${fastLast} should be > slow EMA ${slowLast}`);
}

// ---------------------------------------------------------------------------
// Test 10: Full enrichment pipeline — 2 trades, mock fetch, verify DB rows
// ---------------------------------------------------------------------------

async function test10_fullEnrichmentPipeline(): Promise<void> {
  const store = makeStore();

  // Candle fixture: 120 candles at 5m intervals
  // Place trades within the last 7 days (recentDaysThreshold) so they get
  // timeframe='5m'. Also place them >= 20 candles into the range so the
  // window has enough history for RSI(14) to be non-null.
  const nowSec = Math.floor(Date.now() / 1000);
  // Start candles 2 days ago to ensure coverage
  const candleStart = nowSec - 2 * 86400;
  const candles = buildCandleFixture(120, candleStart, 300);

  // Trade 1: 25 candles into the range
  const ts1 = candleStart + 25 * 300;
  // Trade 2: 70 candles into the range
  const ts2 = candleStart + 70 * 300;

  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_A, side: "buy", timestamp: ts1 });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_A, side: "sell", timestamp: ts2 });

  assert(store.getTradeCount() === 2, `test10: should have 2 trades, got ${store.getTradeCount()}`);
  assert(store.getTradesWithoutContext().length === 2, `test10: both trades should lack context`);

  const birdeyeResponse = buildBirdeyeResponse(candles);

  // Mock fetch: return candle fixture for any call to the mock base URL
  const mockFetch = async (_url: string, _init: RequestInit): Promise<Response> => {
    return {
      ok: true,
      status: 200,
      json: async () => birdeyeResponse,
    } as unknown as Response;
  };

  const result = await enrichTradeContext(BASE_CONTEXT_CFG, store, logger, mockFetch);

  assert(result.tradesProcessed === 2, `test10: tradesProcessed should be 2, got ${result.tradesProcessed}`);
  assert(result.tradesEnriched === 2, `test10: tradesEnriched should be 2, got ${result.tradesEnriched}`);
  assert(result.tradesSkipped === 0, `test10: tradesSkipped should be 0, got ${result.tradesSkipped}`);

  assert(store.getTradeContextCount() === 2, `test10: should have 2 trade_context rows, got ${store.getTradeContextCount()}`);
  assert(store.getTradesWithoutContext().length === 0, `test10: all trades should now have context`);

  // Verify non-null rsi_14 and correct timeframe
  const rows = store.query<Record<string, unknown>>("SELECT * FROM trade_context ORDER BY trade_id ASC");
  assert(rows.length === 2, `test10: expected 2 rows in trade_context, got ${rows.length}`);

  for (const row of rows) {
    assert(row.rsi_14 !== null, `test10: rsi_14 should not be null`);
    assert(row.timeframe === "5m", `test10: timeframe should be '5m' for recent trades, got '${String(row.timeframe)}'`);
    assert(row.candles_used !== null && (row.candles_used as number) > 0, `test10: candles_used should be > 0`);
    assert(row.mint === MINT_A, `test10: mint should be ${MINT_A}, got ${String(row.mint)}`);
  }

  store.close();
}

// ---------------------------------------------------------------------------
// Additional tests for edge cases
// ---------------------------------------------------------------------------

// Test 11: BB null on insufficient data
async function test11_bollingerBandsNullOnShortData(): Promise<void> {
  const closes = [50, 51, 52];  // only 3 values, period=20
  const result = bollingerBands(closes, 20, 2, 51);
  assert(result === null, `test11: BB should return null when closes.length < period, got non-null`);
}

// Test 12: ATR null on insufficient data
async function test12_atrNullOnShortData(): Promise<void> {
  const candles: Candle[] = [
    { timestamp: 0, open: 10, high: 11, low: 9, close: 10, volume: 100 },
    { timestamp: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
  ];
  // Need period+1 candles = 15, only have 2
  const result = atr(candles, 14);
  assert(result === null, `test12: ATR should be null for insufficient data, got ${String(result)}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["1.  RSI basic: known sequence [44..58] → RSI in [67,72]",                                        test1_rsiBasic],
    ["2.  RSI null on short series: closes.length < period+1 → null",                                  test2_rsiNullOnShortSeries],
    ["3.  EMA convergence: 50 × 100.0 with period=20 → all values = 100.0",                            test3_emaConvergence],
    ["4.  Bollinger Bands flat: 25 closes at 50.0 → upper=middle=lower=50.0, pos=0.5",                 test4_bollingerBandsFlat],
    ["5.  VWAP: 3 known candles → manual calculation within 0.001",                                    test5_vwap],
    ["6.  ATR basic: constant TR=3 → ATR(3) = 3.0",                                                    test6_atrBasic],
    ["7.  Volume ratio: last=200, prev 19 all=100 → ratio ≈ 200/105",                                  test7_volumeRatio],
    ["8.  Momentum: [100,110,121,133.1] momentum(3) ≈ 33.1%",                                          test8_momentum],
    ["9.  EMA cross bullish: trending up → fast EMA > slow EMA",                                       test9_emaCrossBullish],
    ["10. Full pipeline: 2 trades seeded, mock fetch, both enriched with non-null rsi_14",              test10_fullEnrichmentPipeline],
    ["11. Bollinger Bands null: closes.length < period → null",                                        test11_bollingerBandsNullOnShortData],
    ["12. ATR null: candles.length < period+1 → null",                                                 test12_atrNullOnShortData],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ ${name}`);
      console.error(`    ${message}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (passed === tests.length) {
    console.log("Trade context check: ok");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
