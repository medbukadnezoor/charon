#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function usage() {
  return [
    'Usage:',
    '  node scripts/scout_llm_canary_report.js --db=/path/charon-scout.sqlite [--hours=2] [--since-ms=TIMESTAMP_MS] [--format=json|text]',
    '',
    'Summarizes scout LLM canary health without reading .env or printing secrets.',
    'For canary readiness, prefer the runner start_ms via --since-ms; broad --hours windows can include stale provider history.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { hours: '2', format: 'json' };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'db' || key === 'hours' || key === 'since-ms' || key === 'format') opts[key] = value;
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  return opts;
}

function requiredDbPath(opts) {
  if (!opts.db) throw new Error(`--db is required.\n\n${usage()}`);
  const resolved = path.resolve(opts.db);
  if (!fs.existsSync(resolved)) throw new Error(`Scout DB not found: ${resolved}`);
  return resolved;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function scalar(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params) || {};
  } catch (err) {
    return { error: err.message };
  }
}

function rows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch (err) {
    return [{ error: err.message }];
  }
}

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function pct(part, total) {
  const a = Number(part) || 0;
  const b = Number(total) || 0;
  return b > 0 ? Number(((a / b) * 100).toFixed(2)) : null;
}

function activeStrategy(db) {
  if (!tableExists(db, 'strategies')) return null;
  const row = db.prepare('SELECT id, name, enabled, config_json FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) return null;
  let config = {};
  try {
    config = JSON.parse(row.config_json || '{}');
  } catch {
    config = {};
  }
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    max_open_positions: config.max_open_positions ?? null,
    use_llm: config.use_llm ?? null,
    llm_min_confidence: config.llm_min_confidence ?? null,
    scout_policy_enabled: config.scout_policy_enabled ?? null,
  };
}

