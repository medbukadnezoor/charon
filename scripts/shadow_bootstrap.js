#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const BASELINE_TABLES = [
  'saved_wallets',
  'mint_blacklist',
  'deployer_observations',
  'learning_runs',
];

const EXPERIMENT_TABLES = [
  'candidates',
  'alerts',
  'llm_decisions',
  'llm_batches',
  'llm_usage_events',
  'dry_run_positions',
  'dry_run_trades',
  'tp_sl_rules',
  'trade_intents',
  'decision_logs',
  'signal_events',
  'screening_events',
  'price_alerts',
];

const OVERRIDE_PROTECTED_TABLES = ['settings', 'strategies'];
const SHADOW_ONLY_TABLES = ['_shadow_overrides'];
const REQUIRED_TABLES = [
  ...BASELINE_TABLES,
  'learning_lessons',
  ...OVERRIDE_PROTECTED_TABLES,
  ...EXPERIMENT_TABLES,
];

function parseArgs(argv) {
  const opts = { mode: 'report', force: false };
  for (const arg of argv) {
    if (arg === '--force') {
      opts.force = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) opts[match[1]] = match[2];
  }
  return opts;
}

function usage() {
  return [
    'Usage:',
    '  node scripts/shadow_bootstrap.js --mode=report --source=/path/charon.sqlite --target=/path/charon-shadow.sqlite',
    '  node scripts/shadow_bootstrap.js --mode=clone  --source=/path/charon.sqlite --target=/path/charon-shadow.sqlite [--force]',
    '  node scripts/shadow_bootstrap.js --mode=sync   --source=/path/charon.sqlite --target=/path/charon-shadow.sqlite',
    '',
    'Notes:',
    '  --source and --target are required; this script intentionally has no runtime DB default.',
    '  clone refuses to overwrite an existing target unless --force is provided.',
  ].join('\n');
}

function assertSafePaths(opts) {
  if (!['report', 'clone', 'sync'].includes(opts.mode)) {
    throw new Error(`Unknown --mode=${opts.mode}`);
  }
  if (!opts.source || !opts.target) {
    throw new Error('Both --source and --target are required.\n\n' + usage());
  }
  opts.source = path.resolve(opts.source);
  opts.target = path.resolve(opts.target);
  if (opts.source === opts.target) {
    throw new Error('Refusing to use the same path for --source and --target.');
  }
  if (!fs.existsSync(opts.source)) {
    throw new Error(`Source DB not found: ${opts.source}`);
  }
  if (opts.mode === 'clone' && fs.existsSync(opts.target) && !opts.force) {
    throw new Error(`Target exists: ${opts.target}. Pass --force to replace it.`);
  }
}

function quoteIdent(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Unsafe identifier: ${value}`);
  return `"${value}"`;
}

function tableNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
}

function hasTable(db, table) {
  return tableNames(db).includes(table);
}

function indexNames(db) {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
}

function schemaMap(db) {
  const rows = db.prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all();
  return new Map(rows.map(row => [`${row.type}:${row.name}`, row.sql || '']));
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

function tableColumnsMatch(sourceDb, targetDb, tableName) {
  const getColumns = (db) =>
    db.pragma(`table_info(${quoteIdent(tableName)})`)
      .map(c => ({ name: c.name, type: (c.type || '').toUpperCase().trim() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  const src = getColumns(sourceDb);
  const tgt = getColumns(targetDb);
  if (src.length !== tgt.length) return false;
  return src.every((c, i) => c.name === tgt[i].name && c.type === tgt[i].type);
}

function compareSchema(sourceDb, targetDb) {
  const source = schemaMap(sourceDb);
  const target = schemaMap(targetDb);
  const allowedExtra = new Set(SHADOW_ONLY_TABLES.map(name => `table:${name}`));
  const mismatches = [];
  for (const [key, sourceSql] of source.entries()) {
    if (!target.has(key)) {
      mismatches.push({ key, state: 'missing_in_shadow' });
      continue;
    }
    if (key.startsWith('table:')) {
      const tableName = key.slice(6);
      if (!tableColumnsMatch(sourceDb, targetDb, tableName)) {
        mismatches.push({ key, state: 'sql_differs' });
      }
    } else {
      if (normalizeSql(sourceSql) !== normalizeSql(target.get(key))) {
        mismatches.push({ key, state: 'sql_differs' });
      }
    }
  }
  for (const key of target.keys()) {
    if (!source.has(key) && !allowedExtra.has(key)) {
      mismatches.push({ key, state: 'extra_in_shadow' });
    }
  }
  return mismatches;
}

async function initTargetSchema(targetPath, { replace = false } = {}) {
  if (replace) {
    fs.rmSync(targetPath, { force: true });
    fs.rmSync(`${targetPath}-wal`, { force: true });
    fs.rmSync(`${targetPath}-shm`, { force: true });
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  process.env.CHARON_SKIP_DOTENV = 'true';
  process.env.DB_PATH = targetPath;
  process.env.TRADING_MODE = 'dry_run';
  const { db, initDb } = await import('../src/db/connection.js');
  initDb();
  ensureShadowOverridesTable(db);
  return db;
}

function ensureShadowOverridesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _shadow_overrides (
      table_name TEXT NOT NULL,
      key_value TEXT NOT NULL,
      marked_at_ms INTEGER NOT NULL,
      PRIMARY KEY (table_name, key_value)
    )
  `);
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${quoteIdent(table)})`).all().map(row => row.name);
}

function rowCount(db, table, where = '') {
  if (!hasTable(db, table)) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)} ${where}`).get().count;
}

