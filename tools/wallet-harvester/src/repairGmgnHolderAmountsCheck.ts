// ---------------------------------------------------------------------------
// Wallet Harvester — GMGN Holder Amount Repair Check (zero live calls)
//
// Usage:
//   npx tsx src/repairGmgnHolderAmountsCheck.ts
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { repairGmgnHolderAmounts } from "./repairGmgnHolderAmounts.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

async function main(): Promise<void> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmgn-holder-repair-check-"));
  const dbPath = path.join(tmpDir, "harvester.db");
  const db = new Database(dbPath);

  try {
    db.exec(`
      CREATE TABLE sightings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wallet_address TEXT NOT NULL,
        mint TEXT NOT NULL,
        action TEXT NOT NULL,
        amount_usd REAL,
        token_mcap_usd REAL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        signal_type TEXT,
        run_id TEXT NOT NULL
      );
    `);

    const insert = db.prepare(`
      INSERT INTO sightings (wallet_address, mint, action, amount_usd, token_mcap_usd, timestamp, source, signal_type, run_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("wallet-a", "mint-a", "hold", 0, 100000, 1, "gmgn", "smart_degen_holder", "run-1");
    insert.run("wallet-b", "mint-b", "hold", 0, 100000, 2, "gmgn", "renowned_holder", "run-1");
    insert.run("wallet-c", "mint-c", "buy", 0, 100000, 3, "gmgn", "smart_degen_trader", "run-1");
    insert.run("wallet-d", "mint-d", "hold", 0, 100000, 4, "okx", "smart_money_holder", "run-1");
    insert.run("wallet-e", "mint-e", "hold", 12, 100000, 5, "gmgn", "smart_degen_holder", "run-1");

    const dryRun = repairGmgnHolderAmounts({ dbPath, commit: false, sampleLimit: 10 });
    assert(dryRun.affected === 2, `dry-run should find 2 affected rows, got ${dryRun.affected}`);
    assert(dryRun.sample.length === 2, `dry-run sample should return 2 rows, got ${dryRun.sample.length}`);

    const dryRunZeroes = db.prepare("SELECT COUNT(*) AS count FROM sightings WHERE amount_usd = 0").get() as { count: number };
    assert(dryRunZeroes.count === 4, `dry-run should not mutate rows, got ${dryRunZeroes.count} zero rows`);

    const committed = repairGmgnHolderAmounts({ dbPath, commit: true, sampleLimit: 10 });
    assert(committed.affected === 2, `commit should repair 2 rows, got ${committed.affected}`);

    const repaired = db.prepare(`
      SELECT
        SUM(CASE WHEN source = 'gmgn' AND signal_type LIKE '%_holder' AND amount_usd IS NULL THEN 1 ELSE 0 END) AS repaired,
        SUM(CASE WHEN source = 'gmgn' AND signal_type LIKE '%_trader' AND amount_usd = 0 THEN 1 ELSE 0 END) AS trader_zeroes,
        SUM(CASE WHEN source = 'okx' AND amount_usd = 0 THEN 1 ELSE 0 END) AS okx_zeroes,
        SUM(CASE WHEN source = 'gmgn' AND signal_type LIKE '%_holder' AND amount_usd = 12 THEN 1 ELSE 0 END) AS positive_holder_amounts
      FROM sightings
    `).get() as {
      repaired: number;
      trader_zeroes: number;
      okx_zeroes: number;
      positive_holder_amounts: number;
    };

    assert(repaired.repaired === 2, `should null only affected GMGN holder rows, got ${repaired.repaired}`);
    assert(repaired.trader_zeroes === 1, "GMGN trader zero row should be unchanged");
    assert(repaired.okx_zeroes === 1, "OKX zero row should be unchanged");
    assert(repaired.positive_holder_amounts === 1, "positive holder amount should be unchanged");
  } finally {
    db.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  console.log("GMGN holder amount repair checks passed");
}

await main();
