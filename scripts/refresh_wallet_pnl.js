/**
 * Refresh harvester wallet PnL snapshots from Jupiter's public PnL endpoint.
 *
 * Batches up to --batch-size addresses per request at --rate req/sec.
 * Writes refreshed PnL to both harvester DB and Charon saved_wallets (jup_* columns).
 * Dry-run by default — pass --commit to write.
 *
 * This script does not read Charon .env, start Charon, touch Telegram, or use wallet keys.
 *
 * Usage:
 *   node scripts/refresh_wallet_pnl.js --limit=50 --dry-run
 *   node scripts/refresh_wallet_pnl.js --limit=50 --commit
 *   node scripts/refresh_wallet_pnl.js --batch-size=5 --rate=2 --limit=100 --commit
 *   HARVESTER_DB_PATH=/opt/data/harvester.db node scripts/refresh_wallet_pnl.js --limit=100 --commit
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Local dev default; override with HARVESTER_DB_PATH or --harvester-db for VPS/CI layouts.
const DEFAULT_HARVESTER_DB = path.join(REPO_ROOT, 'tools/wallet-harvester/data/harvester.db');
const DEFAULT_CHARON_DB = path.join(REPO_ROOT, 'charon.sqlite');
const JUPITER_PNL_URL = 'https://datapi.jup.ag/v1/pnl';

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const parsed = Number(argValue(name, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Jupiter PnL helpers
// ---------------------------------------------------------------------------

function extractWalletSummary(payload, address) {
  const row = payload?.[address] ?? payload?.data?.[address] ?? payload;
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;

  const totalTrades = Number(row.totalTrades ?? row.total_trades ?? 0);
  const wins = Number(row.wins ?? row.winCount ?? row.win_count ?? 0);
  const winRate = Number(row.winRate ?? row.win_rate ?? (totalTrades > 0 ? wins / totalTrades : 0));
  const totalPnlUsd = Number(row.totalPnlUsd ?? row.total_pnl_usd ?? row.totalPnl ?? row.pnlUsd ?? 0);

  return {
    totalTrades: Number.isFinite(totalTrades) ? totalTrades : 0,
    wins: Number.isFinite(wins) ? wins : 0,
    winRate: Number.isFinite(winRate) ? winRate : null,
    pnlUsd: Number.isFinite(totalPnlUsd) ? totalPnlUsd : null,
  };
}

async function fetchBatchPnl(addresses) {
  const url = new URL(JUPITER_PNL_URL);
  url.searchParams.set('addresses', addresses.join(','));
  url.searchParams.set('includeClosed', 'false');

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 429) {
    const resetHeader = Number(res.headers.get('x-ratelimit-reset') || 0);
    const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
    const retryAfterMs = Number(res.headers.get('retry-after') || 0) * 1000;
    const backoffMs = Math.max(
      retryAfterMs,
      resetMs > Date.now() ? resetMs - Date.now() : 0,
      30_000,
    );
    return { rateLimited: true, backoffMs };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  }

  const data = await res.json();
  const results = {};
  for (const address of addresses) {
    results[address] = extractWalletSummary(data, address);
  }
  return { results };
}

// ---------------------------------------------------------------------------
// Wallet selection
// ---------------------------------------------------------------------------

function selectWallets(db, limit, maxFreshAgeMs) {
  const freshCutoff = Date.now() - maxFreshAgeMs;
  return db.prepare(`
    SELECT address, pnl_snapshot_at
    FROM wallets
    WHERE pnl_snapshot_at IS NULL OR pnl_snapshot_at < ?
    ORDER BY
      CASE WHEN pnl_snapshot_at IS NULL THEN 0 ELSE 1 END,
      pnl_snapshot_at ASC,
      last_seen DESC
    LIMIT ?
  `).all(freshCutoff, limit);
}

// ---------------------------------------------------------------------------
// Priority queue
// ---------------------------------------------------------------------------

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

function prioritizeWallets(wallets, charonRows) {
  const priority = (w) => {
    const charon = charonRows.get(w.address);
    if (charon?.owner_label) return 0;
    if (charon?.tier === 'A' || charon?.tier === 'B') return 2;
    const tags = parseTags(charon?.tags_json);
    if (tags.some(t => /kol|renowned|influencer|caller|alpha/i.test(t))) return 3;
    const wr = Number(charon?.gmgn_winrate ?? charon?.okx_winrate ?? 0);
    if (wr > 0.5) return 4;
    return 5;
  };
  return [...wallets].sort((a, b) => priority(a) - priority(b));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const harvesterDbPath = path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB));
  const charonDbPath = path.resolve(argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB));
  const limit = Math.floor(argNumber('limit', 100));
  const batchSize = Math.min(10, Math.max(1, Math.floor(argNumber('batch-size', 5))));
  const rate = Math.max(0.1, argNumber('rate', 2));
  const batchDelayMs = Math.floor(1000 / rate);
  const hasRate = process.argv.some(a => a.startsWith('--rate='));
  const minIntervalMs = hasRate ? batchDelayMs : Math.floor(argNumber('min-interval-ms', batchDelayMs));
  const maxFreshAgeMs = Math.floor(argNumber('fresh-hours', 24)) * 60 * 60 * 1000;
  const dryRun = !hasFlag('commit');

  if (!fs.existsSync(harvesterDbPath)) {
    throw new Error(`Harvester DB not found: ${harvesterDbPath}`);
  }

  // Open harvester DB
  const harvDb = new Database(harvesterDbPath);
  const rawWallets = selectWallets(harvDb, limit, maxFreshAgeMs);

  // Load Charon saved_wallets for priority + write-back (graceful if missing)
  let charonDb = null;
  let charonRows = new Map();
  let charonHasJupCols = false;
  if (fs.existsSync(charonDbPath)) {
    try {
      charonDb = new Database(charonDbPath);
      const rows = charonDb.prepare('SELECT * FROM saved_wallets').all();
      charonRows = new Map(rows.map(r => [r.address, r]));
      const cols = charonDb.prepare('PRAGMA table_info(saved_wallets)').all().map(r => r.name);
      charonHasJupCols = cols.includes('jup_total_pnl');
    } catch (err) {
      console.log(`[pnl-refresh] Charon DB open skipped: ${err.message}`);
      charonDb = null;
    }
  }

  // Apply priority queue
  const wallets = prioritizeWallets(rawWallets, charonRows);

  // Prepare DB statements
  const harvUpdate = harvDb.prepare(`
    UPDATE wallets
    SET pnl_usd = COALESCE(?, pnl_usd),
        win_rate = COALESCE(?, win_rate),
        pnl_snapshot_at = ?
    WHERE address = ?
  `);

  const charonUpdate = (charonDb && charonHasJupCols)
    ? charonDb.prepare(`
        UPDATE saved_wallets
        SET jup_total_pnl    = COALESCE(?, jup_total_pnl),
            jup_winrate      = COALESCE(?, jup_winrate),
            jup_total_trades = COALESCE(?, jup_total_trades),
            jup_snapshot_at  = ?
        WHERE address = ?
      `)
    : null;

  const totalBatches = Math.ceil(wallets.length / batchSize);

  console.log(`Refreshing ${wallets.length} wallets in ${totalBatches} batches (size=${batchSize}, rate=${rate}/s, delay=${minIntervalMs}ms)`);
  console.log(`Mode: ${dryRun ? 'dry-run' : 'commit'}; fresh-hours=${maxFreshAgeMs / 3_600_000}`);
  if (charonDb && charonHasJupCols) {
    console.log(`Charon write-back: enabled (${charonDbPath})`);
  } else if (charonDb) {
    console.log(`Charon write-back: skipped (jup columns not found — run M5-1 migration first)`);
  } else {
    console.log(`Charon write-back: skipped (DB not found at ${charonDbPath})`);
  }

  let updated = 0;
  let noData = 0;
  let errors = 0;
  let rateLimits = 0;

  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = wallets.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
    const addresses = batch.map(w => w.address);
    const batchLabel = `[batch ${batchIdx + 1}/${totalBatches}]`;

    let result;
    while (true) {
      result = await fetchBatchPnl(addresses);
      if (!result.rateLimited) break;
      rateLimits++;
      console.log(`${batchLabel} 429 backing off ${Math.ceil(result.backoffMs / 1000)}s`);
      await sleep(result.backoffMs);
    }

    if (result.error) {
      errors += batch.length;
      console.log(`${batchLabel} error: ${result.error}`);
    } else {
      const snapshotAt = Date.now();
      for (const wallet of batch) {
        const summary = result.results[wallet.address];
        if (!summary) {
          noData++;
          console.log(`  ${wallet.address.slice(0, 8)}... no-data`);
          continue;
        }
        const { pnlUsd, winRate, totalTrades } = summary;
        if (!dryRun) {
          harvDb.transaction(() => {
            harvUpdate.run(pnlUsd, winRate, snapshotAt, wallet.address);
          })();
          if (charonUpdate && charonRows.has(wallet.address)) {
            charonDb.transaction(() => {
              charonUpdate.run(pnlUsd, winRate, totalTrades ?? null, snapshotAt, wallet.address);
            })();
          }
        }
        updated++;
        console.log(`  ${wallet.address.slice(0, 8)}... pnl=${pnlUsd ?? 'n/a'} win=${winRate ?? 'n/a'} trades=${totalTrades ?? 'n/a'}`);
      }
    }

    if (batchIdx < totalBatches - 1) await sleep(minIntervalMs);
  }

  harvDb.close();
  if (charonDb) charonDb.close();

  console.log(`\nDone: ${updated} ${dryRun ? 'would update' : 'updated'}, ${noData} no-data, ${errors} errors, ${rateLimits} rate-limit events.`);
  if (dryRun) console.log('Pass --commit to write.');
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
