import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const exec = promisify(execFile);
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-shadow-config-'));
const primaryDb = path.join(tempDir, 'primary.sqlite');
const shadowDb = path.join(tempDir, 'shadow.sqlite');

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function runNode(args) {
  return exec(process.execPath, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PATH: process.env.PATH,
      CHARON_SKIP_DOTENV: 'true',
    },
    maxBuffer: 1024 * 1024,
  });
}

async function createPrimary() {
  await runNode(['--input-type=module', '--eval', `
    process.env.CHARON_SKIP_DOTENV = 'true';
    process.env.DB_PATH = ${JSON.stringify(primaryDb)};
    process.env.TRADING_MODE = 'live';
    const { db, initDb } = await import('./src/db/connection.js');
    initDb();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('llm_min_confidence', '80')").run();
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('trading_mode', 'live')").run();
    db.close();
  `]);
  await runNode([
    'scripts/shadow_bootstrap.js',
    '--mode=clone',
    `--source=${primaryDb}`,
    `--target=${shadowDb}`,
  ]);
}

async function runConfig(args) {
  return runNode(['scripts/shadow_config.js', `--db=${shadowDb}`, ...args]);
}

test('shadow_config set/get/list updates shadow settings and marks override only in shadow DB', async () => {
  await createPrimary();

  const set = await runConfig(['set', 'llm_min_confidence', '65']);
  assert.match(set.stdout, /llm_min_confidence=65 \[OVERRIDE\]/);

  const get = await runConfig(['get', 'llm_min_confidence']);
  assert.match(get.stdout, /llm_min_confidence=65/);

  const list = await runConfig(['list', 'settings']);
  assert.match(list.stdout, /llm_min_confidence=65 \[OVERRIDE\]/);

  const primary = new Database(primaryDb, { readonly: true });
  try {
    assert.equal(primary.prepare("SELECT value FROM settings WHERE key = 'llm_min_confidence'").get().value, '80');
  } finally {
    primary.close();
  }
});

test('shadow_config edits strategy values and preserves them as strategy override', async () => {
  const set = await runConfig(['set', 'strategy:sniper.min_mcap_usd', '30000']);
  assert.match(set.stdout, /strategy:sniper\.min_mcap_usd=30000 \[OVERRIDE\]/);

  const get = await runConfig(['get', 'strategy:sniper.min_mcap_usd']);
  assert.match(get.stdout, /strategy:sniper\.min_mcap_usd=30000/);

  const list = await runConfig(['list', 'overrides']);
  assert.match(list.stdout, /strategies:sniper/);

  const shadow = new Database(shadowDb, { readonly: true });
  try {
    const config = JSON.parse(shadow.prepare("SELECT config_json FROM strategies WHERE id = 'sniper'").get().config_json);
    assert.equal(config.min_mcap_usd, 30000);
  } finally {
    shadow.close();
  }
});

test('shadow_config diff shows shadow overrides against primary', async () => {
  const { stdout } = await runNode([
    'scripts/shadow_config.js',
    `--db=${shadowDb}`,
    `--source=${primaryDb}`,
    'diff',
  ]);
  assert.match(stdout, /SHADOW CONFIG DIFF/);
  assert.match(stdout, /settings\.llm_min_confidence: primary=80 shadow=65 \[OVERRIDE\]/);
  assert.match(stdout, /settings\.trading_mode: primary=live shadow=dry_run \[OVERRIDE\]/);
  assert.match(stdout, /strategies\.sniper: differs \[OVERRIDE\]/);
});

test('shadow_config supports strict entry shadow policy overrides without touching primary DB', async () => {
  const overrides = [
    ['entry_confirm_shadow_strict_enabled', 'true'],
    ['entry_confirm_shadow_min_score', '62'],
    ['entry_confirm_shadow_min_candles', '15'],
    ['entry_confirm_shadow_max_rsi', '68'],
    ['entry_confirm_shadow_max_mcap_disagreement_pct', '90'],
  ];

  for (const [key, value] of overrides) {
    const set = await runConfig(['set', key, value]);
    assert.match(set.stdout, new RegExp(`${key}=${value} \\[OVERRIDE\\]`));
  }

  const shadow = new Database(shadowDb, { readonly: true });
  const primary = new Database(primaryDb, { readonly: true });
  try {
    for (const [key, value] of overrides) {
      assert.equal(shadow.prepare('SELECT value FROM settings WHERE key = ?').get(key).value, value);
      assert.equal(primary.prepare('SELECT value FROM settings WHERE key = ?').get(key), undefined);
    }
  } finally {
    shadow.close();
    primary.close();
  }

  const { stdout } = await runNode([
    'scripts/shadow_config.js',
    `--db=${shadowDb}`,
    `--source=${primaryDb}`,
    'diff',
  ]);
  assert.match(stdout, /settings\.entry_confirm_shadow_strict_enabled: primary=<missing> shadow=true \[OVERRIDE\]/);
  assert.match(stdout, /settings\.entry_confirm_shadow_min_score: primary=<missing> shadow=62 \[OVERRIDE\]/);
  assert.match(stdout, /settings\.entry_confirm_shadow_min_candles: primary=<missing> shadow=15 \[OVERRIDE\]/);
  assert.match(stdout, /settings\.entry_confirm_shadow_max_rsi: primary=<missing> shadow=68 \[OVERRIDE\]/);
  assert.match(stdout, /settings\.entry_confirm_shadow_max_mcap_disagreement_pct: primary=<missing> shadow=90 \[OVERRIDE\]/);
});

test('shadow_config refuses unsafe trading mode and can clear non-protected overrides', async () => {
  await assert.rejects(
    runConfig(['set', 'trading_mode', 'live']),
    /Refusing to set shadow trading_mode/,
  );

  const cleared = await runConfig(['clear-override', 'settings', 'llm_min_confidence']);
  assert.match(cleared.stdout, /settings:llm_min_confidence override cleared/);

  const list = await runConfig(['list', 'overrides']);
  assert.doesNotMatch(list.stdout, /settings:llm_min_confidence/);
  assert.match(list.stdout, /settings:trading_mode/);
});
