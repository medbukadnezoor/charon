#!/usr/bin/env node
/**
 * DB-only readiness check for trying Charon in dry-run mode.
 *
 * This does not read .env, start Charon, call providers, call LLMs, start
 * Telegram, sign, swap, or mutate SQLite state.
 *
 * Usage:
 *   node scripts/dry_run_readiness.js
 *   DB_PATH=/opt/trading-data/charon.sqlite HARVESTER_DB_PATH=/opt/trading-data/harvester.db node scripts/dry_run_readiness.js
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasTable(db, name) {
  return Boolean(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', name));
}

function tableCount(db, name, where = '', params = []) {
  if (!hasTable(db, name)) return null;
  return db.prepare(`SELECT count(*) AS count FROM ${name} ${where}`).get(...params).count;
}

function settingsMap(db) {
  if (!hasTable(db, 'settings')) return {};
  return Object.fromEntries(db.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (
      'trading_mode',
      'agent_enabled',
      'max_open_positions',
      'dry_run_buy_sol',
      'llm_min_confidence',
      'llm_candidate_pick_count',
      'llm_candidate_max_age_ms'
    )
    ORDER BY key
  `).all().map(row => [row.key, row.value]));
}

function activeStrategy(db) {
  if (!hasTable(db, 'strategies')) return null;
  const row = db.prepare('SELECT id, name, enabled, config_json FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) return null;
  let config = {};
  try {
    config = JSON.parse(row.config_json || '{}');
  } catch {
    config = { parse_error: true };
  }
  return {
    id: row.id,
    name: row.name,
    entry_mode: config.entry_mode,
    use_llm: config.use_llm,
    position_size_sol: config.position_size_sol,
    tp_percent: config.tp_percent,
    sl_percent: config.sl_percent,
    max_open_positions: config.max_open_positions,
    key_filters: {
      require_fee_claim: config.require_fee_claim,
      min_fee_claim_sol: config.min_fee_claim_sol,
      min_gmgn_total_fee_sol: config.min_gmgn_total_fee_sol,
      min_mcap_usd: config.min_mcap_usd,
      max_mcap_usd: config.max_mcap_usd,
      min_holders: config.min_holders,
      min_saved_wallet_holders: config.min_saved_wallet_holders,
      max_ath_distance_pct: config.max_ath_distance_pct,
      trending_min_volume_usd: config.trending_min_volume_usd,
      trending_min_swaps: config.trending_min_swaps,
    },
  };
}

const charonDbPath = path.resolve(argValue('charon-db', process.env.DB_PATH || path.join(REPO_ROOT, 'charon.sqlite')));
const harvesterDbPath = path.resolve(argValue(
  'harvester-db',
  process.env.HARVESTER_DB_PATH || path.join(REPO_ROOT, 'tools/wallet-harvester/data/harvester.db'),
));

if (!fs.existsSync(charonDbPath)) throw new Error(`Charon DB not found: ${charonDbPath}`);

const charonDb = new Database(charonDbPath, { readonly: true, fileMustExist: true });
const settings = settingsMap(charonDb);
const counts = {
  saved_wallets: tableCount(charonDb, 'saved_wallets'),
  candidates: tableCount(charonDb, 'candidates'),
  dry_run_positions: tableCount(charonDb, 'dry_run_positions'),
  open_positions: tableCount(charonDb, 'dry_run_positions', 'WHERE status = ?', ['open']),
  trade_intents: tableCount(charonDb, 'trade_intents'),
  pending_trade_intents: tableCount(charonDb, 'trade_intents', 'WHERE status = ?', ['pending_confirmation']),
  decision_logs: tableCount(charonDb, 'decision_logs'),
  wallet_llm_reviews: tableCount(charonDb, 'wallet_llm_reviews'),
};
const strategy = activeStrategy(charonDb);
charonDb.close();

let harvesterCounts = null;
if (fs.existsSync(harvesterDbPath)) {
  const harvesterDb = new Database(harvesterDbPath, { readonly: true, fileMustExist: true });
  harvesterCounts = {
    wallet_profiles: tableCount(harvesterDb, 'wallet_profiles'),
    owner_labels: tableCount(harvesterDb, 'owner_labels'),
  };
  harvesterDb.close();
}

const checks = {
  trading_mode_dry_run: settings.trading_mode === 'dry_run',
  saved_wallets_present: Number(counts.saved_wallets || 0) > 0,
  harvester_metadata_present: Boolean(harvesterCounts && Number(harvesterCounts.wallet_profiles || 0) > 0),
  no_open_positions: Number(counts.open_positions || 0) === 0,
  no_pending_trade_intents: Number(counts.pending_trade_intents || 0) === 0,
  active_strategy_present: Boolean(strategy?.id),
};
const ready = Object.values(checks).every(Boolean);

console.log(JSON.stringify({
  ready_for_bounded_dry_run: ready,
  charon_db_path: charonDbPath,
  harvester_db_path: harvesterDbPath,
  checks,
  settings,
  active_strategy: strategy,
  counts,
  harvester_counts: harvesterCounts,
  blocked_scope: [
    'no env inspection performed',
    'no service start performed',
    'no Telegram start performed',
    'no provider or LLM calls performed',
    'no trading/signing/swap path performed',
  ],
}, null, 2));
