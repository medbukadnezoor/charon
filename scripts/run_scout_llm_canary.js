#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';

const DEFAULT_DB = '/var/oled/charon-data/trading-data/charon-scout.sqlite';

function usage() {
  return [
    'Usage:',
    '  node scripts/run_scout_llm_canary.js [--db=/path/charon-scout.sqlite] [--duration-min=30] [--max-calls=20]',
    '    [--poll-sec=10] [--max-open-positions=N] [--target-closed-outcomes=N]',
    '    [--scout-daily-buy-cap=N] [--scout-llm-hourly-cap=N] [--scout-llm-daily-cap=N] [--dry-run]',
    '',
    'Starts only charon-scout, stops it on polling call/time limit, restores any temporary scout max-open override,',
    'and prints scripts/scout_llm_canary_report.js for the precise canary window.',
    'Max-call enforcement is polling-based; use a shorter --poll-sec for tighter call bounds.',
    '',
    'Does not inspect or print .env, start learner, or touch main/shadow/proxy processes.',
    'Refuses to run if charon-scout-learning is still registered in PM2; delete/disable learner first.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    db: DEFAULT_DB,
    durationMin: 30,
    maxCalls: 20,
    pollSec: 10,
    maxOpenPositions: null,
    targetClosedOutcomes: null,
    scoutDailyBuyCap: null,
    scoutLlmHourlyCap: null,
    scoutLlmDailyCap: null,
    dryRun: false,
  };
  for (const arg of argv) {
    if (arg === '--dry-run') {
      opts.dryRun = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'duration-min') opts.durationMin = Number(value);
    else if (key === 'max-calls') opts.maxCalls = Number(value);
    else if (key === 'poll-sec') opts.pollSec = Number(value);
    else if (key === 'max-open-positions') opts.maxOpenPositions = Number(value);
    else if (key === 'target-closed-outcomes') opts.targetClosedOutcomes = Number(value);
    else if (key === 'scout-daily-buy-cap') opts.scoutDailyBuyCap = Number(value);
    else if (key === 'scout-llm-hourly-cap') opts.scoutLlmHourlyCap = Number(value);
    else if (key === 'scout-llm-daily-cap') opts.scoutLlmDailyCap = Number(value);
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  for (const key of ['durationMin', 'maxCalls', 'pollSec']) {
    if (!Number.isFinite(opts[key]) || opts[key] <= 0) throw new Error(`${key} must be positive`);
  }
  if (opts.maxOpenPositions != null && (!Number.isInteger(opts.maxOpenPositions) || opts.maxOpenPositions <= 0)) {
    throw new Error('--max-open-positions must be a positive integer');
  }
  if (opts.targetClosedOutcomes != null && (!Number.isInteger(opts.targetClosedOutcomes) || opts.targetClosedOutcomes <= 0)) {
    throw new Error('--target-closed-outcomes must be a positive integer');
  }
  for (const [flag, key] of [
    ['--scout-daily-buy-cap', 'scoutDailyBuyCap'],
    ['--scout-llm-hourly-cap', 'scoutLlmHourlyCap'],
    ['--scout-llm-daily-cap', 'scoutLlmDailyCap'],
  ]) {
    if (opts[key] != null && (!Number.isInteger(opts[key]) || opts[key] <= 0)) {
      throw new Error(`${flag} must be a positive integer`);
    }
  }
  if (opts.scoutDailyBuyCap != null && opts.scoutDailyBuyCap > 25) {
    throw new Error('--scout-daily-buy-cap above 25 is refused for canary runs');
  }
  if (opts.scoutLlmHourlyCap != null && opts.scoutLlmHourlyCap > 500) {
    throw new Error('--scout-llm-hourly-cap above 500 is refused for canary runs');
  }
  if (opts.scoutLlmDailyCap != null && opts.scoutLlmDailyCap > 2000) {
    throw new Error('--scout-llm-daily-cap above 2000 is refused for canary runs');
  }
  opts.db = path.resolve(opts.db);
  return opts;
}

function run(command, args, options = {}) {
  console.log(`[scout-canary] $ ${[command, ...args].join(' ')}`);
  if (options.dryRun) return '';
  return execFileSync(command, args, { stdio: options.capture ? 'pipe' : 'inherit', encoding: 'utf8' });
}

function capture(command, args) {
  return execFileSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(db, name) {
  if (!tableExists(db, name)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name));
}

function activeScoutStrategy(db) {
  if (!tableExists(db, 'strategies')) throw new Error('strategies table is missing');
  const row = db.prepare("SELECT id, name, config_json FROM strategies WHERE enabled = 1 LIMIT 1").get();
  if (!row) throw new Error('no active strategy in scout DB');
  let config = {};
  try {
    config = JSON.parse(row.config_json || '{}');
  } catch (err) {
    throw new Error(`active strategy config_json is not valid JSON: ${err.message}`);
  }
  return { row, config };
}

function pm2App(name) {
  const raw = capture('pm2', ['jlist']);
  const rows = JSON.parse(raw);
  return rows.find(row => row.name === name) || null;
}

function assertLearnerAbsent() {
  const learner = pm2App('charon-scout-learning');
  if (learner) {
    const status = learner.pm2_env?.status || 'unknown';
    throw new Error(`charon-scout-learning is present in PM2 with status=${status}; delete/disable learner before scout canary`);
  }
}

function assertScoutSafePm2Env() {
  const app = pm2App('charon-scout');
  if (!app) throw new Error('charon-scout is not present in PM2 after start');
  if (app.pm2_env?.status !== 'online') throw new Error(`charon-scout status is ${app.pm2_env?.status}, expected online`);
  const env = app.pm2_env?.env || {};
  const required = {
    INSTANCE_ID: 'scout',
    SHADOW_MODE: 'true',
    TRADING_MODE: 'dry_run',
    LIVE_EXECUTION_DISABLED: 'true',
    SCOUT_LIVE_ENABLED: 'false',
    TELEGRAM_POLLING_ENABLED: 'false',
    LLM_PROVIDER_ORDER: 'gemini,mistral',
  };
  for (const [key, value] of Object.entries(required)) {
    if (String(env[key] ?? '') !== value) {
      throw new Error(`charon-scout PM2 env ${key}=${env[key] ?? '<missing>'}, expected ${value}`);
    }
  }
  const dbPath = String(env.DB_PATH || '');
  if (!dbPath.includes('charon-scout.sqlite')) {
    throw new Error(`charon-scout DB_PATH is not a scout DB path: ${dbPath || '<missing>'}`);
  }
}

function openPositionCount(db) {
  if (!tableExists(db, 'dry_run_positions')) return 0;
  return db.prepare("SELECT COUNT(*) AS n FROM dry_run_positions WHERE status IN ('open', 'partial_exit')").get().n;
}

function closedScoutPositionCount(db) {
  const columns = tableColumns(db, 'dry_run_positions');
  if (!columns.has('status')) return 0;

  const scoutClauses = [];
  if (columns.has('strategy_id')) scoutClauses.push("strategy_id = 'scout'");
  if (columns.has('scout_policy_version_id')) scoutClauses.push('scout_policy_version_id IS NOT NULL');
  if (!scoutClauses.length) return 0;

  return db.prepare(`
    SELECT COUNT(*) AS n
    FROM dry_run_positions
    WHERE status = 'closed'
      AND (${scoutClauses.join(' OR ')})
  `).get().n;
}

function llmCallCountSince(db, sinceMs) {
  if (!tableExists(db, 'llm_usage_events')) return 0;
  return db.prepare('SELECT COUNT(*) AS n FROM llm_usage_events WHERE created_at_ms >= ?').get(sinceMs).n;
}

function setScoutConfig(db, configJson) {
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(configJson, 'scout');
}

function setScoutMaxOpen(db, value) {
  const { row, config } = activeScoutStrategy(db);
  if (row.id !== 'scout') throw new Error(`active strategy is ${row.id}, expected scout`);
  config.max_open_positions = value;
  setScoutConfig(db, JSON.stringify(config));
}

function settingRow(db, key) {
  if (!tableExists(db, 'settings')) throw new Error('settings table is missing');
  return db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key) || null;
}

