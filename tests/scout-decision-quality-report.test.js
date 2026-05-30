import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const exec = promisify(execFile);

async function withTempDb(fn, { minimal = false } = {}) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-scout-decision-quality-'));
  const dbPath = path.join(tempDir, 'scout.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE strategies (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, config_json TEXT);
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('trading_mode', 'dry_run')").run();
    db.prepare("INSERT INTO strategies (id, name, enabled, config_json) VALUES ('scout', 'Scout', 1, ?)").run(JSON.stringify({
      max_open_positions: 1,
      use_llm: true,
    }));

    if (!minimal) {
      db.exec(`
        CREATE TABLE llm_usage_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          provider TEXT,
          model TEXT,
          batch_id INTEGER,
          request_bytes INTEGER,
          response_bytes INTEGER,
          latency_ms INTEGER,
          total_tokens INTEGER,
          error_class TEXT
        );
        CREATE TABLE llm_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at_ms INTEGER NOT NULL,
          selected_mint TEXT,
          verdict TEXT NOT NULL,
          confidence REAL NOT NULL,
          payload_size_bytes INTEGER,
          candidate_count INTEGER,
          raw_json TEXT NOT NULL
        );
        CREATE TABLE scout_llm_admissions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER,
          mint TEXT,
          created_at_ms INTEGER NOT NULL,
          admitted INTEGER NOT NULL,
          reason TEXT,
          pre_score REAL,
          batch_id INTEGER
        );
        CREATE TABLE dry_run_positions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          candidate_id INTEGER,
          mint TEXT NOT NULL,
          symbol TEXT,
          status TEXT NOT NULL,
          opened_at_ms INTEGER NOT NULL,
          closed_at_ms INTEGER,
          size_sol REAL NOT NULL,
          entry_mcap REAL,
          exit_reason TEXT,
          pnl_percent REAL,
          pnl_sol REAL,
          execution_mode TEXT DEFAULT 'dry_run',
          strategy_id TEXT DEFAULT 'scout',
          scout_policy_version_id INTEGER,
          scout_policy_score REAL,
          snapshot_json TEXT NOT NULL
        );
      `);
    }

    return await fn({ db, dbPath });
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

async function runReport(dbPath, args = []) {
  const { stdout } = await exec(process.execPath, [
    'scripts/scout_decision_quality_report.js',
    `--db=${dbPath}`,
    '--since-ms=1000',
    '--format=json',
    ...args,
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

test('scout_decision_quality_report summarizes scout decisions without full mints or raw LLM payloads', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    const oldMint = 'OldMintShouldNotAppear111111111111111111111111';
    const mintA = 'MintAlphaDecisionQuality111111111111111111111';
    const mintB = 'MintBravoDecisionQuality222222222222222222222';

    db.prepare(`
      INSERT INTO llm_usage_events (created_at_ms, status, provider, model, batch_id, request_bytes, response_bytes, latency_ms, total_tokens, error_class)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(1_100, 'success', 'gemini', 'gemini-2.5-flash', 1, 2000, 300, 900, 400, null);
    db.prepare(`
      INSERT INTO llm_batches (created_at_ms, selected_mint, verdict, confidence, payload_size_bytes, candidate_count, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(1_200, mintA, 'BUY', 82, 12_000, 7, '{"raw":"must not print"}');
    db.prepare(`
      INSERT INTO scout_llm_admissions (candidate_id, mint, created_at_ms, admitted, reason, pre_score, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(8, mintA, 1_150, 1, 'score_admit', 0.07, 1);
    db.prepare(`
      INSERT INTO scout_llm_admissions (candidate_id, mint, created_at_ms, admitted, reason, pre_score, batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(9, mintB, 1_170, 0, 'score_skip', -0.03, null);
    db.prepare(`
      INSERT INTO dry_run_positions (
        mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
        exit_reason, pnl_percent, pnl_sol, execution_mode, strategy_id, snapshot_json
      ) VALUES (?, 'ALP', 'closed', 1300, 1700, 0.02, 14000, 'TP', 53.36, 0.010672, 'dry_run', 'scout', '{}')
    `).run(mintA);
    db.prepare(`
      INSERT INTO dry_run_positions (
        mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
        exit_reason, pnl_percent, pnl_sol, execution_mode, strategy_id, snapshot_json
      ) VALUES (?, 'BRV', 'closed', 1400, 1800, 0.02, 13000, 'SL', -64.65, -0.01293, 'dry_run', 'scout', '{}')
    `).run(mintB);
    db.prepare(`
      INSERT INTO dry_run_positions (
        mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_mcap,
        exit_reason, pnl_percent, pnl_sol, execution_mode, strategy_id, snapshot_json
      ) VALUES (?, 'OLD', 'closed', 100, 900, 0.02, 13000, 'TP', 60, 0.01, 'dry_run', 'scout', '{}')
    `).run(oldMint);

    const report = await runReport(dbPath);
    const serialized = JSON.stringify(report);

    assert.equal(report.llm_usage.total.events, 1);
    assert.equal(report.llm_batches.verdicts[0].verdict, 'BUY');
    assert.equal(report.scout_llm_admissions.total.events, 2);
    assert.equal(report.scout_positions.closed.count, 2);
    assert.equal(report.scout_positions.closed.exit_reason_counts.find(row => row.exit_reason === 'TP').count, 1);
    assert.equal(report.scout_positions.closed.exit_reason_counts.find(row => row.exit_reason === 'SL').count, 1);
    assert.equal(report.checks.has_closed_positions, true);
    assert.equal(report.checks.no_live_positions, true);
    assert.equal(report.checks.no_provider_errors, true);
    assert.equal(report.checks.has_llm_batches_or_admissions, true);
    assert.equal(report.checks.scout_strategy_active, true);
    assert.equal(report.checks.dry_run_mode, true);
    assert.deepEqual(report.caveats.map(caveat => caveat.code), ['closed_outcome_sample_underpowered']);
    assert.match(report.caveats[0].message, /do not use this report by itself to justify a learner run/i);
    assert.doesNotMatch(serialized, new RegExp(mintA));
    assert.doesNotMatch(serialized, new RegExp(mintB));
    assert.doesNotMatch(serialized, new RegExp(oldMint));
    assert.doesNotMatch(serialized, /raw.+must not print/);
    assert.match(serialized, /MintAlph/);
  });
});

test('scout_decision_quality_report degrades gracefully when optional scout tables are missing', async () => {
  await withTempDb(async ({ dbPath }) => {
    const report = await runReport(dbPath);

    assert.equal(report.llm_usage.available, false);
    assert.equal(report.llm_batches.available, false);
    assert.equal(report.scout_llm_admissions.available, false);
    assert.equal(report.scout_positions.available, false);
    assert.equal(report.checks.has_closed_positions, false);
    assert.equal(report.checks.no_live_positions, true);
    assert.equal(report.checks.no_provider_errors, true);
    assert.equal(report.checks.has_llm_batches_or_admissions, false);
    assert.equal(report.checks.scout_strategy_active, true);
    assert.equal(report.checks.dry_run_mode, true);
  }, { minimal: true });
});
