/**
 * Position-safe Charon restart via PM2.
 *
 * Polls dry_run_positions WHERE status='open' every --poll-interval-sec seconds.
 * Restarts Charon via `pm2 restart charon` only when 0 positions are open.
 * Gives up after --max-wait-minutes and exits with code 3.
 *
 * Does not modify position state, touch .env, secrets, wallet keys, or trading APIs.
 *
 * Usage:
 *   node scripts/safe_restart_charon.js --dry-run
 *   node scripts/safe_restart_charon.js --max-wait-minutes=30
 *   node scripts/safe_restart_charon.js --charon-db=/path/to/charon.sqlite
 *
 * Exit codes:
 *   0 — restarted (or dry-run would restart)
 *   1 — error
 *   3 — skipped (positions still open after max wait)
 */

import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CHARON_DB = path.join(REPO_ROOT, 'charon.sqlite');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const raw = argValue(name, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function openPositionCount(db) {
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='dry_run_positions'"
  ).get();
  if (!tableExists) return 0;
  return db.prepare(
    'SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?'
  ).get('open').count;
}

async function main() {
  const charonDbPath = path.resolve(
    argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB)
  );
  const maxWaitMs = argNumber('max-wait-minutes', 30) * 60 * 1000;
  const pollMs = argNumber('poll-interval-sec', 30) * 1000;
  const dryRun = hasFlag('dry-run');

  if (!fs.existsSync(charonDbPath)) {
    throw new Error(`Charon DB not found: ${charonDbPath}`);
  }

  const db = new Database(charonDbPath, { readonly: true, fileMustExist: true });
  const startedAt = Date.now();

  let count = openPositionCount(db);

  while (count > 0) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      console.log(`[safe-restart] max wait exceeded, ${count} position(s) still open, skipping restart`);
      db.close();
      process.exit(3);
    }
    const remaining = Math.round((maxWaitMs - elapsed) / 1000);
    console.log(`[safe-restart] ${count} open position(s), waiting ${pollMs / 1000}s... (${Math.round(elapsed / 1000)}s elapsed, ${remaining}s remaining)`);
    await sleep(pollMs);
    count = openPositionCount(db);
  }

  db.close();

  if (dryRun) {
    console.log(`[safe-restart] DRY RUN — 0 open positions, would restart charon`);
    process.exit(0);
  }

  console.log(`[safe-restart] 0 open positions, restarting charon...`);
  try {
    execSync('pm2 restart charon', { stdio: 'inherit' });
    console.log(`[safe-restart] charon restarted at ${new Date().toISOString()}`);
  } catch (err) {
    console.error(`[safe-restart] pm2 restart failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error(`[safe-restart] ERROR: ${err.message}`);
  process.exit(1);
});
