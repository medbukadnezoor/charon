#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

function usage() {
  return [
    'Usage:',
    '  node scripts/shadow_config.js --db=/path/charon-shadow.sqlite list [settings|strategies|overrides]',
    '  node scripts/shadow_config.js --db=/path/charon-shadow.sqlite get <key|strategy:id.key>',
    '  node scripts/shadow_config.js --db=/path/charon-shadow.sqlite set <key|strategy:id.key> <value>',
    '  node scripts/shadow_config.js --db=/path/charon-shadow.sqlite mark-override <settings|strategies> <key-or-id>',
    '  node scripts/shadow_config.js --db=/path/charon-shadow.sqlite clear-override <settings|strategies> <key-or-id>',
    '  node scripts/shadow_config.js --db=/path/charon-shadow.sqlite --source=/path/charon.sqlite diff',
    '',
    'Examples:',
    '  node scripts/shadow_config.js --db=/opt/trading-data/charon-shadow.sqlite set llm_min_confidence 65',
    '  node scripts/shadow_config.js --db=/opt/trading-data/charon-shadow.sqlite set strategy:sniper.min_mcap_usd 30000',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      opts[match[1]] = match[2];
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

function assertDbPath(dbPath) {
  if (!dbPath) throw new Error('--db is required.\n\n' + usage());
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`Shadow DB not found: ${resolved}`);
  return resolved;
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

function markOverride(db, tableName, keyValue) {
  if (!['settings', 'strategies'].includes(tableName)) {
    throw new Error('override table must be settings or strategies');
  }
  db.prepare(`
    INSERT OR REPLACE INTO _shadow_overrides (table_name, key_value, marked_at_ms)
    VALUES (?, ?, ?)
  `).run(tableName, String(keyValue), Date.now());
}

function clearOverride(db, tableName, keyValue) {
  if (tableName === 'settings' && keyValue === 'trading_mode') {
    throw new Error('trading_mode override cannot be cleared; shadow must remain dry_run');
  }
  db.prepare('DELETE FROM _shadow_overrides WHERE table_name = ? AND key_value = ?').run(tableName, String(keyValue));
}

function overrideSet(db, tableName) {
  return new Set(db.prepare('SELECT key_value FROM _shadow_overrides WHERE table_name = ?').all(tableName).map(row => row.key_value));
}

function parseTarget(raw) {
  const strategyMatch = String(raw || '').match(/^strategy:([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)$/);
  if (strategyMatch) {
    return { type: 'strategy', id: strategyMatch[1], key: strategyMatch[2] };
  }
  if (!raw || String(raw).startsWith('strategy:')) {
    throw new Error('Strategy keys must use strategy:<id>.<key>');
  }
  return { type: 'setting', key: String(raw) };
}

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && Number.isFinite(Number(value))) return Number(value);
  return value;
}

function getSetting(db, key) {
  return db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key) || null;
}

function setSetting(db, key, value) {
  if (key === 'trading_mode' && value !== 'dry_run') {
    throw new Error('Refusing to set shadow trading_mode to anything other than dry_run');
  }
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
  markOverride(db, 'settings', key);
}

function strategyRow(db, id) {
  return db.prepare('SELECT * FROM strategies WHERE id = ?').get(id) || null;
}

function getStrategyValue(db, id, key) {
  const row = strategyRow(db, id);
  if (!row) return null;
  const config = JSON.parse(row.config_json || '{}');
  return { id: row.id, key, value: config[key] };
}

