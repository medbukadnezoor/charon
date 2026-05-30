import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.SHADOW_MODE = 'true';
process.env.TELEGRAM_POLLING_ENABLED = 'false';
process.env.TELEGRAM_BOT_TOKEN = 'test:shadow';
process.env.TELEGRAM_CHAT_ID = '12345';
process.env.DB_PATH = ':memory:';

const execFileAsync = promisify(execFile);
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-shadow-notifier-'));
const fixtureDb = path.join(tempDir, 'shadow.sqlite');

const {
  buildShadowFleetMessage,
  buildShadowFleetNotification,
  collectShadowDbSummary,
  collectPm2Status,
  startShadowFleetNotifier,
} = await import('../src/telegram/shadowFleetNotifier.js');

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createFixtureDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE provider_call_ledger (
      at_ms INTEGER NOT NULL,
      provider TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT
    );
    CREATE TABLE token_observation_queue (
      tier TEXT NOT NULL,
      status TEXT NOT NULL,
      watch_status TEXT NOT NULL
    );
    CREATE TABLE token_observations (
      source_instance TEXT NOT NULL,
      execution_lane TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL,
      ohlcv_interval TEXT
    );
    CREATE TABLE telemetry_collector_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collector_id TEXT NOT NULL,
      status TEXT NOT NULL,
      claimed_count INTEGER NOT NULL,
      observed_count INTEGER NOT NULL,
      provider_ok_count INTEGER NOT NULL,
      provider_error_count INTEGER NOT NULL,
      budget_skip_count INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      last_error TEXT
    );
    CREATE TABLE candidates (created_at_ms INTEGER NOT NULL);
    CREATE TABLE dry_run_positions (status TEXT NOT NULL);
  `);
  return db;
}

test('shadow fleet summary formats sanitized PM2 and telemetry state', () => {
  const atMs = 1_779_300_000_000;
  const db = createFixtureDb(fixtureDb);
  db.prepare("INSERT INTO settings (key, value) VALUES ('telemetry_birdeye_budget_start_ms', ?), ('telemetry_birdeye_daily_call_cap', '2000')").run(String(atMs - 60_000));
  db.prepare('INSERT INTO provider_call_ledger (at_ms, provider, endpoint, status, error_message) VALUES (?, ?, ?, ?, ?)').run(
    atMs - 10_000,
    'birdeye',
    '/defi/v3/ohlcv',
    'ok',
    'secret-looking raw provider error should not render',
  );
  db.prepare('INSERT INTO token_observation_queue (tier, status, watch_status) VALUES (?, ?, ?)').run('A', 'pending', 'active');
  db.prepare('INSERT INTO token_observations (source_instance, execution_lane, observed_at_ms, ohlcv_interval) VALUES (?, ?, ?, ?)').run('shadow', 'shadow_dry_run', atMs - 15_000, '1m');
  db.prepare('INSERT INTO telemetry_collector_runs (collector_id, status, claimed_count, observed_count, provider_ok_count, provider_error_count, budget_skip_count, started_at_ms, finished_at_ms, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'shadow-observation-collector',
    'ok',
    10,
    1,
    1,
    0,
    0,
    atMs - 20_000,
    atMs - 19_000,
    '<provider raw detail>',
  );
  db.prepare('INSERT INTO candidates (created_at_ms) VALUES (?)').run(atMs - 20_000);
  db.prepare("INSERT INTO dry_run_positions (status) VALUES ('open')").run();
  db.close();

  const summary = collectShadowDbSummary({ dbPath: fixtureDb, atMs, windowMs: 30 * 60_000 });
  const message = buildShadowFleetMessage({
    atMs,
    dbSummary: summary,
    pm2Rows: [
      { name: 'charon-shadow', status: 'online', restarts: 2, unstableRestarts: 0 },
      { name: 'charon-shadow-sync', status: 'stopped', restarts: 0, unstableRestarts: 0, exitCode: 0, cron: '0 */2 * * *' },
    ],
  });

  assert.match(message, /Shadow Fleet/);
  assert.match(message, /charon-shadow/);
  assert.match(message, /Birdeye: 1 \/ 2000/);
  assert.match(message, /Queue: pending=1/);
  assert.match(message, /OHLCV observations: 1/);
  assert.doesNotMatch(message, /secret-looking/);
  assert.match(message, /&lt;provider raw detail&gt;/);
});

test('collectPm2Status parses only requested PM2 process rows', async () => {
  const rows = [
    { name: 'charon-shadow', pm2_env: { status: 'online', restart_time: 1, unstable_restarts: 0 } },
    { name: 'charon', pm2_env: { status: 'online' } },
  ];
  const result = await collectPm2Status({
    names: ['charon-shadow'],
    execFileImpl: async () => ({ stdout: JSON.stringify(rows) }),
  });
  assert.deepEqual(result, [{
    name: 'charon-shadow',
    status: 'online',
    exitCode: null,
    restarts: 1,
    unstableRestarts: 0,
    cron: null,
  }]);
});

test('startShadowFleetNotifier schedules summaries without polling Telegram commands', () => {
  const calls = [];
  const started = startShadowFleetNotifier({
    dbPath: fixtureDb,
    intervalMs: 5 * 60_000,
    initialDelayMs: 0,
    windowMs: 30 * 60_000,
    sendFn: async message => calls.push(message),
    setTimeoutFn: () => {
      return 1;
    },
    setIntervalFn: () => 2,
    consoleObj: { log() {} },
  });
  assert.equal(started, true);
});

test('dry-run CLI prints summary and does not require Telegram token', async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/shadow_fleet_notifier.js',
    '--dry-run',
    `--db-path=${fixtureDb}`,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      CHARON_SKIP_DOTENV: 'true',
      SHADOW_MODE: 'true',
      DB_PATH: fixtureDb,
    },
  });
  assert.match(stdout, /Shadow Fleet/);
});

test('buildShadowFleetNotification combines mocked PM2 and read-only DB summary', async () => {
  const result = await buildShadowFleetNotification({
    dbPath: fixtureDb,
    execFileImpl: async () => ({ stdout: JSON.stringify([{ name: 'charon-shadow', pm2_env: { status: 'online' } }]) }),
  });
  assert.match(result.message, /Shadow Fleet/);
  assert.equal(result.pm2Rows[0].name, 'charon-shadow');
});
