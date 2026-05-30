import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const exec = promisify(execFile);

function featureSnapshot(verdict = 'BUY') {
  return JSON.stringify({
    decision: {
      scout_policy: {
        feature_snapshot: {
          feature_keys: ['source_count:2', `llm:${verdict}:60-79`],
        },
      },
    },
  });
}

async function withTempDb(fn) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-scout-learner-readiness-'));
  const dbPath = path.join(tempDir, 'scout.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE strategies (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, config_json TEXT);
      CREATE TABLE llm_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        error_class TEXT
      );
      CREATE TABLE scout_reward_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        outcome_id TEXT,
        position_id INTEGER,
        reward REAL,
        reward_weight REAL,
        feature_snapshot_json TEXT,
        created_at_ms INTEGER,
        source TEXT,
        applied_to_weights_at_ms INTEGER
      );
      CREATE TABLE scout_policy_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE
      );
      CREATE TABLE scout_policy_weights (
        policy_version_id INTEGER,
        feature_key TEXT,
        weight REAL,
        confidence REAL,
        sample_count REAL,
        live_sample_count INTEGER,
        shadow_sample_count INTEGER,
        last_reward_at_ms INTEGER,
        decay_half_life_ms INTEGER,
        updated_at_ms INTEGER,
        PRIMARY KEY (policy_version_id, feature_key)
      );
      CREATE TABLE dry_run_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id INTEGER,
        mint TEXT NOT NULL,
        symbol TEXT,
        status TEXT NOT NULL,
        opened_at_ms INTEGER NOT NULL,
        closed_at_ms INTEGER,
        execution_mode TEXT DEFAULT 'dry_run',
        exit_reason TEXT,
        pnl_sol REAL,
        pnl_percent REAL,
        entry_mcap REAL,
        high_water_mcap REAL,
        strategy_id TEXT DEFAULT 'scout',
        scout_policy_version_id INTEGER,
        scout_policy_score REAL,
        scout_reward_status TEXT DEFAULT 'pending',
        snapshot_json TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('trading_mode', 'dry_run')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('scout_policy_enabled', 'true')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('scout_policy_active_version', 'scout-v1')").run();
    db.prepare("INSERT INTO scout_policy_versions (version) VALUES ('scout-v1')").run();
    db.prepare(`
      INSERT INTO scout_policy_weights (
        policy_version_id, feature_key, weight, confidence, sample_count,
        live_sample_count, shadow_sample_count, last_reward_at_ms, decay_half_life_ms, updated_at_ms
      ) VALUES (1, 'source_count:2', 0.1, 0.2, 2, 0, 2, 1000, 604800000, 1000)
    `).run();
    db.prepare("INSERT INTO strategies (id, name, enabled, config_json) VALUES ('scout', 'Scout', 1, ?)").run(JSON.stringify({
      max_open_positions: 1,
      use_llm: true,
    }));
    return await fn({ db, dbPath });
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function insertClosed(db, overrides = {}) {
  db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, closed_at_ms, execution_mode, exit_reason,
      pnl_sol, pnl_percent, entry_mcap, high_water_mcap, strategy_id,
      scout_policy_version_id, scout_policy_score, scout_reward_status, snapshot_json
    ) VALUES (
      @mint, @symbol, 'closed', @opened_at_ms, @closed_at_ms, @execution_mode, @exit_reason,
      @pnl_sol, @pnl_percent, @entry_mcap, @high_water_mcap, 'scout',
      @scout_policy_version_id, @scout_policy_score, @scout_reward_status, @snapshot_json
    )
  `).run({
    mint: `Mint${Math.random().toString(16).slice(2).padEnd(36, '1')}`,
    symbol: 'SCOUT',
    opened_at_ms: 1_000,
    closed_at_ms: Date.now() - 1_000,
    execution_mode: 'dry_run',
    exit_reason: 'SL',
    pnl_sol: -0.001,
    pnl_percent: -20,
    entry_mcap: 10_000,
    high_water_mcap: 12_000,
    scout_policy_version_id: 1,
    scout_policy_score: -0.01,
    scout_reward_status: 'pending',
    snapshot_json: featureSnapshot(),
    ...overrides,
  });
}

function insertOpen(db) {
  db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, execution_mode, entry_mcap, high_water_mcap,
      strategy_id, scout_policy_version_id, scout_policy_score, snapshot_json
    ) VALUES ('OpenMint111111111111111111111111111111', 'OPEN', 'open', ?, 'dry_run', 10000, 11000, 'scout', 1, -0.02, ?)
  `).run(Date.now() - 60_000, featureSnapshot());
}

async function runReport(dbPath) {
  const { stdout } = await exec(process.execPath, [
    'scripts/scout_learner_readiness_report.js',
    `--db=${dbPath}`,
    '--min-closed=10',
    '--format=json',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHARON_SKIP_DOTENV: 'true',
    },
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('scout learner readiness blocks when scout positions are still open', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    for (let i = 0; i < 10; i += 1) insertClosed(db);
    insertOpen(db);
    insertOpen(db);

    const report = await runReport(dbPath);

    assert.equal(report.readiness.status, 'BLOCK_LEARNER_RUN');
    assert.equal(report.readiness.ready, false);
    assert(report.readiness.blocks.some(block => block.code === 'open_positions_pending'));
    assert(report.readiness.blocks.some(block => block.code === 'open_censor_rate_high'));
    assert.equal(report.scout_positions.totals.closed_positions, 10);
    assert.equal(report.scout_positions.totals.open_positions, 2);
  });
});

test('scout learner readiness warns but does not block a closed negative sample', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    for (let i = 0; i < 10; i += 1) insertClosed(db);

    const report = await runReport(dbPath);

    assert.equal(report.readiness.status, 'WARN_MANUAL_REVIEW');
    assert.equal(report.readiness.ready, true);
    assert.deepEqual(report.readiness.blocks, []);
    assert(report.readiness.warnings.some(warning => warning.code === 'negative_realized_pnl'));
    assert(report.readiness.warnings.some(warning => warning.code === 'no_tp_outcomes'));
    assert(report.readiness.warnings.some(warning => warning.code === 'high_sl_rate'));
  });
});

test('scout learner readiness simulates pending reward impact without writing events', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    for (let i = 0; i < 10; i += 1) insertClosed(db);

    const before = db.prepare('SELECT COUNT(*) AS n FROM scout_reward_events').get().n;
    const report = await runReport(dbPath);
    const after = db.prepare('SELECT COUNT(*) AS n FROM scout_reward_events').get().n;

    assert.equal(before, 0);
    assert.equal(after, 0);
    assert.equal(report.learner_impact_simulation.available, true);
    assert.equal(report.learner_impact_simulation.projected_events_from_pending_positions, 10);
    assert.equal(report.learner_impact_simulation.existing_unapplied_events, 0);
    assert(report.learner_impact_simulation.simulated_updates > 0);
    assert(report.learner_impact_simulation.top_negative_deltas.length > 0);
  });
});

test('scout learner readiness rejects invalid arguments before DB open', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/scout_learner_readiness_report.js', '--min-closed=0'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHARON_SKIP_DOTENV: 'true',
      },
      maxBuffer: 1024 * 1024,
    }),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--db is required|--min-closed must be a positive integer/);
      return true;
    },
  );
});
