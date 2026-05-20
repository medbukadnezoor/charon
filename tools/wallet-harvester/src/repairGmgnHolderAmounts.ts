// ---------------------------------------------------------------------------
// Wallet Harvester — Repair GMGN Holder Amounts
//
// Usage:
//   npx tsx src/repairGmgnHolderAmounts.ts
//   npx tsx src/repairGmgnHolderAmounts.ts --commit
//
// Dry-run-first repair for historical GMGN holder sightings where older
// extractor code stored unavailable holder amounts as real zeroes.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

interface RepairOptions {
  dbPath: string;
  commit: boolean;
  sampleLimit: number;
}

interface CountRow {
  affected: number;
}

interface SampleRow {
  id: number;
  wallet_address: string;
  mint: string;
  signal_type: string | null;
  timestamp: number;
  run_id: string;
}

function parseStringArg(name: string): string | null {
  const prefix = `--${name}=`;
  const match = process.argv.find(arg => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function parseIntArg(name: string, fallback: number): number {
  const raw = parseStringArg(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function defaultDbPath(): string {
  return path.resolve(PROJECT_ROOT, "data", "harvester.db");
}

function loadOptions(): RepairOptions {
  return {
    dbPath: parseStringArg("db") ?? process.env.HARVESTER_DB_PATH ?? defaultDbPath(),
    commit: process.argv.includes("--commit"),
    sampleLimit: parseIntArg("sample-limit", 10),
  };
}

export function repairGmgnHolderAmounts(options: RepairOptions): {
  dbPath: string;
  commit: boolean;
  affected: number;
  sample: SampleRow[];
} {
  if (!fs.existsSync(options.dbPath)) {
    throw new Error(`Harvester DB not found: ${options.dbPath}`);
  }

  const db = new Database(options.dbPath);
  try {
    const whereClause = `
      source = 'gmgn'
      AND amount_usd = 0
      AND signal_type IS NOT NULL
      AND signal_type LIKE '%\\_holder' ESCAPE '\\'
    `;

    const affectedRow = db.prepare(`SELECT COUNT(*) AS affected FROM sightings WHERE ${whereClause}`).get() as CountRow;
    const sample = db.prepare(`
      SELECT id, wallet_address, mint, signal_type, timestamp, run_id
      FROM sightings
      WHERE ${whereClause}
      ORDER BY id ASC
      LIMIT ?
    `).all(options.sampleLimit) as SampleRow[];

    if (options.commit && affectedRow.affected > 0) {
      db.prepare(`UPDATE sightings SET amount_usd = NULL WHERE ${whereClause}`).run();
    }

    return {
      dbPath: options.dbPath,
      commit: options.commit,
      affected: affectedRow.affected,
      sample,
    };
  } finally {
    db.close();
  }
}

function main(): void {
  const result = repairGmgnHolderAmounts(loadOptions());
  console.log(JSON.stringify({
    ...result,
    mode: result.commit ? "committed" : "dry-run",
  }, null, 2));
}

const entrypointPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypointPath === fileURLToPath(import.meta.url)) {
  main();
}