function setSetting(db, key, value) {
  if (!tableExists(db, 'settings')) throw new Error('settings table is missing');
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function restoreSetting(db, key, previous) {
  if (!tableExists(db, 'settings')) throw new Error('settings table is missing');
  if (previous) {
    setSetting(db, key, previous.value);
  } else {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }
}

function applyTemporarySetting(db, overrides, key, value, max) {
  if (value == null) return;
  if (value > max) throw new Error(`--${key.replaceAll('_', '-')} above ${max} is refused for canary runs`);
  const previous = settingRow(db, key);
  console.log(`[scout-canary] temporarily setting ${key} ${previous?.value ?? '<unset>'} -> ${value}`);
  setSetting(db, key, value);
  overrides.push({ key, previous });
}

function stopScout({ dryRun = false } = {}) {
  try {
    run('pm2', ['delete', 'charon-scout'], { dryRun });
  } catch (err) {
    console.log(`[scout-canary] pm2 delete charon-scout returned non-zero: ${err.message}`);
  }
}

function printReport({ dbPath, sinceMs, dryRun }) {
  run(process.execPath, [
    'scripts/scout_llm_canary_report.js',
    `--db=${dbPath}`,
    `--since-ms=${sinceMs}`,
    '--format=text',
  ], { dryRun });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.db)) throw new Error(`Scout DB not found: ${opts.db}`);

  const db = new Database(opts.db, { fileMustExist: true });
  let originalMaxOpen = null;
  let originalScoutConfigJson = null;
  let changedMaxOpen = false;
  const temporarySettingOverrides = [];
  let startedScout = false;
  const sinceMs = Date.now();

  async function cleanup() {
    let cleanupError = null;
    try {
      if (changedMaxOpen) {
        console.log(`[scout-canary] restoring exact strategy:scout config_json with max_open_positions=${originalMaxOpen}`);
        if (!opts.dryRun) setScoutConfig(db, originalScoutConfigJson);
      }
      if (!opts.dryRun) {
        for (const override of [...temporarySettingOverrides].reverse()) {
          console.log(`[scout-canary] restoring setting ${override.key} -> ${override.previous?.value ?? '<unset>'}`);
          restoreSetting(db, override.key, override.previous);
        }
      }
    } catch (err) {
      cleanupError = err;
      console.log(`[scout-canary] config restore failed during cleanup: ${err.message}`);
    } finally {
      if (startedScout) stopScout({ dryRun: opts.dryRun });
    }

    try {
      if (!opts.dryRun) printReport({ dbPath: opts.db, sinceMs, dryRun: false });
    } finally {
      db.close();
    }

    if (cleanupError) throw cleanupError;
  }

  process.once('SIGINT', async () => {
    console.log('[scout-canary] SIGINT received; cleaning up');
    await cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', async () => {
    console.log('[scout-canary] SIGTERM received; cleaning up');
    await cleanup();
    process.exit(143);
  });

  try {
    if (!opts.dryRun) {
      const existingScout = pm2App('charon-scout');
      if (existingScout?.pm2_env?.status === 'online') {
        throw new Error('charon-scout is already online; refusing to hijack an existing scout run');
      }
      assertLearnerAbsent();
    }

    const { row, config } = activeScoutStrategy(db);
    if (row.id !== 'scout') throw new Error(`active strategy is ${row.id}, expected scout`);
    originalMaxOpen = Number(config.max_open_positions ?? 0);
    originalScoutConfigJson = row.config_json;
    const openAtStart = openPositionCount(db);
    const effectiveMaxOpen = opts.maxOpenPositions ?? originalMaxOpen;
    if (effectiveMaxOpen > 0 && openAtStart >= effectiveMaxOpen) {
      throw new Error(`scout already has ${openAtStart}/${effectiveMaxOpen} open positions; pass --max-open-positions above ${openAtStart} for a temporary canary override`);
    }
    if (opts.maxOpenPositions != null && opts.maxOpenPositions !== originalMaxOpen) {
      if (opts.maxOpenPositions > 5) throw new Error('--max-open-positions above 5 is refused for canary runs');
      console.log(`[scout-canary] temporarily setting strategy:scout.max_open_positions ${originalMaxOpen} -> ${opts.maxOpenPositions}`);
      if (!opts.dryRun) setScoutMaxOpen(db, opts.maxOpenPositions);
      changedMaxOpen = true;
    }
    if (!opts.dryRun) {
      applyTemporarySetting(db, temporarySettingOverrides, 'scout_daily_buy_cap', opts.scoutDailyBuyCap, 25);
      applyTemporarySetting(db, temporarySettingOverrides, 'scout_llm_hourly_cap', opts.scoutLlmHourlyCap, 500);
      applyTemporarySetting(db, temporarySettingOverrides, 'scout_llm_daily_cap', opts.scoutLlmDailyCap, 2000);
    }

    const closedAtStart = closedScoutPositionCount(db);
    if (opts.targetClosedOutcomes != null) {
      console.log(`[scout-canary] closed_outcomes current=${closedAtStart} target=${opts.targetClosedOutcomes}`);
      if (closedAtStart >= opts.targetClosedOutcomes) {
        console.log(`[scout-canary] target closed outcome count already reached (${closedAtStart}/${opts.targetClosedOutcomes}); not starting scout`);
        return;
      }
    }

    console.log(`[scout-canary] start_ms=${sinceMs}`);
    console.log(`[scout-canary] limits duration=${opts.durationMin}m max_calls=${opts.maxCalls} poll=${opts.pollSec}s`);
    run('pm2', ['start', 'ecosystem.config.cjs', '--only', 'charon-scout', '--update-env'], { dryRun: opts.dryRun });
    startedScout = true;

    if (opts.dryRun) {
      console.log('[scout-canary] dry-run complete; scout was not started');
      return;
    }
    assertScoutSafePm2Env();

    const deadline = sinceMs + opts.durationMin * 60_000;
    while (Date.now() < deadline) {
      await sleep(opts.pollSec * 1000);
      const calls = llmCallCountSince(db, sinceMs);
      const open = openPositionCount(db);
      const closed = closedScoutPositionCount(db);
      console.log(`[scout-canary] progress calls=${calls}/${opts.maxCalls} open_positions=${open} closed_count=${closed}`);
      if (opts.targetClosedOutcomes != null && closed >= opts.targetClosedOutcomes) {
        console.log(`[scout-canary] target closed outcome count reached (${closed}/${opts.targetClosedOutcomes})`);
        break;
      }
      if (calls >= opts.maxCalls) {
        console.log('[scout-canary] max call limit reached');
        break;
      }
    }
    if (Date.now() >= deadline) console.log('[scout-canary] duration limit reached');
  } finally {
    await cleanup();
  }
}

main().catch(err => {
  console.error(`[scout-canary] ERROR: ${err.message}`);
  process.exit(1);
});