function rows(db, table, where = '') {
  if (!hasTable(db, table)) return [];
  return db.prepare(`SELECT * FROM ${quoteIdent(table)} ${where}`).all();
}

function upsertRows(targetDb, table, sourceRows) {
  if (!sourceRows.length) return 0;
  const columns = tableColumns(targetDb, table).filter(column => Object.hasOwn(sourceRows[0], column));
  const columnSql = columns.map(quoteIdent).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = targetDb.prepare(`
    INSERT OR REPLACE INTO ${quoteIdent(table)} (${columnSql})
    VALUES (${placeholders})
  `);
  for (const row of sourceRows) {
    stmt.run(columns.map(column => row[column]));
  }
  return sourceRows.length;
}

function overrideSet(targetDb, table) {
  if (!tableNames(targetDb).includes('_shadow_overrides')) return new Set();
  return new Set(targetDb.prepare(`
    SELECT key_value FROM _shadow_overrides WHERE table_name = ?
  `).all(table).map(row => String(row.key_value)));
}

function markOverride(targetDb, table, key) {
  targetDb.prepare(`
    INSERT OR REPLACE INTO _shadow_overrides (table_name, key_value, marked_at_ms)
    VALUES (?, ?, ?)
  `).run(table, String(key), Date.now());
}

function syncSettings(sourceDb, targetDb) {
  const overrides = overrideSet(targetDb, 'settings');
  const sourceRows = rows(sourceDb, 'settings');
  const stmt = targetDb.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  let copied = 0;
  let preserved = 0;
  for (const row of sourceRows) {
    if (row.key === 'trading_mode') continue;
    if (overrides.has(row.key)) {
      preserved += 1;
      continue;
    }
    stmt.run(row.key, row.value);
    copied += 1;
  }
  stmt.run('trading_mode', 'dry_run');
  markOverride(targetDb, 'settings', 'trading_mode');
  return { copied, preserved, forced: ['trading_mode'] };
}

function syncStrategies(sourceDb, targetDb) {
  const overrides = overrideSet(targetDb, 'strategies');
  const sourceRows = rows(sourceDb, 'strategies');
  const stmt = targetDb.prepare(`
    INSERT INTO strategies (id, name, enabled, config_json, created_at_ms)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      config_json = excluded.config_json,
      created_at_ms = excluded.created_at_ms
  `);
  let copied = 0;
  let preserved = 0;
  for (const row of sourceRows) {
    if (overrides.has(row.id)) {
      preserved += 1;
      continue;
    }
    stmt.run(row.id, row.name, row.enabled, row.config_json, row.created_at_ms);
    copied += 1;
  }
  return { copied, preserved };
}

function syncBaseline(sourceDb, targetDb) {
  const copied = {};
  for (const table of BASELINE_TABLES) {
    copied[table] = upsertRows(targetDb, table, rows(sourceDb, table));
  }
  copied.learning_lessons = upsertRows(targetDb, 'learning_lessons', rows(sourceDb, 'learning_lessons', "WHERE status = 'active'"));
  return copied;
}

function syncAll(sourceDb, targetDb) {
  return targetDb.transaction(() => {
    const baseline = syncBaseline(sourceDb, targetDb);
    const settings = syncSettings(sourceDb, targetDb);
    const strategies = syncStrategies(sourceDb, targetDb);
    return { baseline, settings, strategies };
  })();
}

function countSummary(sourceDb, targetDb) {
  const summary = {};
  for (const table of REQUIRED_TABLES) {
    summary[table] = {
      primary: rowCount(sourceDb, table),
      shadow: rowCount(targetDb, table),
    };
  }
  summary._shadow_overrides = {
    primary: 0,
    shadow: tableNames(targetDb).includes('_shadow_overrides') ? rowCount(targetDb, '_shadow_overrides') : 0,
  };
  return summary;
}

