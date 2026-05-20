// ---------------------------------------------------------------------------
// Wallet Harvester — Strategy Classifier Check (zero live calls)
//
// Usage:
//   npm run harvest:classify-check
//
// Tests strategy classification logic using in-memory SQLite. No API calls.
// ---------------------------------------------------------------------------

import pino from "pino";
import { HarvesterStore } from "./store.js";
import { classifyWallets, DEFAULT_CLASSIFIER_CONFIG, median, percentile, stddev, mean } from "./strategyClassifier.js";
import type { ClassifierConfig } from "./strategyClassifier.js";
import type { PositionRecord, TradeContextRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const logger = pino({ level: "silent" });
const CFG: ClassifierConfig = { ...DEFAULT_CLASSIFIER_CONFIG };

function makeStore(): HarvesterStore {
  return new HarvesterStore(":memory:");
}

let posIdCounter = 0;
let tradeIdCounter = 0;

function seedPosition(
  store: HarvesterStore,
  overrides: Partial<PositionRecord> & {
    walletAddress: string;
    mint: string;
    status: "open" | "closed";
    firstEntryTs: number;
  },
): { positionId: number; tradeIds: number[] } {
  // Seed a synthetic trade for the position so we can link trade_context
  tradeIdCounter++;
  const tradeId = tradeIdCounter;
  store.upsertTrade({
    walletAddress: overrides.walletAddress,
    signature: `sig_check_${tradeId}`,
    mint: overrides.mint,
    side: "buy",
    tokenAmount: 100,
    solAmount: 1.0,
    usdAmount: null,
    priceUsd: null,
    priceSol: 0.01,
    timestamp: overrides.firstEntryTs,
    program: "test",
    slot: tradeId,
    rawJson: null,
    collectedAtMs: Date.now(),
  });

  posIdCounter++;
  const tradeIdsJson = JSON.stringify([tradeId]);
  const pos: PositionRecord = {
    walletAddress: overrides.walletAddress,
    mint: overrides.mint,
    status: overrides.status,
    entryCount: overrides.entryCount ?? 1,
    firstEntryTs: overrides.firstEntryTs,
    lastEntryTs: overrides.lastEntryTs ?? overrides.firstEntryTs,
    avgEntryPrice: overrides.avgEntryPrice ?? 0.01,
    totalSolIn: overrides.totalSolIn ?? 1.0,
    totalTokenIn: overrides.totalTokenIn ?? 100,
    entryMcapUsd: overrides.entryMcapUsd ?? null,
    exitCount: overrides.exitCount ?? (overrides.status === "closed" ? 1 : 0),
    firstExitTs: overrides.firstExitTs ?? (overrides.status === "closed" ? overrides.firstEntryTs + (overrides.holdDurationS ?? 3600) : null),
    lastExitTs: overrides.lastExitTs ?? (overrides.status === "closed" ? overrides.firstEntryTs + (overrides.holdDurationS ?? 3600) : null),
    avgExitPrice: overrides.avgExitPrice ?? null,
    totalSolOut: overrides.totalSolOut ?? (overrides.status === "closed" ? 1.0 : 0),
    totalTokenOut: overrides.totalTokenOut ?? (overrides.status === "closed" ? 100 : 0),
    realizedSol: overrides.realizedSol ?? null,
    realizedUsd: overrides.realizedUsd ?? null,
    realizedPct: overrides.realizedPct ?? null,
    holdDurationS: overrides.holdDurationS ?? (overrides.status === "closed" ? 3600 : null),
    entrySpreadS: overrides.entrySpreadS ?? 0,
    exitSpreadS: overrides.exitSpreadS ?? null,
    isDca: overrides.isDca ?? 0,
    isScaleIn: overrides.isScaleIn ?? 0,
    isPartialTp: overrides.isPartialTp ?? 0,
    isFullExit: overrides.isFullExit ?? (overrides.status === "closed" ? 1 : 0),
    isTrailingLike: overrides.isTrailingLike ?? 0,
    tradeIdsJson,
    builtAtMs: Date.now(),
  };
  store.upsertPosition(pos);

  // Return trade id for context seeding
  return { positionId: posIdCounter, tradeIds: [tradeId] };
}

function seedTradeContext(
  store: HarvesterStore,
  tradeId: number,
  overrides: Partial<TradeContextRecord> & { mint: string },
): void {
  store.upsertTradeContext({
    tradeId,
    positionId: null,
    mint: overrides.mint,
    candleOpen: overrides.candleOpen ?? null,
    candleHigh: overrides.candleHigh ?? null,
    candleLow: overrides.candleLow ?? null,
    candleClose: overrides.candleClose ?? null,
    candleVolume: overrides.candleVolume ?? null,
    rsi14: overrides.rsi14 ?? null,
    vwap: overrides.vwap ?? null,
    bbUpper: overrides.bbUpper ?? null,
    bbMiddle: overrides.bbMiddle ?? null,
    bbLower: overrides.bbLower ?? null,
    bbPosition: overrides.bbPosition ?? null,
    volumeRatio: overrides.volumeRatio ?? null,
    ema9: overrides.ema9 ?? null,
    ema21: overrides.ema21 ?? null,
    emaTrend: overrides.emaTrend ?? null,
    distanceFromHighPct: overrides.distanceFromHighPct ?? null,
    distanceFromLowPct: overrides.distanceFromLowPct ?? null,
    atr14: overrides.atr14 ?? null,
    momentum5: overrides.momentum5 ?? null,
    momentum15: overrides.momentum15 ?? null,
    momentum60: overrides.momentum60 ?? null,
    timeframe: overrides.timeframe ?? "5m",
    candlesUsed: overrides.candlesUsed ?? null,
    computedAtMs: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertClose(a: number | null, b: number, tol: number, message: string): void {
  if (a === null) throw new Error(`ASSERTION FAILED: ${message} (got null, expected ~${b})`);
  if (Math.abs(a - b) > tol) {
    throw new Error(`ASSERTION FAILED: ${message} (got ${a}, expected ~${b}, tol ${tol})`);
  }
}

// ---------------------------------------------------------------------------
// Test 1: Single-entry sniper bot
// ---------------------------------------------------------------------------

async function test1_sniperBot(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletBotSniperAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const BASE_TS = 1_000_000; // % 86400 = 1000000 % 86400 = large, but use sub-second offset
  // Use timestamps where (ts % 86400) < 5 for bot timing signal
  // 86400 * N: use N=11: 11*86400 = 950400. 950400 + 2 = 950402 (offset=2 < 5)
  const SUB_S_TS = 86400 * 11 + 2;

  for (let i = 0; i < 10; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      status: "closed",
      firstEntryTs: SUB_S_TS + i * 3600,
      entryCount: 1,
      holdDurationS: 600, // 10 min < 30 min
      realizedPct: 30,
    });
  }

  const result = await classifyWallets(CFG, store, logger);
  assert(result.walletsClassified === 1, `test1: expected 1 classified, got ${result.walletsClassified}`);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  assert(rows.length === 1, "test1: no strategy row");
  const row = rows[0]!;
  assert(row.is_likely_bot === 1, `test1: expected is_likely_bot=1, got ${row.is_likely_bot}`);
  assert(row.archetype === "sniper_bot", `test1: expected archetype='sniper_bot', got '${row.archetype}'`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 2: DCA accumulator
// ---------------------------------------------------------------------------

async function test2_dcaAccumulator(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletDcaAccumBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

  for (let i = 0; i < 5; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`,
      status: "closed",
      firstEntryTs: 1_000_000 + i * 86400,
      entryCount: 3,
      isDca: 1,
      holdDurationS: 10 * 3600, // 10 hours > 3600
      realizedPct: 20,
    });
  }

  const result = await classifyWallets(CFG, store, logger);
  assert(result.walletsClassified === 1, `test2: expected 1 classified`);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  assert(row.archetype === "dca_accumulator", `test2: expected 'dca_accumulator', got '${row.archetype}'`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 3: Momentum scalper
// ---------------------------------------------------------------------------

async function test3_momentumScalper(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletMomentumScalperCCCCCCCCCCCCCCCCCCCCCC";
  // Use large TS offset to avoid sub-second bot signal
  const BASE_TS = 86400 * 5 + 7200; // offset = 7200 >> 5

  for (let i = 0; i < 5; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC`,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      entryCount: 1,
      isDca: 0,
      holdDurationS: 45 * 60, // 45 min — between 30 and 60 min, < 3600
      realizedPct: 15,
    });
  }

  const result = await classifyWallets(CFG, store, logger);
  assert(result.walletsClassified === 1, `test3: expected 1 classified`);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  assert(row.archetype === "momentum_scalper", `test3: expected 'momentum_scalper', got '${row.archetype}'`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 4: Insufficient positions → skipped
// ---------------------------------------------------------------------------

async function test4_insufficientPositions(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletInsufficientDDDDDDDDDDDDDDDDDDDDDDD";

  // Only 1 closed position — below minClosedPositions=3
  seedPosition(store, {
    walletAddress: WALLET,
    mint: "MintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    status: "closed",
    firstEntryTs: 1_000_000,
    holdDurationS: 3600,
    realizedPct: 20,
  });

  const result = await classifyWallets(CFG, store, logger);
  assert(result.walletsSkipped === 1, `test4: expected walletsSkipped=1, got ${result.walletsSkipped}`);
  assert(result.walletsClassified === 0, `test4: expected 0 classified`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 5: Win rate calculation
// ---------------------------------------------------------------------------

async function test5_winRate(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletWinRateEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";
  const BASE_TS = 86400 * 3 + 7200;

  // 4 winners at +50%
  for (let i = 0; i < 4; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE`,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      holdDurationS: 3600,
      realizedPct: 50,
      realizedSol: 0.5,
    });
  }

  // 1 loser at -30%
  seedPosition(store, {
    walletAddress: WALLET,
    mint: "MintLoserEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
    status: "closed",
    firstEntryTs: BASE_TS + 4 * 86400,
    holdDurationS: 3600,
    realizedPct: -30,
    realizedSol: -0.3,
  });

  await classifyWallets(CFG, store, logger);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  assertClose(row.win_rate as number, 0.8, 0.001, "test5: win_rate");
  assertClose(row.avg_pnl_pct as number, (50 * 4 + (-30)) / 5, 0.01, "test5: avg_pnl_pct");

  store.close();
}

// ---------------------------------------------------------------------------
// Test 6: TP percentiles
// ---------------------------------------------------------------------------

async function test6_tpPercentiles(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletTpPercentilesFFFFFFFFFFFFFFFFFFFFFFFFF";
  const BASE_TS = 86400 * 3 + 7200;
  const pcts = [20, 40, 60, 80, 100];

  for (let i = 0; i < 5; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF`,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      holdDurationS: 3600,
      realizedPct: pcts[i]!,
    });
  }

  await classifyWallets(CFG, store, logger);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  // median of [20,40,60,80,100] = 60
  assertClose(row.median_tp_pct as number, 60, 0.01, "test6: median_tp_pct");
  // p25 of [20,40,60,80,100] with linear interp: rank = 0.25*4=1, lower=1,upper=1 → 40
  assertClose(row.p25_tp_pct as number, 40, 0.01, "test6: p25_tp_pct");
  // p75 of [20,40,60,80,100]: rank = 0.75*4=3, lower=3,upper=3 → 80
  assertClose(row.p75_tp_pct as number, 80, 0.01, "test6: p75_tp_pct");

  store.close();
}

// ---------------------------------------------------------------------------
// Test 7: SL percentiles
// ---------------------------------------------------------------------------

async function test7_slPercentiles(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletSlPercentilesGGGGGGGGGGGGGGGGGGGGGGG";
  const BASE_TS = 86400 * 3 + 7200;
  const lossPcts = [-10, -30, -50];

  for (let i = 0; i < 3; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG`,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      holdDurationS: 3600,
      realizedPct: lossPcts[i]!,
    });
  }

  await classifyWallets(CFG, store, logger);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  // median of [-10, -30, -50] = -30
  assertClose(row.median_sl_pct as number, -30, 0.01, "test7: median_sl_pct");

  store.close();
}

// ---------------------------------------------------------------------------
// Test 8: Sharpe-like calculation
// ---------------------------------------------------------------------------

async function test8_sharpeLike(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletSharpeHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH";
  const BASE_TS = 86400 * 3 + 7200;
  // Known values: [10, 20, 30] → mean=20, stddev=sqrt(((10-20)^2+(20-20)^2+(30-20)^2)/3) = sqrt(200/3) ≈ 8.165
  // sharpe = 20 / 8.165 ≈ 2.449
  const pcts = [10, 20, 30];

  for (let i = 0; i < 3; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHH`,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      holdDurationS: 3600,
      realizedPct: pcts[i]!,
    });
  }

  await classifyWallets(CFG, store, logger);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  const expectedSharpe = 20 / Math.sqrt(200 / 3);
  assertClose(row.sharpe_like as number, expectedSharpe, 0.01, "test8: sharpe_like");

  // Also verify pure helper functions directly
  const m = mean([10, 20, 30]);
  assert(m !== null && Math.abs(m - 20) < 0.001, "test8: mean helper");
  const s = stddev([10, 20, 30]);
  assert(s !== null && Math.abs(s - Math.sqrt(200 / 3)) < 0.001, "test8: stddev helper");

  store.close();
}

// ---------------------------------------------------------------------------
// Test 9: Dip buyer detection via trade context
// ---------------------------------------------------------------------------

async function test9_dipBuyer(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletDipBuyerIIIIIIIIIIIIIIIIIIIIIIIIIIII";
  const BASE_TS = 86400 * 3 + 7200;

  const tradeIds: number[] = [];
  for (let i = 0; i < 5; i++) {
    const mint = `Mint${i}IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII`;
    const { tradeIds: posTradeIds } = seedPosition(store, {
      walletAddress: WALLET,
      mint,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      holdDurationS: 7200,
      realizedPct: 25,
    });
    tradeIds.push(...posTradeIds);
  }

  // Seed trade context with low RSI (oversold) for majority
  for (let i = 0; i < 5; i++) {
    seedTradeContext(store, tradeIds[i]!, {
      mint: `Mint${i}IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII`,
      rsi14: i < 4 ? 28 : 55, // 4 out of 5 below 40
    });
  }

  await classifyWallets(CFG, store, logger);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  assert(row.archetype === "dip_buyer", `test9: expected 'dip_buyer', got '${row.archetype}'`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 10: Diamond hands
// ---------------------------------------------------------------------------

async function test10_diamondHands(): Promise<void> {
  const store = makeStore();
  const WALLET = "WalletDiamondHandsJJJJJJJJJJJJJJJJJJJJJJJJJ";
  const BASE_TS = 86400 * 3 + 7200;

  // 2 closed positions with long hold
  for (let i = 0; i < 3; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `Mint${i}JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ`,
      status: "closed",
      firstEntryTs: BASE_TS + i * 86400,
      holdDurationS: 2 * 86400, // 2 days >> 86400
      realizedPct: 10,
    });
  }

  // 5 open positions (more open than closed)
  for (let i = 0; i < 5; i++) {
    seedPosition(store, {
      walletAddress: WALLET,
      mint: `MintOpen${i}JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ`,
      status: "open",
      firstEntryTs: BASE_TS + (i + 3) * 86400,
    });
  }

  await classifyWallets(CFG, store, logger);

  const rows = store.query<Record<string, unknown>>("SELECT * FROM wallet_strategies WHERE wallet_address = ?", [WALLET]);
  const row = rows[0]!;
  assert(row.archetype === "diamond_hands", `test10: expected 'diamond_hands', got '${row.archetype}'`);
  assert((row.open_positions as number) > (row.closed_positions as number), "test10: open > closed");

  store.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["1. Single-entry sniper bot → is_likely_bot=1, archetype='sniper_bot'",                           test1_sniperBot],
    ["2. DCA accumulator → all is_dca=1, long hold → archetype='dca_accumulator'",                    test2_dcaAccumulator],
    ["3. Momentum scalper → single entry, 30-60min hold, not bot → archetype='momentum_scalper'",     test3_momentumScalper],
    ["4. Insufficient positions (1 closed) → walletsSkipped=1",                                        test4_insufficientPositions],
    ["5. Win rate: 4 winners +50%, 1 loser -30% → win_rate=0.8, correct avg_pnl_pct",                 test5_winRate],
    ["6. TP percentiles: [+20,+40,+60,+80,+100] → median=60, p25=40, p75=80",                         test6_tpPercentiles],
    ["7. SL percentiles: [-10,-30,-50] → median_sl_pct=-30",                                           test7_slPercentiles],
    ["8. Sharpe-like: [10,20,30] → mean/stddev within tolerance",                                      test8_sharpeLike],
    ["9. Dip buyer: majority entries with rsi_14<40 → archetype='dip_buyer'",                          test9_dipBuyer],
    ["10. Diamond hands: 3 closed + 5 open, hold>86400 → archetype='diamond_hands'",                  test10_diamondHands],
  ];

  let passed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  [FAIL: ${message}] ${name}`);
      process.exitCode = 1;
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (passed === tests.length) {
    console.log("Strategy classifier check: ok");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
