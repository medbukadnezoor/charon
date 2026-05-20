// ---------------------------------------------------------------------------
// Wallet Harvester — Trade History Collector Check (zero live calls)
//
// Usage:
//   npm run harvest:trades-check
//
// Validates all core behaviours of tradeHistory.ts using an in-memory SQLite
// DB and a mock fetch function. No Helius API calls are made.
// ---------------------------------------------------------------------------

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { HarvesterStore } from "./store.js";
import { collectTradeHistory } from "./tradeHistory.js";
import type { TradeHistoryConfig, FetchFn } from "./tradeHistory.js";
import type { ExtractedWallet } from "./types.js";

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOL_MINT = "So11111111111111111111111111111111111111112";

const WALLET_A = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const WALLET_B = "WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const MINT_X   = "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const MINT_Y   = "MintYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

const NOW_SEC  = Math.floor(Date.now() / 1000);
const OLD_SEC  = NOW_SEC - 40 * 24 * 60 * 60; // 40 days ago — past the 30-day cutoff

const BASE_CFG: TradeHistoryConfig = {
  heliusApiKey: "test-key",
  heliusBaseUrl: "https://test.helius.xyz",
  lookbackDays: 30,
  rateLimitMs: 0,
  maxRetries: 3,
  pageSize: 100,
};

const logger = pino({ level: "silent" });

// ---------------------------------------------------------------------------
// Transaction builders
// ---------------------------------------------------------------------------

function buildSwapTx(
  sig: string,
  walletAddress: string,
  mint: string,
  side: "buy" | "sell",
  tokenAmount = 1_000_000,
  solLamports = 500_000_000,
  timestamp = NOW_SEC,
  source = "JUPITER",
): unknown {
  return {
    signature: sig,
    timestamp,
    slot: 100,
    type: "SWAP",
    source,
    tokenTransfers: [
      {
        mint,
        tokenAmount,
        fromUserAccount: side === "sell" ? walletAddress : "OtherAccount111111111111111111111111111111",
        toUserAccount:   side === "buy"  ? walletAddress : "OtherAccount111111111111111111111111111111",
      },
    ],
    nativeTransfers: [
      {
        amount: solLamports,
        fromUserAccount: side === "buy" ? walletAddress : "OtherAccount111111111111111111111111111111",
        toUserAccount:   side === "sell" ? walletAddress : "OtherAccount111111111111111111111111111111",
      },
    ],
    feePayer: walletAddress,
  };
}

// ---------------------------------------------------------------------------
// Store factory (temp dir so each test is isolated)
// ---------------------------------------------------------------------------

async function makeStore(walletAddresses: string[]): Promise<{ store: HarvesterStore; tmpDir: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "charon-trade-check-"));
  const dbPath = path.join(tmpDir, "test.db");
  const store = new HarvesterStore(dbPath);

  // Seed the wallets table
  const runId = "test-run";
  store.createRun(runId);
  const fixture: ExtractedWallet[] = walletAddresses.map(addr => ({
    address: addr,
    source: "gmgn" as const,
    tags: ["smart_degen"],
    mint: MINT_X,
    action: "buy" as const,
    amountUsd: 100,
    tokenMcapUsd: 500_000,
    pnlUsd: null,
    winRate: null,
    avgBuyUsd: null,
    timestamp: Date.now(),
    signalType: null,
  }));
  store.ingestWallets(fixture, runId);
  store.completeRun(runId, { status: "completed" });

  return { store, tmpDir };
}

async function cleanup(store: HarvesterStore, tmpDir: string): Promise<void> {
  store.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function test1_happyPath(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A, WALLET_B]);

  const txA1 = buildSwapTx("sigA1", WALLET_A, MINT_X, "buy");
  const txA2 = buildSwapTx("sigA2", WALLET_A, MINT_X, "sell");
  const txB1 = buildSwapTx("sigB1", WALLET_B, MINT_Y, "buy");
  const txB2 = buildSwapTx("sigB2", WALLET_B, MINT_Y, "sell");

  const responses: Record<string, unknown[]> = {
    [WALLET_A]: [txA1, txA2],
    [WALLET_B]: [txB1, txB2],
  };

  const mockFetch: FetchFn = async (url) => {
    for (const [addr, txs] of Object.entries(responses)) {
      if (url.includes(addr)) {
        return { ok: true, status: 200, json: async () => txs };
      }
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.walletsProcessed === 2, `test1: walletsProcessed should be 2, got ${result.walletsProcessed}`);
  assert(result.tradesInserted === 4,   `test1: tradesInserted should be 4, got ${result.tradesInserted}`);
  assert(result.walletsFailed === 0,    `test1: walletsFailed should be 0, got ${result.walletsFailed}`);
  assert(store.getTradeCount() === 4,   `test1: DB should have 4 trades, got ${store.getTradeCount()}`);

  await cleanup(store, tmpDir);
}

