// ---------------------------------------------------------------------------
// Wallet Harvester — Strategy Report Offline Test Suite (S5)
//
// Usage:
//   npm run harvest:report:strategy-check
//
// Zero live calls. In-memory SQLite. Writes to os.tmpdir().
// ---------------------------------------------------------------------------

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { HarvesterStore } from "./store.js";
import { generateStrategyReports, formatDuration, percentile } from "./strategyReport.js";
import type { WalletStrategyRecord, PositionRecord, TradeContextRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  reason?: string;
}

const results: TestResult[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`[PASS] ${name}`);
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, reason });
    console.log(`[FAIL: ${reason}] ${name}`);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertApprox(actual: number | null, expected: number, tol = 0.01, label = ""): void {
  assert(actual != null, `${label}: value is null`);
  const diff = Math.abs(actual - expected);
  assert(diff <= tol, `${label}: expected ~${expected}, got ${actual} (diff=${diff})`);
}

// ---------------------------------------------------------------------------
// Helper to build a fresh in-memory store seeded with required rows
// ---------------------------------------------------------------------------

function makeStore(): HarvesterStore {
  return new HarvesterStore(":memory:");
}

function seedStrategy(store: HarvesterStore, overrides: Partial<WalletStrategyRecord> = {}): WalletStrategyRecord {
  const base: WalletStrategyRecord = {
    walletAddress: `wallet_${Math.random().toString(36).slice(2)}`,
    totalPositions: 10,
    closedPositions: 8,
    openPositions: 2,
    singleEntryPct: 0.7,
    dcaPct: 0.2,
    scaleInPct: 0.1,
    avgEntriesPerPos: 1.3,
    singleExitPct: 0.8,
    partialTpPct: 0.2,
    trailingExitPct: 0.0,
    avgExitsPerPos: 1.2,
    medianTpPct: 40,
    p25TpPct: 20,
    p75TpPct: 80,
    medianSlPct: -15,
    p25SlPct: -30,
    p75SlPct: -5,
    trailingDetected: 0,
    trailingDropPct: null,
    medianHoldS: 7200,
    avgHoldS: 8000,
    medianEntryHour: 14,
    medianEntryMcap: 150000,
    avgEntryMcap: 160000,
    pctUnder200k: 0.85,
    winRate: 0.6,
    avgPnlPct: 25,
    medianPnlPct: 20,
    sharpeLike: 1.2,
    archetype: "dca_accumulator",
    isLikelyBot: 0,
    confidence: 0.5,
    analyzedAtMs: Date.now(),
    analysisVersion: 1,
    ...overrides,
  };
  store.upsertWalletStrategy(base);
  return base;
}

