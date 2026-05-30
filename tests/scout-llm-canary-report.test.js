import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';

const exec = promisify(execFile);

async function withTempDb(fn) {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-scout-canary-'));
  const dbPath = path.join(tempDir, 'scout.sqlite');
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE llm_usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT,
        model TEXT,
        status TEXT,
        error_class TEXT,
        request_bytes INTEGER,
        response_bytes INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        latency_ms INTEGER,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE strategies (id TEXT PRIMARY KEY, name TEXT, enabled INTEGER, config_json TEXT);
    `);
    db.prepare("INSERT INTO settings (key, value) VALUES ('trading_mode', 'dry_run')").run();
    db.prepare("INSERT INTO strategies (id, name, enabled, config_json) VALUES ('scout', 'Scout', 1, ?)").run(JSON.stringify({
      max_open_positions: 2,
      use_llm: true,
      scout_policy_enabled: true,
    }));
    return await fn({ db, dbPath });
  } finally {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function insertUsage(db, overrides = {}) {
  db.prepare(`
    INSERT INTO llm_usage_events (
      provider,
      model,
      status,
      error_class,
      request_bytes,
      response_bytes,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      latency_ms,
      created_at_ms
    ) VALUES (
      @provider,
      @model,
      @status,
      @error_class,
      @request_bytes,
      @response_bytes,
      @prompt_tokens,
      @completion_tokens,
      @total_tokens,
      @latency_ms,
      @created_at_ms
    )
  `).run({
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    status: 'success',
    error_class: null,
    request_bytes: 1000,
    response_bytes: 100,
    prompt_tokens: 250,
    completion_tokens: 25,
    total_tokens: 275,
    latency_ms: 750,
    created_at_ms: 1_800,
    ...overrides,
  });
}

async function runReport(dbPath) {
  const { stdout } = await exec(process.execPath, [
    'scripts/scout_llm_canary_report.js',
    `--db=${dbPath}`,
    '--since-ms=1000',
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

test('scout_llm_canary_report passes Gemini usage canary checks', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    insertUsage(db);

    const report = await runReport(dbPath);

    assert.equal(report.checks.has_llm_calls, true);
    assert.equal(report.checks.has_gemini_usage, true);
    assert.equal(report.checks.no_provider_errors, true);
    assert.equal(report.checks.no_parse_errors, true);
    assert.equal(report.checks.no_schema_errors, true);
    assert.equal(report.checks.dry_run_mode, true);
    assert.equal(report.checks.scout_strategy_active, true);
  });
});

test('scout_llm_canary_report fails Gemini usage check for Mistral-only usage', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    insertUsage(db, {
      provider: 'mistral',
      model: 'mistral-large-latest',
    });

    const report = await runReport(dbPath);

    assert.equal(report.checks.has_llm_calls, true);
    assert.equal(report.checks.has_gemini_usage, false);
    assert.equal(report.checks.no_provider_errors, true);
    assert.equal(report.checks.no_parse_errors, true);
    assert.equal(report.checks.no_schema_errors, true);
  });
});

test('scout_llm_canary_report treats provider errors as readiness failure', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    insertUsage(db, {
      status: 'error',
      error_class: 'http_503',
      response_bytes: 0,
      completion_tokens: null,
      total_tokens: null,
    });

    const report = await runReport(dbPath);

    assert.equal(report.checks.has_gemini_usage, true);
    assert.equal(report.checks.no_provider_errors, false);
    assert.equal(report.checks.no_parse_errors, true);
    assert.equal(report.checks.no_schema_errors, true);
    assert.equal(report.llm.total.error_events, 1);
  });
});

test('scout_llm_canary_report treats parse_error as parse and schema failure', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    insertUsage(db, {
      status: 'error',
      error_class: 'parse_error',
      response_bytes: 9,
      completion_tokens: null,
      total_tokens: null,
    });

    const report = await runReport(dbPath);

    assert.equal(report.checks.has_gemini_usage, true);
    assert.equal(report.checks.no_provider_errors, false);
    assert.equal(report.checks.no_parse_errors, false);
    assert.equal(report.checks.no_schema_errors, false);
    assert.equal(report.llm.total.parse_error_events, 1);
    assert.equal(report.llm.total.schema_error_events, 1);
  });
});

test('scout_llm_canary_report treats invalid_decision_schema as schema failure', async () => {
  await withTempDb(async ({ db, dbPath }) => {
    insertUsage(db, {
      status: 'error',
      error_class: 'invalid_decision_schema',
      response_bytes: 42,
      completion_tokens: null,
      total_tokens: null,
    });

    const report = await runReport(dbPath);

    assert.equal(report.checks.has_gemini_usage, true);
    assert.equal(report.checks.no_provider_errors, false);
    assert.equal(report.checks.no_parse_errors, true);
    assert.equal(report.checks.no_schema_errors, false);
    assert.equal(report.llm.total.parse_error_events, 0);
    assert.equal(report.llm.total.schema_error_events, 1);
  });
});

test('run_scout_llm_canary rejects bad arguments before PM2 access', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/run_scout_llm_canary.js', '--max-open-positions=0'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHARON_SKIP_DOTENV: 'true',
      },
      maxBuffer: 1024 * 1024,
    }),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--max-open-positions must be a positive integer/);
      assert.doesNotMatch(err.stderr + err.stdout, /pm2/i);
      return true;
    },
  );
});

test('run_scout_llm_canary rejects invalid target closed outcomes before PM2 access', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/run_scout_llm_canary.js', '--target-closed-outcomes=0'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHARON_SKIP_DOTENV: 'true',
      },
      maxBuffer: 1024 * 1024,
    }),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--target-closed-outcomes must be a positive integer/);
      assert.doesNotMatch(err.stderr + err.stdout, /pm2/i);
      return true;
    },
  );
});

test('run_scout_llm_canary rejects invalid temporary scout cap overrides before PM2 access', async () => {
  await assert.rejects(
    exec(process.execPath, ['scripts/run_scout_llm_canary.js', '--scout-daily-buy-cap=0'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHARON_SKIP_DOTENV: 'true',
      },
      maxBuffer: 1024 * 1024,
    }),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--scout-daily-buy-cap must be a positive integer/);
      assert.doesNotMatch(err.stderr + err.stdout, /pm2/i);
      return true;
    },
  );

  await assert.rejects(
    exec(process.execPath, ['scripts/run_scout_llm_canary.js', '--scout-llm-hourly-cap=501'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CHARON_SKIP_DOTENV: 'true',
      },
      maxBuffer: 1024 * 1024,
    }),
    err => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /--scout-llm-hourly-cap above 500 is refused/);
      assert.doesNotMatch(err.stderr + err.stdout, /pm2/i);
      return true;
    },
  );
});
