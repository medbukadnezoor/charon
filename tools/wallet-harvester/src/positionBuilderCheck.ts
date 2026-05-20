// ---------------------------------------------------------------------------
// Wallet Harvester — Position Builder Check (zero live calls)
//
// Usage:
//   npm run harvest:positions-check
//
// Validates all core behaviours of positionBuilder.ts using an in-memory
// SQLite store. No API calls are made.
// ---------------------------------------------------------------------------

import pino from "pino";
import { HarvesterStore } from "./store.js";
import { buildPositions } from "./positionBuilder.js";
import type { TradeRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Assertion helper
// ---------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

function assertClose(a: number, b: number, tol: number, message: string): void {
  if (Math.abs(a - b) > tol) {
    throw new Error(`ASSERTION FAILED: ${message} (got ${a}, expected ~${b}, tol ${tol})`);
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WALLET_A = "WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINT_X   = "MintXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
const MINT_Y   = "MintYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";

const logger = pino({ level: "silent" });
const CFG = { rateLimitMs: 0 };

// ---------------------------------------------------------------------------
// Store factory — in-memory DB
// ---------------------------------------------------------------------------

function makeStore(): HarvesterStore {
  return new HarvesterStore(":memory:");
}

// ---------------------------------------------------------------------------
// Trade seeder helpers
// ---------------------------------------------------------------------------

let sigCounter = 0;

function seedTrade(
  store: HarvesterStore,
  overrides: Partial<TradeRecord> & { walletAddress: string; mint: string; side: "buy" | "sell"; tokenAmount: number; solAmount: number; timestamp: number },
): void {
  sigCounter++;
  store.upsertTrade({
    walletAddress: overrides.walletAddress,
    signature: `sig${sigCounter.toString().padStart(6, "0")}`,
    mint: overrides.mint,
    side: overrides.side,
    tokenAmount: overrides.tokenAmount,
    solAmount: overrides.solAmount,
    usdAmount: null,
    priceUsd: null,
    priceSol: overrides.solAmount / overrides.tokenAmount,
    timestamp: overrides.timestamp,
    program: "test",
    slot: sigCounter,
    rawJson: null,
    collectedAtMs: Date.now(),
  });
}

// ---------------------------------------------------------------------------
// Test 1: Single entry, single exit — 1 buy, 1 sell covering all tokens
// ---------------------------------------------------------------------------

async function test1_singleEntrySingleExit(): Promise<void> {
  const store = makeStore();
  const T = 1_000_000;

  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 100, solAmount: 1.2, timestamp: T + 3600 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test1: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assert(pos.status === "closed", `test1: expected status='closed', got '${pos.status}'`);
  assert(pos.is_full_exit === 1, `test1: expected is_full_exit=1, got ${pos.is_full_exit}`);
  assert(pos.entry_count === 1, `test1: expected entry_count=1, got ${pos.entry_count}`);
  assert(pos.exit_count === 1, `test1: expected exit_count=1, got ${pos.exit_count}`);
  assertClose(pos.realized_sol as number, 0.2, 0.0001, "test1: realized_sol");
  assertClose(pos.realized_pct as number, 20, 0.01, "test1: realized_pct");

  store.close();
}

// ---------------------------------------------------------------------------
// Test 2: DCA entry — 2 buys at similar price (<20% spread), 1 full sell
// ---------------------------------------------------------------------------

async function test2_dcaEntry(): Promise<void> {
  const store = makeStore();
  const T = 2_000_000;

  // price 0.01 SOL/token both buys — identical, so clearly within 20%
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T + 1000 });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 200, solAmount: 2.4, timestamp: T + 7200 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test2: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assert(pos.is_dca === 1, `test2: expected is_dca=1, got ${pos.is_dca}`);
  assert(pos.is_scale_in === 0, `test2: expected is_scale_in=0, got ${pos.is_scale_in}`);
  assert(pos.entry_count === 2, `test2: expected entry_count=2, got ${pos.entry_count}`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 3: Scale-in entry — 2 buys at ascending prices (second >20% higher)
// ---------------------------------------------------------------------------

async function test3_scaleInEntry(): Promise<void> {
  const store = makeStore();
  const T = 3_000_000;

  // First buy: 100 tokens for 1.0 SOL → price=0.01
  // Second buy: 100 tokens for 1.5 SOL → price=0.015 (50% higher)
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.5, timestamp: T + 1000 });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 200, solAmount: 3.2, timestamp: T + 7200 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test3: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assert(pos.is_scale_in === 1, `test3: expected is_scale_in=1, got ${pos.is_scale_in}`);
  assert(pos.is_dca === 0, `test3: expected is_dca=0, got ${pos.is_dca}`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 4: Partial TP — 1 buy, 2 sells covering 40% and 60%
// ---------------------------------------------------------------------------

async function test4_partialTp(): Promise<void> {
  const store = makeStore();
  const T = 4_000_000;

  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 40, solAmount: 0.5, timestamp: T + 3600 });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 60, solAmount: 0.8, timestamp: T + 7200 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test4: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assert(pos.is_partial_tp === 1, `test4: expected is_partial_tp=1, got ${pos.is_partial_tp}`);
  assert(pos.exit_count === 2, `test4: expected exit_count=2, got ${pos.exit_count}`);
  assert(pos.is_full_exit === 1, `test4: expected is_full_exit=1, got ${pos.is_full_exit}`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 5: Re-entry after full exit — 2 separate positions on same token
// ---------------------------------------------------------------------------

async function test5_reEntryAfterFullExit(): Promise<void> {
  const store = makeStore();
  const T = 5_000_000;

  // Position 1
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 100, solAmount: 1.2, timestamp: T + 3600 });
  // Position 2 — new entry after full exit
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 200, solAmount: 2.0, timestamp: T + 10000 });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 200, solAmount: 2.6, timestamp: T + 20000 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions ORDER BY first_entry_ts ASC");
  assert(positions.length === 2, `test5: expected 2 positions, got ${positions.length}`);
  assert(positions[0]!.status === "closed", `test5: pos[0] should be closed`);
  assert(positions[1]!.status === "closed", `test5: pos[1] should be closed`);
  // First positions entry should be at T, second at T+10000
  assert(positions[0]!.first_entry_ts === T, `test5: first entry ts mismatch`);
  assert(positions[1]!.first_entry_ts === T + 10000, `test5: second entry ts mismatch`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 6: Open position — 1 buy, no sells
// ---------------------------------------------------------------------------

async function test6_openPosition(): Promise<void> {
  const store = makeStore();
  const T = 6_000_000;

  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test6: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assert(pos.status === "open", `test6: expected status='open', got '${pos.status}'`);
  assert(pos.is_full_exit === 0, `test6: expected is_full_exit=0, got ${pos.is_full_exit}`);
  assert(pos.exit_count === 0, `test6: expected exit_count=0, got ${pos.exit_count}`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 7: Dust tolerance — 1 buy of 100 tokens, 1 sell of 96 tokens (96%)
// ---------------------------------------------------------------------------

async function test7_dustTolerance(): Promise<void> {
  const store = makeStore();
  const T = 7_000_000;

  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 96, solAmount: 1.15, timestamp: T + 3600 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test7: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assert(pos.is_full_exit === 1, `test7: expected is_full_exit=1 (96% >= 95%), got ${pos.is_full_exit}`);
  assert(pos.status === "closed", `test7: expected status='closed', got '${pos.status}'`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 8: Sells exceed buys — transfer-in scenario, no crash
// ---------------------------------------------------------------------------

async function test8_sellsExceedBuys(): Promise<void> {
  const store = makeStore();
  const T = 8_000_000;

  // Wallet receives tokens via airdrop (no buy) then sells
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 100, solAmount: 1.0, timestamp: T + 3600 });

  // Should not crash
  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  // We should get at least 1 position (synthetic open from sells-exceed-buys)
  assert(positions.length >= 1, `test8: expected at least 1 position, got ${positions.length}`);

  store.close();
}

// ---------------------------------------------------------------------------
// Test 9: Avg entry price — VWAP calculation
// ---------------------------------------------------------------------------

async function test9_avgEntryPrice(): Promise<void> {
  const store = makeStore();
  const T = 9_000_000;

  // Buy 1: 10 tokens for 0.1 SOL → price = 0.01
  // Buy 2: 20 tokens for 0.4 SOL → price = 0.02
  // VWAP = (0.1 + 0.4) / (10 + 20) = 0.5 / 30 = 0.016667
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 10, solAmount: 0.1, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 20, solAmount: 0.4, timestamp: T + 1000 });
  // Leave open (no sells)

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions");
  assert(positions.length === 1, `test9: expected 1 position, got ${positions.length}`);
  const pos = positions[0]!;
  assertClose(pos.avg_entry_price as number, 0.016667, 0.0001, "test9: avg_entry_price");
  assertClose(pos.total_sol_in as number, 0.5, 0.0001, "test9: total_sol_in");
  assertClose(pos.total_token_in as number, 30, 0.0001, "test9: total_token_in");

  store.close();
}

// ---------------------------------------------------------------------------
// Test 10: Multiple tokens per wallet — 2 separate positions
// ---------------------------------------------------------------------------

async function test10_multipleTokensPerWallet(): Promise<void> {
  const store = makeStore();
  const T = 10_000_000;

  // Token X
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "buy", tokenAmount: 100, solAmount: 1.0, timestamp: T });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_X, side: "sell", tokenAmount: 100, solAmount: 1.2, timestamp: T + 3600 });

  // Token Y
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_Y, side: "buy", tokenAmount: 500, solAmount: 2.0, timestamp: T + 100 });
  seedTrade(store, { walletAddress: WALLET_A, mint: MINT_Y, side: "sell", tokenAmount: 500, solAmount: 2.5, timestamp: T + 7200 });

  await buildPositions(CFG, store, logger);

  const positions = store.query<Record<string, unknown>>("SELECT * FROM positions ORDER BY mint ASC");
  assert(positions.length === 2, `test10: expected 2 positions, got ${positions.length}`);
  const mints = new Set(positions.map(p => p.mint as string));
  assert(mints.has(MINT_X), `test10: expected position for MINT_X`);
  assert(mints.has(MINT_Y), `test10: expected position for MINT_Y`);
  assert(positions[0]!.wallet_address === WALLET_A, `test10: wallet_address mismatch`);
  assert(positions[1]!.wallet_address === WALLET_A, `test10: wallet_address mismatch`);

  store.close();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["1. Single entry, single exit → 1 closed position, correct PnL",                        test1_singleEntrySingleExit],
    ["2. DCA entry: 2 buys at same price, 1 sell → is_dca=1, is_scale_in=0",                 test2_dcaEntry],
    ["3. Scale-in entry: 2 buys at ascending prices (>20% higher) → is_scale_in=1",          test3_scaleInEntry],
    ["4. Partial TP: 1 buy, 2 sells → is_partial_tp=1, exit_count=2, is_full_exit=1",        test4_partialTp],
    ["5. Re-entry after full exit → 2 separate positions on same token",                      test5_reEntryAfterFullExit],
    ["6. Open position: 1 buy, no sells → status='open', is_full_exit=0",                    test6_openPosition],
    ["7. Dust tolerance: 96% sold → is_full_exit=1 (≥95% threshold)",                        test7_dustTolerance],
    ["8. Sells exceed buys (transfer-in scenario) → no crash, position tracked",              test8_sellsExceedBuys],
    ["9. Avg entry price: VWAP of 2 buys (0.5 SOL / 30 tokens = 0.01667)",                   test9_avgEntryPrice],
    ["10. Multiple tokens per wallet → 2 separate positions, one per token",                  test10_multipleTokensPerWallet],
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
    console.log("Position builder check: ok");
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