function seedPosition(
  store: HarvesterStore,
  walletAddress: string,
  realizedPct: number,
  entryMcapUsd: number | null = 100000,
  overrides: Partial<PositionRecord> = {},
): number {
  const pos: PositionRecord = {
    walletAddress,
    mint: `mint_${Math.random().toString(36).slice(2)}`,
    status: "closed",
    entryCount: 1,
    firstEntryTs: Date.now() - 10000,
    lastEntryTs: Date.now() - 10000,
    avgEntryPrice: 0.001,
    totalSolIn: 1,
    totalTokenIn: 1000,
    entryMcapUsd,
    exitCount: 1,
    firstExitTs: Date.now(),
    lastExitTs: Date.now(),
    avgExitPrice: 0.001 * (1 + realizedPct / 100),
    totalSolOut: 1 + realizedPct / 100,
    totalTokenOut: 1000,
    realizedSol: realizedPct / 100,
    realizedUsd: null,
    realizedPct,
    holdDurationS: 3600,
    entrySpreadS: 0,
    exitSpreadS: null,
    isDca: 0,
    isScaleIn: 0,
    isPartialTp: 0,
    isFullExit: 1,
    isTrailingLike: 0,
    tradeIdsJson: "[]",
    builtAtMs: Date.now(),
    ...overrides,
  };
  store.upsertPosition(pos);
  // Return the id of the inserted position
  const rows = store.query<{ id: number }>(
    "SELECT id FROM positions WHERE wallet_address = ? AND mint = ?",
    [pos.walletAddress, pos.mint]
  );
  return rows[0]?.id ?? 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
  const tmpBase = path.join(os.tmpdir(), `strategy-report-check-${Date.now()}`);
  fs.mkdirSync(tmpBase, { recursive: true });

  const silentLogger = pino({ level: "silent" });

  // -------------------------------------------------------------------------
  // Test 1: Per-wallet CSV columns
  // -------------------------------------------------------------------------
  await test("Per-wallet CSV columns", async () => {
    const store = makeStore();
    seedStrategy(store, { walletAddress: "wallet_A" });
    seedStrategy(store, { walletAddress: "wallet_B" });
    seedStrategy(store, { walletAddress: "wallet_C" });

    const tmpDir = path.join(tmpBase, "t1");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    // Find CSV file
    const csvFile = result.reportsWritten.find(f => f.endsWith(".csv"));
    assert(csvFile != null, "No CSV file in reportsWritten");
    const csvContent = fs.readFileSync(csvFile, "utf-8");
    const lines = csvContent.trim().split("\n");
    assert(lines.length === 4, `Expected 4 lines (header + 3 rows), got ${lines.length}`);

    const header = lines[0]!;
    const expectedCols = [
      "wallet_address", "archetype", "is_likely_bot", "win_rate",
      "avg_pnl_pct", "median_tp_pct", "median_sl_pct", "median_hold_s",
      "total_positions", "pct_under_200k", "sharpe_like",
    ];
    for (const col of expectedCols) {
      assert(header.includes(col), `CSV header missing column: ${col}`);
    }

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 2: Archetype distribution count
  // -------------------------------------------------------------------------
  await test("Archetype distribution count", async () => {
    const store = makeStore();
    seedStrategy(store, { walletAddress: "w1", archetype: "sniper_bot", isLikelyBot: 1 });
    seedStrategy(store, { walletAddress: "w2", archetype: "sniper_bot", isLikelyBot: 1 });
    seedStrategy(store, { walletAddress: "w3", archetype: "dca_accumulator", isLikelyBot: 0 });

    const tmpDir = path.join(tmpBase, "t2");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    const distFile = result.reportsWritten.find(f => f.includes("distribution"));
    assert(distFile != null, "No distribution file found");
    const dist = JSON.parse(fs.readFileSync(distFile, "utf-8")) as {
      archetypeDistribution: Record<string, { count: number }>;
      botCount: number;
      humanCount: number;
    };

    assert(dist.archetypeDistribution["sniper_bot"]?.count === 2,
      `Expected sniper_bot count=2, got ${dist.archetypeDistribution["sniper_bot"]?.count}`);
    assert(dist.archetypeDistribution["dca_accumulator"]?.count === 1,
      `Expected dca_accumulator count=1, got ${dist.archetypeDistribution["dca_accumulator"]?.count}`);
    assert(dist.botCount === 2, `Expected botCount=2, got ${dist.botCount}`);
    assert(dist.humanCount === 1, `Expected humanCount=1, got ${dist.humanCount}`);

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 3: PnL histogram bucket assignments
  // -------------------------------------------------------------------------
  await test("PnL histogram bucket assignments", async () => {
    const store = makeStore();
    const w = "wallet_hist";
    seedStrategy(store, { walletAddress: w });
    seedPosition(store, w, 80);   // (50,100]
    seedPosition(store, w, 30);   // (20,50]
    seedPosition(store, w, -15);  // [-20,-5)
    seedPosition(store, w, -60);  // [-100,-50)

    const tmpDir = path.join(tmpBase, "t3");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    const sltpFile = result.reportsWritten.find(f => f.includes("optimal-sltp"));
    assert(sltpFile != null, "No optimal-sltp file found");
    const sltp = JSON.parse(fs.readFileSync(sltpFile, "utf-8")) as {
      pnlHistogram: Array<{ bucket: string; count: number }>;
    };

    const findBucket = (label: string) => sltp.pnlHistogram.find(b => b.bucket === label);
    assert(findBucket("(50,100]")?.count === 1, "Expected 1 in (50,100]");
    assert(findBucket("(20,50]")?.count === 1, "Expected 1 in (20,50]");
    assert(findBucket("[-20,-5)")?.count === 1, "Expected 1 in [-20,-5)");
    assert(findBucket("[-100,-50)")?.count === 1, "Expected 1 in [-100,-50)");

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 4: Suggested TP/SL computation
  // -------------------------------------------------------------------------
  await test("Suggested TP/SL = p75(winners) and p25(losers)", async () => {
    const store = makeStore();
    const w = "wallet_tpsl";
    seedStrategy(store, { walletAddress: w });

    // Winners: 10, 20, 30, 40, 50 — p75 = 40
    for (const pct of [10, 20, 30, 40, 50]) {
      seedPosition(store, w, pct);
    }
    // Losers: -10, -20, -30, -40, -50 — p25 = -40
    for (const pct of [-10, -20, -30, -40, -50]) {
      seedPosition(store, w, pct);
    }

    const tmpDir = path.join(tmpBase, "t4");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    const sltpFile = result.reportsWritten.find(f => f.includes("optimal-sltp"));
    assert(sltpFile != null, "No optimal-sltp file");
    const sltp = JSON.parse(fs.readFileSync(sltpFile, "utf-8")) as {
      suggestedTpPct: number;
      suggestedSlPct: number;
    };

    // p75 of [10,20,30,40,50] = 40
    const expectedTp = percentile([10, 20, 30, 40, 50], 75)!;
    assertApprox(sltp.suggestedTpPct, expectedTp, 1, "suggestedTpPct");
    // p25 of [-50,-40,-30,-20,-10] = -40
    const expectedSl = percentile([-10, -20, -30, -40, -50], 25)!;
    assertApprox(sltp.suggestedSlPct, expectedSl, 1, "suggestedSlPct");

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 5: Indicator winners vs losers RSI means
  // -------------------------------------------------------------------------
  await test("Indicator analysis: winner vs loser RSI means", async () => {
    const store = makeStore();
    const w = "wallet_ind";
    seedStrategy(store, { walletAddress: w });

    // Insert 2 winning positions + trade context with known RSI
    // and 2 losing positions with different RSI
    const now = Date.now();

    // Need trades in the trades table to get IDs — use upsertTrade
    const insertTrade = (wallet: string, mint: string, id: number): void => {
      // upsertTrade doesn't let us set a specific id; use the TradeRecord directly
      // We work around this by inserting via query helper using run (not all).
      // Since query() uses .all(), we instead use the upsertTrade API with a unique signature
      // and then look up the id by signature.
      store.upsertTrade({
        walletAddress: wallet,
        signature: `sig_${id}`,
        mint,
        side: "buy",
        tokenAmount: 100,
        solAmount: 1,
        usdAmount: null,
        priceUsd: null,
        priceSol: null,
        timestamp: now - 5000,
        program: null,
        slot: null,
        rawJson: null,
        collectedAtMs: now,
      });
    };

    // Insert trade_context with specific RSI values
    const insertContext = (tradeId: number, positionId: number, mint: string, rsi: number): void => {
      const ctx: TradeContextRecord = {
        tradeId,
        positionId,
        mint,
        candleOpen: null, candleHigh: null, candleLow: null, candleClose: null,
        candleVolume: null,
        rsi14: rsi,
        vwap: null, bbUpper: null, bbMiddle: null, bbLower: null, bbPosition: null,
        volumeRatio: null, ema9: null, ema21: null, emaTrend: null,
        distanceFromHighPct: null, distanceFromLowPct: null,
        atr14: null, momentum5: null, momentum15: null, momentum60: null,
        timeframe: "1m",
        candlesUsed: null,
        computedAtMs: now,
      };
      store.upsertTradeContext(ctx);
    };

    // Helper to get trade id by signature
    const getTradeId = (sig: string): number => {
      const rows = store.query<{ id: number }>("SELECT id FROM trades WHERE signature = ?", [sig]);
      assert(rows.length > 0, `Trade not found for signature ${sig}`);
      return rows[0]!.id;
    };

    // Winners with RSI ~30
    const mint1 = "mint_w1";
    const mint2 = "mint_w2";
    insertTrade(w, mint1, 101);
    insertTrade(w, mint2, 102);
    const tid1 = getTradeId("sig_101");
    const tid2 = getTradeId("sig_102");
    const id1 = seedPosition(store, w, 50, 100000, { mint: mint1, tradeIdsJson: `[${tid1}]` });
    const id2 = seedPosition(store, w, 80, 100000, { mint: mint2, tradeIdsJson: `[${tid2}]` });
    insertContext(tid1, id1, mint1, 30);
    insertContext(tid2, id2, mint2, 32);

    // Losers with RSI ~65
    const mint3 = "mint_l1";
    const mint4 = "mint_l2";
    insertTrade(w, mint3, 103);
    insertTrade(w, mint4, 104);
    const tid3 = getTradeId("sig_103");
    const tid4 = getTradeId("sig_104");
    const id3 = seedPosition(store, w, -20, 100000, { mint: mint3, tradeIdsJson: `[${tid3}]` });
    const id4 = seedPosition(store, w, -30, 100000, { mint: mint4, tradeIdsJson: `[${tid4}]` });
    insertContext(tid3, id3, mint3, 65);
    insertContext(tid4, id4, mint4, 67);

    const tmpDir = path.join(tmpBase, "t5");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    const indFile = result.reportsWritten.find(f => f.includes("indicators"));
    assert(indFile != null, "No indicators file");
    const ind = JSON.parse(fs.readFileSync(indFile, "utf-8")) as {
      indicators: {
        rsi_14: { winners: { mean: number }; losers: { mean: number } };
      };
    };

    assertApprox(ind.indicators.rsi_14.winners.mean, 31, 1, "winner RSI mean");
    assertApprox(ind.indicators.rsi_14.losers.mean, 66, 1, "loser RSI mean");

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 6: Anomaly detection — outlier performance
  // -------------------------------------------------------------------------
  await test("Anomaly detection: outlier_performance flag", async () => {
    const store = makeStore();
    seedStrategy(store, {
      walletAddress: "outlier_wallet",
      winRate: 0.95,
      totalPositions: 6,
      closedPositions: 6,
    });
    // Another normal wallet
    seedStrategy(store, { walletAddress: "normal_wallet", winRate: 0.6, totalPositions: 10 });

    const tmpDir = path.join(tmpBase, "t6");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    const anomFile = result.reportsWritten.find(f => f.includes("anomalies"));
    assert(anomFile != null, "No anomalies file");
    const anom = JSON.parse(fs.readFileSync(anomFile, "utf-8")) as {
      anomalies: Array<{ wallet_address: string; flags: string[] }>;
    };

    const flagged = anom.anomalies.find(a => a.wallet_address === "outlier_wallet");
    assert(flagged != null, "outlier_wallet not in anomalies");
    assert(
      flagged.flags.includes("outlier_performance"),
      `Expected outlier_performance flag, got: ${flagged.flags.join(",")}`
    );

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 7: Anomaly detection — extreme loss
  // -------------------------------------------------------------------------
  await test("Anomaly detection: extreme_loss flag", async () => {
    const store = makeStore();
    seedStrategy(store, {
      walletAddress: "loser_wallet",
      avgPnlPct: -60,
      closedPositions: 4,
      totalPositions: 4,
      winRate: 0.1,
    });
    seedStrategy(store, { walletAddress: "ok_wallet", avgPnlPct: 5 });

    const tmpDir = path.join(tmpBase, "t7");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    const anomFile = result.reportsWritten.find(f => f.includes("anomalies"));
    assert(anomFile != null, "No anomalies file");
    const anom = JSON.parse(fs.readFileSync(anomFile, "utf-8")) as {
      anomalies: Array<{ wallet_address: string; flags: string[] }>;
    };

    const flagged = anom.anomalies.find(a => a.wallet_address === "loser_wallet");
    assert(flagged != null, "loser_wallet not in anomalies");
    assert(
      flagged.flags.includes("extreme_loss"),
      `Expected extreme_loss flag, got: ${flagged.flags.join(",")}`
    );

    store.close();
  });

  // -------------------------------------------------------------------------
  // Test 8: All 5 expected output files are created and valid JSON
  // -------------------------------------------------------------------------
  await test("Report files created and valid JSON", async () => {
    const store = makeStore();
    seedStrategy(store, { walletAddress: "w_file_test_1" });
    seedStrategy(store, { walletAddress: "w_file_test_2" });

    const tmpDir = path.join(tmpBase, "t8");
    fs.mkdirSync(tmpDir, { recursive: true });

    const result = await generateStrategyReports(
      { outputDir: tmpDir, targetMcapMaxUsd: 200000, minPositionSample: 5 },
      store,
      silentLogger,
    );

    // Should have: 2 wallet files (json+csv) + distribution + sltp + indicators + anomalies = 6 files
    const jsonFiles = result.reportsWritten.filter(f => f.endsWith(".json"));
    assert(jsonFiles.length === 5, `Expected 5 JSON files, got ${jsonFiles.length}: ${jsonFiles.join(", ")}`);

    const csvFiles = result.reportsWritten.filter(f => f.endsWith(".csv"));
    assert(csvFiles.length === 1, `Expected 1 CSV file, got ${csvFiles.length}`);

    // Verify each JSON file is parseable
    for (const jf of jsonFiles) {
      assert(fs.existsSync(jf), `File does not exist: ${jf}`);
      const content = fs.readFileSync(jf, "utf-8");
      try {
        JSON.parse(content);
      } catch {
        throw new Error(`Invalid JSON in ${jf}`);
      }
    }

    // Verify expected report names
    const expectedPatterns = ["strategy-wallets", "strategy-distribution", "strategy-optimal-sltp", "strategy-indicators", "strategy-anomalies"];
    for (const pat of expectedPatterns) {
      const found = result.reportsWritten.some(f => path.basename(f).includes(pat));
      assert(found, `No file matching pattern: ${pat}`);
    }

    store.close();
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  console.log(`\n${passed}/${total} tests passed`);

  if (passed < total) {
    process.exit(1);
  }
}

runTests().catch((err: unknown) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