async function test2_pagination(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  // Build 100 txs for page 1 and 2 for page 2
  const page1 = Array.from({ length: 100 }, (_, i) =>
    buildSwapTx(`sigP1-${i.toString().padStart(3, "0")}`, WALLET_A, MINT_X, "buy"),
  );
  const page2 = Array.from({ length: 2 }, (_, i) =>
    buildSwapTx(`sigP2-${i}`, WALLET_A, MINT_X, "buy"),
  );

  let callCount = 0;
  const mockFetch: FetchFn = async () => {
    callCount++;
    if (callCount === 1) return { ok: true, status: 200, json: async () => page1 };
    if (callCount === 2) return { ok: true, status: 200, json: async () => page2 };
    return { ok: true, status: 200, json: async () => [] };
  };

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.tradesInserted === 102, `test2: should insert 102 trades, got ${result.tradesInserted}`);
  assert(callCount >= 2, `test2: should make at least 2 fetch calls, made ${callCount}`);

  await cleanup(store, tmpDir);
}

async function test3_429Retry(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  const tx = buildSwapTx("sigRetry1", WALLET_A, MINT_X, "buy");
  let callCount = 0;

  const mockFetch: FetchFn = async () => {
    callCount++;
    if (callCount === 1) return { ok: false, status: 429, json: async () => [] };
    return { ok: true, status: 200, json: async () => [tx] };
  };

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.walletsFailed === 0,  `test3: walletsFailed should be 0, got ${result.walletsFailed}`);
  assert(result.tradesInserted === 1, `test3: should insert 1 trade after retry, got ${result.tradesInserted}`);
  assert(callCount >= 2, `test3: should have made at least 2 calls, made ${callCount}`);

  await cleanup(store, tmpDir);
}

async function test4_duplicateSignature(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  const tx = buildSwapTx("sigDupe1", WALLET_A, MINT_X, "buy");

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [tx],
  });

  // First run: inserts
  const result1 = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);
  assert(result1.tradesInserted === 1, `test4: first insert should succeed, got ${result1.tradesInserted}`);

  // Force re-collection by resetting state (new store on same db won't skip because
  // we'll test upsertTrade directly)
  const inserted1 = store.upsertTrade({
    walletAddress: WALLET_A,
    signature: "sigDupe1",
    mint: MINT_X,
    side: "buy",
    tokenAmount: 1,
    solAmount: 1,
    usdAmount: null,
    priceUsd: null,
    priceSol: null,
    timestamp: NOW_SEC,
    program: "jupiter",
    slot: 100,
    rawJson: null,
    collectedAtMs: Date.now(),
  });
  assert(!inserted1, `test4: second upsert with same signature should return false`);

  assert(store.getTradeCount() === 1, `test4: DB should still have 1 trade, got ${store.getTradeCount()}`);

  await cleanup(store, tmpDir);
}

async function test5_lookbackCutoff(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  // Transaction older than the lookback window
  const oldTx = buildSwapTx("sigOld1", WALLET_A, MINT_X, "buy", 1_000_000, 500_000_000, OLD_SEC);

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [oldTx],
  });

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.tradesInserted === 0, `test5: old tx should not be inserted, got ${result.tradesInserted}`);

  await cleanup(store, tmpDir);
}

async function test6_nonSwapSkipped(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  const nonSwapTx = {
    signature: "sigNonSwap1",
    timestamp: NOW_SEC,
    slot: 100,
    type: "TRANSFER",   // not SWAP
    source: "SYSTEM",
    tokenTransfers: [
      { mint: MINT_X, tokenAmount: 100, fromUserAccount: WALLET_A, toUserAccount: "Other111111111111111111111111111111111111" },
    ],
    nativeTransfers: [],
    feePayer: WALLET_A,
  };

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [nonSwapTx],
  });

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.tradesInserted === 0, `test6: TRANSFER tx should be skipped, got ${result.tradesInserted}`);
  assert(result.tradesSkipped > 0,   `test6: tradesSkipped should be > 0, got ${result.tradesSkipped}`);

  await cleanup(store, tmpDir);
}

