#!/usr/bin/env node
// deploy_runner_capture_config.js
// Deploys the OHLCV-enhanced runner capture strategy parameters.
// Usage: node scripts/deploy_runner_capture_config.js [--db=/path/to/db] [--dry-run]

import Database from 'better-sqlite3';
import { resolve } from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbFlag = args.find(a => a.startsWith('--db='));
const dbPath = dbFlag ? dbFlag.split('=')[1] : '/opt/trading-data/charon.sqlite';

const RUNNER_CAPTURE_CONFIG = {
  // TP/SL (validated by data: 80% win rate at +200%, 65% at +300%)
  tp_percent: 300,
  sl_percent: -60,

  // Breakeven drift
  breakeven_after_profit_percent: 20,
  breakeven_lock_percent: 0,

  // Trailing (disabled v1)
  trailing_enabled: false,

  // Soft cutoff (OHLCV-based hold/cut at time limit)
  soft_cutoff_ms: 14400000,           // 4 hours
  soft_cutoff_recheck_ms: 3600000,    // 1 hour between rechecks
  soft_cutoff_max_rechecks: 3,        // max 3 rechecks (7h total max hold)
  soft_cutoff_ohlcv_interval: '5m',   // 5-minute candles for cutoff analysis
  soft_cutoff_ohlcv_count: 30,        // 2.5h lookback

  // Entry confirmation (OHLCV-based local-top rejection)
  entry_confirm_ohlcv_interval: '1m',
  entry_confirm_ohlcv_count: 15,
  entry_confirm_max_rsi: 70,

  // Filter relaxation for runner capture
  max_top20_holder_percent: 45,       // was 30, recovers 11 runners
  min_fee_claim_sol: 0.50,            // was 0.75, recovers 6 runners

  // Fee-claim secondary path (alt gate)
  require_fee_claim: false,               // replaced by alt gate logic
  fee_claim_alt_gate_enabled: true,       // enable secondary path
  fee_claim_alt_threshold: 40,            // min alt quality score to proceed
  fee_claim_alt_min_saved_wallet_holders: 2,
  fee_claim_alt_max_top20_holder_percent: 40,
  fee_claim_alt_min_source_count: 2,

  // Re-entry rule
  reentry_enabled: true,
  reentry_window_ms: 86400000,      // 24h watch window after SL
  reentry_min_mcap_recovery: 1.0,   // must recover to >= entry mcap
  reentry_max_per_mint: 1,          // only re-enter once per mint per window
};

const GLOBAL_SETTINGS = {
  entry_confirm_enabled: 'true',
};

console.log(`Runner Capture Config Deployment`);
console.log(`DB: ${dbPath}`);
console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE WRITE'}`);
console.log('');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Read current sniper config
const row = db.prepare("SELECT config_json FROM strategies WHERE id = 'sniper'").get();
if (!row) {
  console.error('ERROR: sniper strategy not found in DB');
  db.close();
  process.exit(1);
}

const currentConfig = JSON.parse(row.config_json);
console.log('Current sniper config (relevant keys):');
for (const [key, newVal] of Object.entries(RUNNER_CAPTURE_CONFIG)) {
  const oldVal = currentConfig[key];
  const changed = JSON.stringify(oldVal) !== JSON.stringify(newVal);
  console.log(`  ${key}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}${changed ? ' [CHANGE]' : ''}`);
}

// Merge new config
const mergedConfig = { ...currentConfig, ...RUNNER_CAPTURE_CONFIG };

if (!dryRun) {
  db.prepare("UPDATE strategies SET config_json = ? WHERE id = 'sniper'")
    .run(JSON.stringify(mergedConfig));
  console.log('\n✓ Sniper strategy config_json updated.');
} else {
  console.log('\n[DRY RUN] Would update sniper strategy config_json.');
}

// Global settings
console.log('\nGlobal settings:');
for (const [key, value] of Object.entries(GLOBAL_SETTINGS)) {
  const existing = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  const oldVal = existing?.value ?? '(not set)';
  const changed = oldVal !== value;
  console.log(`  ${key}: ${oldVal} → ${value}${changed ? ' [CHANGE]' : ''}`);

  if (!dryRun) {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}

if (!dryRun) {
  console.log('✓ Global settings updated.');
} else {
  console.log('[DRY RUN] Would update global settings.');
}

db.close();
console.log('\nDone.');