function setStrategyValue(db, id, key, value) {
  const row = strategyRow(db, id);
  if (!row) throw new Error(`Strategy not found: ${id}`);
  const config = JSON.parse(row.config_json || '{}');
  config[key] = parseScalar(value);
  db.prepare('UPDATE strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(config), id);
  markOverride(db, 'strategies', id);
}

function listSettings(db) {
  const overrides = overrideSet(db, 'settings');
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all();
  for (const row of rows) {
    console.log(`${row.key}=${row.value}${overrides.has(row.key) ? ' [OVERRIDE]' : ''}`);
  }
}

function listStrategies(db) {
  const overrides = overrideSet(db, 'strategies');
  const rows = db.prepare('SELECT id, name, enabled, config_json FROM strategies ORDER BY id').all();
  for (const row of rows) {
    console.log(`${row.id} (${row.name}) enabled=${Boolean(row.enabled)}${overrides.has(row.id) ? ' [OVERRIDE]' : ''}`);
    const config = JSON.parse(row.config_json || '{}');
    for (const key of Object.keys(config).sort()) {
      console.log(`  ${key}=${config[key]}`);
    }
  }
}

function listOverrides(db) {
  const rows = db.prepare('SELECT table_name, key_value, marked_at_ms FROM _shadow_overrides ORDER BY table_name, key_value').all();
  for (const row of rows) {
    console.log(`${row.table_name}:${row.key_value} marked_at=${row.marked_at_ms}`);
  }
}

function printGet(db, rawTarget) {
  const target = parseTarget(rawTarget);
  if (target.type === 'setting') {
    const row = getSetting(db, target.key);
    if (!row) throw new Error(`Setting not found: ${target.key}`);
    console.log(`${row.key}=${row.value}`);
    return;
  }
  const row = getStrategyValue(db, target.id, target.key);
  if (!row) throw new Error(`Strategy not found: ${target.id}`);
  console.log(`strategy:${row.id}.${row.key}=${row.value}`);
}

function setTarget(db, rawTarget, value) {
  const target = parseTarget(rawTarget);
  if (target.type === 'setting') {
    setSetting(db, target.key, value);
    console.log(`${target.key}=${value} [OVERRIDE]`);
    return;
  }
  setStrategyValue(db, target.id, target.key, value);
  console.log(`strategy:${target.id}.${target.key}=${parseScalar(value)} [OVERRIDE]`);
}

function diffSettings(sourceDb, shadowDb) {
  const overrides = overrideSet(shadowDb, 'settings');
  const sourceRows = sourceDb.prepare('SELECT key, value FROM settings ORDER BY key').all();
  const sourceKeys = new Set(sourceRows.map(row => row.key));
  const shadowStmt = shadowDb.prepare('SELECT value FROM settings WHERE key = ?');
  let count = 0;
  for (const row of sourceRows) {
    const shadow = shadowStmt.get(row.key);
    const shadowValue = row.key === 'trading_mode' ? 'dry_run' : shadow?.value;
    if (!shadow || row.value !== shadowValue || row.key === 'trading_mode') {
      count += 1;
      console.log(`settings.${row.key}: primary=${row.value} shadow=${shadowValue ?? '<missing>'}${(row.key === 'trading_mode' || overrides.has(row.key)) ? ' [OVERRIDE]' : ''}`);
    }
  }
  const shadowOnlyRows = shadowDb.prepare('SELECT key, value FROM settings ORDER BY key').all()
    .filter(row => !sourceKeys.has(row.key) && overrides.has(row.key));
  for (const row of shadowOnlyRows) {
    count += 1;
    console.log(`settings.${row.key}: primary=<missing> shadow=${row.value} [OVERRIDE]`);
  }
  return count;
}

function diffStrategies(sourceDb, shadowDb) {
  const overrides = overrideSet(shadowDb, 'strategies');
  const sourceRows = sourceDb.prepare('SELECT id, name, enabled, config_json FROM strategies ORDER BY id').all();
  const shadowStmt = shadowDb.prepare('SELECT id, name, enabled, config_json FROM strategies WHERE id = ?');
  let count = 0;
  for (const row of sourceRows) {
    const shadow = shadowStmt.get(row.id);
    if (!shadow || row.name !== shadow.name || row.enabled !== shadow.enabled || row.config_json !== shadow.config_json) {
      count += 1;
      console.log(`strategies.${row.id}: ${shadow ? 'differs' : 'missing'}${overrides.has(row.id) ? ' [OVERRIDE]' : ''}`);
    }
  }
  return count;
}

function runDiff(db, sourcePath) {
  if (!sourcePath) throw new Error('--source is required for diff');
  const resolved = path.resolve(sourcePath);
  if (!fs.existsSync(resolved)) throw new Error(`Source DB not found: ${resolved}`);
  const sourceDb = new Database(resolved, { readonly: true, fileMustExist: true });
  try {
    console.log('SHADOW CONFIG DIFF');
    const settingCount = diffSettings(sourceDb, db);
    const strategyCount = diffStrategies(sourceDb, db);
    console.log(`summary: settings=${settingCount} strategies=${strategyCount}`);
  } finally {
    sourceDb.close();
  }
}

function main() {
  const { opts, positional } = parseArgs(process.argv.slice(2));
  const dbPath = assertDbPath(opts.db);
  const [command, first, second] = positional;
  if (!command) throw new Error(usage());
  const db = new Database(dbPath);
  try {
    ensureShadowOverridesTable(db);
    if (command === 'list') {
      const type = first || 'settings';
      if (type === 'settings') return listSettings(db);
      if (type === 'strategies') return listStrategies(db);
      if (type === 'overrides') return listOverrides(db);
      throw new Error('list target must be settings, strategies, or overrides');
    }
    if (command === 'get') return printGet(db, first);
    if (command === 'set') {
      if (second === undefined) throw new Error('set requires <key> <value>');
      return setTarget(db, first, second);
    }
    if (command === 'mark-override') {
      markOverride(db, first, second);
      console.log(`${first}:${second} [OVERRIDE]`);
      return;
    }
    if (command === 'clear-override') {
      clearOverride(db, first, second);
      console.log(`${first}:${second} override cleared`);
      return;
    }
    if (command === 'diff') return runDiff(db, opts.source);
    throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  } finally {
    db.close();
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (err) {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  }
}