function driftSummary(sourceDb, targetDb) {
  const settingsOverrides = overrideSet(targetDb, 'settings');
  const strategyOverrides = overrideSet(targetDb, 'strategies');
  const settingDrift = [];
  const sourceSettings = rows(sourceDb, 'settings');
  const targetSettingStmt = targetDb.prepare('SELECT value FROM settings WHERE key = ?');
  for (const row of sourceSettings) {
    const target = targetSettingStmt.get(row.key);
    if (!target || target.value !== row.value || row.key === 'trading_mode') {
      settingDrift.push({
        key: row.key,
        primary: row.value,
        shadow: row.key === 'trading_mode' ? 'dry_run' : (target?.value ?? null),
        override: row.key === 'trading_mode' || settingsOverrides.has(row.key),
      });
    }
  }

  const strategyDrift = [];
  const targetStrategyStmt = targetDb.prepare('SELECT * FROM strategies WHERE id = ?');
  for (const row of rows(sourceDb, 'strategies')) {
    const target = targetStrategyStmt.get(row.id);
    if (!target || target.name !== row.name || target.enabled !== row.enabled || target.config_json !== row.config_json) {
      strategyDrift.push({
        id: row.id,
        override: strategyOverrides.has(row.id),
      });
    }
  }
  return { settings: settingDrift, strategies: strategyDrift };
}

function printReport({ opts, targetExists, schemaMismatches, counts, drift, copied }) {
  console.log(`SHADOW DRIFT REPORT - ${new Date().toISOString()}`);
  console.log(`Mode: ${opts.mode}`);
  console.log(`Source: ${opts.source}`);
  console.log(`Target: ${opts.target}`);
  if (!targetExists) {
    console.log('Target state: missing');
    console.log('Action: run --mode=clone to create the shadow DB');
    return;
  }
  console.log(`Schema: ${schemaMismatches.length === 0 ? 'match' : `${schemaMismatches.length} mismatch(es)`}`);
  for (const mismatch of schemaMismatches.slice(0, 10)) {
    console.log(`  - ${mismatch.key}: ${mismatch.state}`);
  }
  for (const table of ['saved_wallets', 'mint_blacklist', 'deployer_observations', 'learning_lessons']) {
    const row = counts[table];
    console.log(`${table}: primary=${row.primary} shadow=${row.shadow}`);
  }
  console.log(`settings drift: ${drift.settings.length}`);
  for (const row of drift.settings.slice(0, 10)) {
    console.log(`  - ${row.key}: primary=${row.primary} shadow=${row.shadow}${row.override ? ' [OVERRIDE]' : ''}`);
  }
  console.log(`strategy drift: ${drift.strategies.length}`);
  for (const row of drift.strategies.slice(0, 10)) {
    console.log(`  - ${row.id}${row.override ? ' [OVERRIDE]' : ''}`);
  }
  const nonEmptyExperiment = EXPERIMENT_TABLES.filter(table => counts[table]?.shadow > 0);
  console.log(`experiment tables: ${nonEmptyExperiment.length ? `non-empty (${nonEmptyExperiment.join(', ')})` : 'empty'}`);
  console.log(`shadow overrides: ${counts._shadow_overrides.shadow}`);
  if (copied) {
    console.log('Sync result:');
    for (const [table, count] of Object.entries(copied.baseline)) {
      console.log(`  - ${table}: ${count} upserted`);
    }
    console.log(`  - settings: ${copied.settings.copied} copied, ${copied.settings.preserved} preserved, trading_mode forced`);
    console.log(`  - strategies: ${copied.strategies.copied} copied, ${copied.strategies.preserved} preserved`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  assertSafePaths(opts);

  const sourceDb = new Database(opts.source, { readonly: true, fileMustExist: true });
  let targetDb = null;
  const targetExistsBefore = fs.existsSync(opts.target);
  let copied = null;

  try {
    if (opts.mode === 'report') {
      if (!targetExistsBefore) {
        printReport({ opts, targetExists: false });
        return;
      }
      targetDb = new Database(opts.target, { readonly: true, fileMustExist: true });
    } else {
      targetDb = await initTargetSchema(opts.target, { replace: opts.mode === 'clone' && opts.force });
      copied = syncAll(sourceDb, targetDb);
    }

    const missingTargetTables = REQUIRED_TABLES.filter(table => !hasTable(targetDb, table));
    if (missingTargetTables.length) throw new Error(`Shadow DB missing required tables: ${missingTargetTables.join(', ')}`);
    const schemaMismatches = compareSchema(sourceDb, targetDb);
    const counts = countSummary(sourceDb, targetDb);
    const drift = driftSummary(sourceDb, targetDb);
    printReport({ opts, targetExists: true, schemaMismatches, counts, drift, copied });
  } finally {
    sourceDb.close();
    targetDb?.close();
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
}