async function test7_emptyTokenTransfers(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  const txNoTransfers = {
    signature: "sigNoTransfers1",
    timestamp: NOW_SEC,
    slot: 100,
    type: "SWAP",
    source: "JUPITER",
    tokenTransfers: [],
    nativeTransfers: [],
    feePayer: WALLET_A,
  };

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [txNoTransfers],
  });

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.tradesInserted === 0, `test7: no token transfers should be skipped, got ${result.tradesInserted}`);

  await cleanup(store, tmpDir);
}

async function test8_buyDetection(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  // wallet is toUserAccount → buy
  const buyTx = buildSwapTx("sigBuy1", WALLET_A, MINT_X, "buy");

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [buyTx],
  });

  await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  const trades = store.query<{ side: string; signature: string }>(
    "SELECT side, signature FROM trades WHERE signature = 'sigBuy1'",
  );
  assert(trades.length === 1,         `test8: should have 1 trade, got ${trades.length}`);
  const trade = trades[0];
  assert(trade !== undefined,         `test8: trade should not be undefined`);
  assert(trade.side === "buy",        `test8: side should be 'buy', got '${trade.side}'`);

  await cleanup(store, tmpDir);
}

async function test9_sellDetection(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  // wallet is fromUserAccount → sell
  const sellTx = buildSwapTx("sigSell1", WALLET_A, MINT_X, "sell");

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [sellTx],
  });

  await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  const trades = store.query<{ side: string }>(
    "SELECT side FROM trades WHERE signature = 'sigSell1'",
  );
  assert(trades.length === 1,         `test9: should have 1 trade, got ${trades.length}`);
  const trade = trades[0];
  assert(trade !== undefined,         `test9: trade should not be undefined`);
  assert(trade.side === "sell",       `test9: side should be 'sell', got '${trade.side}'`);

  await cleanup(store, tmpDir);
}

async function test10_wsolOnlySkipped(): Promise<void> {
  const { store, tmpDir } = await makeStore([WALLET_A]);

  // Transfer only involves WSOL → should be skipped
  const wsolTx = {
    signature: "sigWsol1",
    timestamp: NOW_SEC,
    slot: 100,
    type: "SWAP",
    source: "JUPITER",
    tokenTransfers: [
      {
        mint: SOL_MINT,  // WSOL
        tokenAmount: 1_000_000,
        fromUserAccount: "OtherAccount111111111111111111111111111111",
        toUserAccount: WALLET_A,
      },
    ],
    nativeTransfers: [
      { amount: 500_000_000, fromUserAccount: WALLET_A, toUserAccount: "OtherAccount111111111111111111111111111111" },
    ],
    feePayer: WALLET_A,
  };

  const mockFetch: FetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => [wsolTx],
  });

  const result = await collectTradeHistory(BASE_CFG, store, logger, mockFetch);

  assert(result.tradesInserted === 0, `test10: WSOL-only transfer should be skipped, got ${result.tradesInserted}`);

  await cleanup(store, tmpDir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["1. Happy path: 2 wallets × 2 swaps → 4 trades inserted",              test1_happyPath],
    ["2. Pagination: page1=100 + page2=2 → 102 trades",                     test2_pagination],
    ["3. 429 retry: first call 429, second succeeds → inserted, no crash",   test3_429Retry],
    ["4. Duplicate signature: second upsertTrade returns false",             test4_duplicateSignature],
    ["5. Lookback cutoff: tx older than lookback → not inserted",            test5_lookbackCutoff],
    ["6. Non-SWAP tx (type=TRANSFER) → skipped",                            test6_nonSwapSkipped],
    ["7. Empty tokenTransfers → skipped",                                    test7_emptyTokenTransfers],
    ["8. Buy detection: wallet is toUserAccount → side='buy'",               test8_buyDetection],
    ["9. Sell detection: wallet is fromUserAccount → side='sell'",           test9_sellDetection],
    ["10. WSOL-only transfer → skipped (no non-WSOL mint)",                  test10_wsolOnlySkipped],
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
    console.log("Trade history check: ok");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