function settingsSnapshot(db) {
  if (!tableExists(db, 'settings')) return {};
  const keys = [
    'trading_mode',
    'scout_policy_enabled',
    'scout_policy_active_version',
    'scout_llm_throttle_enabled',
    'scout_llm_hourly_cap',
    'scout_llm_daily_cap',
    'scout_llm_mint_cooldown_ms',
    'scout_llm_pre_score_threshold',
    'scout_llm_high_score_reserve_threshold',
  ];
  return Object.fromEntries(db.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (${keys.map(() => '?').join(',')})
    ORDER BY key
  `).all(...keys).map(row => [row.key, row.value]));
}

function buildReport({ db, dbPath, hours, sinceMs }) {
  const llmTotal = tableExists(db, 'llm_usage_events')
    ? scalar(db, `
      SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_events,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS error_events,
        SUM(CASE WHEN error_class IN ('invalid_decision_schema', 'parse_error') THEN 1 ELSE 0 END) AS schema_error_events,
        SUM(CASE WHEN error_class = 'parse_error' THEN 1 ELSE 0 END) AS parse_error_events,
        SUM(CASE WHEN error_class = 'empty_content' THEN 1 ELSE 0 END) AS empty_content_events,
        SUM(request_bytes) AS request_bytes,
        SUM(response_bytes) AS response_bytes,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(total_tokens) AS total_tokens,
        AVG(latency_ms) AS avg_latency_ms,
        MAX(latency_ms) AS max_latency_ms,
        MIN(created_at_ms) AS first_ms,
        MAX(created_at_ms) AS last_ms
      FROM llm_usage_events
      WHERE created_at_ms >= ?
    `, [sinceMs])
    : {};

  const byProvider = tableExists(db, 'llm_usage_events')
    ? rows(db, `
      SELECT
        provider,
        model,
        status,
        error_class,
        COUNT(*) AS events,
        SUM(request_bytes) AS request_bytes,
        SUM(response_bytes) AS response_bytes,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(total_tokens) AS total_tokens,
        AVG(latency_ms) AS avg_latency_ms,
        MAX(latency_ms) AS max_latency_ms
      FROM llm_usage_events
      WHERE created_at_ms >= ?
      GROUP BY provider, model, status, error_class
      ORDER BY events DESC, provider, model
    `, [sinceMs])
    : [];

  const admissions = tableExists(db, 'scout_llm_admissions')
    ? rows(db, `
      SELECT admitted, reason, COUNT(*) AS events
      FROM scout_llm_admissions
      WHERE created_at_ms >= ?
      GROUP BY admitted, reason
      ORDER BY events DESC
    `, [sinceMs])
    : [];

  const verdicts = tableExists(db, 'llm_batches')
    ? rows(db, `
      SELECT verdict, COUNT(*) AS batches, AVG(confidence) AS avg_confidence
      FROM llm_batches
      WHERE created_at_ms >= ?
      GROUP BY verdict
      ORDER BY batches DESC
    `, [sinceMs])
    : [];

  const recentBatches = tableExists(db, 'llm_batches')
    ? rows(db, `
      SELECT id, created_at_ms, selected_mint, verdict, confidence, payload_size_bytes
      FROM llm_batches
      WHERE created_at_ms >= ?
      ORDER BY id DESC
      LIMIT 10
    `, [sinceMs]).map(row => ({
      ...row,
      created_at_iso: iso(row.created_at_ms),
      selected_mint_prefix: row.selected_mint ? String(row.selected_mint).slice(0, 8) : null,
      selected_mint: undefined,
    }))
    : [];

  const positions = tableExists(db, 'dry_run_positions')
    ? {
        summary: scalar(db, `
          SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status IN ('open', 'partial_exit') THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
            SUM(CASE WHEN status = 'closed' THEN pnl_sol ELSE 0 END) AS realized_pnl_sol
          FROM dry_run_positions
          WHERE strategy_id = 'scout' OR scout_policy_version_id IS NOT NULL
        `),
        recent: rows(db, `
          SELECT id, mint, status, execution_mode, opened_at_ms, closed_at_ms, entry_mcap, tp_percent, sl_percent, scout_policy_score
          FROM dry_run_positions
          WHERE strategy_id = 'scout' OR scout_policy_version_id IS NOT NULL
          ORDER BY id DESC
          LIMIT 10
        `).map(row => ({
          ...row,
          mint_prefix: row.mint ? String(row.mint).slice(0, 8) : null,
          mint: undefined,
          opened_at_iso: iso(row.opened_at_ms),
          closed_at_iso: iso(row.closed_at_ms),
        })),
      }
    : { summary: {}, recent: [] };

  const queue = tableExists(db, 'token_observation_queue')
    ? rows(db, `
      SELECT decision_stage, decision_action, eligibility_reason, COUNT(*) AS events
      FROM token_observation_queue
      WHERE created_at_ms >= ?
      GROUP BY decision_stage, decision_action, eligibility_reason
      ORDER BY events DESC
      LIMIT 20
    `, [sinceMs])
    : [];

  const events = Number(llmTotal.events) || 0;
  const success = Number(llmTotal.success_events) || 0;
  const errors = Number(llmTotal.error_events) || 0;
  const schemaErrors = Number(llmTotal.schema_error_events) || 0;
  const parseErrors = Number(llmTotal.parse_error_events) || 0;
  const hasGeminiUsage = byProvider.some(row => String(row.provider || '').toLowerCase() === 'gemini');

  return {
    generated_at: new Date().toISOString(),
    db: dbPath,
    window_hours: hours,
    since_ms: sinceMs,
    window_start: iso(sinceMs),
    settings: settingsSnapshot(db),
    active_strategy: activeStrategy(db),
    llm: {
      total: {
        ...llmTotal,
        first_iso: iso(llmTotal.first_ms),
        last_iso: iso(llmTotal.last_ms),
        success_rate_percent: pct(success, events),
        error_rate_percent: pct(errors, events),
        schema_error_rate_percent: pct(schemaErrors, events),
      },
      by_provider_model_status: byProvider,
    },
    admissions,
    verdicts,
    recent_batches: recentBatches,
    positions,
    observation_queue: queue,
    checks: {
      has_llm_calls: events > 0,
      has_gemini_usage: hasGeminiUsage,
      no_mimo_usage: !byProvider.some(row => String(row.provider || '').toLowerCase().includes('mimo')),
      no_cliproxy_usage: !byProvider.some(row => String(row.provider || '').toLowerCase().includes('cliproxy')),
      no_provider_errors: errors === 0,
      no_schema_errors: schemaErrors === 0,
      no_parse_errors: parseErrors === 0,
      no_empty_content_errors: (Number(llmTotal.empty_content_events) || 0) === 0,
      dry_run_mode: settingsSnapshot(db).trading_mode === 'dry_run',
      scout_strategy_active: activeStrategy(db)?.id === 'scout',
    },
  };
}

function printText(report) {
  const total = report.llm.total;
  console.log(`Scout LLM canary report (${report.window_hours}h)`);
  console.log(`generated_at=${report.generated_at}`);
  console.log(`db=${report.db}`);
  console.log(`strategy=${report.active_strategy?.id || 'unknown'} max_open=${report.active_strategy?.max_open_positions ?? 'unknown'}`);
  console.log(`llm_calls=${total.events || 0} success=${total.success_events || 0} errors=${total.error_events || 0} schema_errors=${total.schema_error_events || 0} parse_errors=${total.parse_error_events || 0} tokens=${total.total_tokens || 0}`);
  console.log(`success_rate=${total.success_rate_percent ?? 'n/a'}% avg_latency_ms=${total.avg_latency_ms == null ? 'n/a' : Number(total.avg_latency_ms).toFixed(1)}`);
  console.log(`positions_open=${report.positions.summary.open_count || 0} positions_total=${report.positions.summary.total || 0}`);
  console.log('providers:');
  for (const row of report.llm.by_provider_model_status) {
    console.log(`  ${row.provider}/${row.model} ${row.status}${row.error_class ? `:${row.error_class}` : ''} calls=${row.events} tokens=${row.total_tokens || 0}`);
  }
  console.log('checks:');
  for (const [key, value] of Object.entries(report.checks)) {
    console.log(`  ${key}=${value ? 'PASS' : 'FAIL'}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = requiredDbPath(opts);
  const hours = Number(opts.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number');
  const sinceMs = opts['since-ms'] == null
    ? Date.now() - hours * 60 * 60 * 1000
    : Number(opts['since-ms']);
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) throw new Error('--since-ms must be a positive millisecond timestamp');
  if (!['json', 'text'].includes(opts.format)) throw new Error('--format must be json or text');

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const report = buildReport({ db, dbPath, hours, sinceMs });
    if (opts.format === 'text') printText(report);
    else console.log(JSON.stringify(report, null, 2));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`[scout-llm-canary-report] ${err.message}`);
  process.exit(1);
}
