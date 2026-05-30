#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function usage() {
  return [
    'Usage:',
    '  node scripts/scout_decision_quality_report.js --db=/path/charon-scout.sqlite [--since-ms=TIMESTAMP_MS | --hours=HOURS] [--format=text|json]',
    '',
    'Read-only scout decision quality report. Prints aggregate counts and mint prefixes only.',
    'Does not read .env and does not print raw prompts, raw responses, raw_json, or full mint addresses.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { hours: '24', format: 'text' };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'db' || key === 'since-ms' || key === 'hours' || key === 'format') opts[key] = value;
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

function sinceMsFromOpts(opts) {
  if (opts['since-ms'] != null) {
    const sinceMs = Number(opts['since-ms']);
    if (!Number.isFinite(sinceMs) || sinceMs <= 0) throw new Error('--since-ms must be a positive millisecond timestamp');
    return sinceMs;
  }
  const hours = Number(opts.hours);
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number');
  return Date.now() - hours * 60 * 60 * 1000;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnsFor(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function col(columns, name, fallback = 'NULL') {
  return columns.has(name) ? name : `${fallback} AS ${name}`;
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
  return ms ? new Date(Number(ms)).toISOString() : null;
}

function pct(part, total) {
  const a = Number(part) || 0;
  const b = Number(total) || 0;
  return b > 0 ? Number(((a / b) * 100).toFixed(2)) : null;
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function numOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mintPrefix(mint) {
  return mint ? String(mint).slice(0, 8) : null;
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
  };
}

function settingsSnapshot(db) {
  if (!tableExists(db, 'settings')) return {};
  const keys = ['trading_mode', 'scout_policy_enabled', 'scout_policy_active_version', 'scout_llm_throttle_enabled'];
  return Object.fromEntries(db.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (${keys.map(() => '?').join(',')})
    ORDER BY key
  `).all(...keys).map(row => [row.key, row.value]));
}

function scoutPositionWhere(columns, timeColumn) {
  const strategyClause = columns.has('strategy_id') ? "strategy_id = 'scout'" : '1 = 0';
  const policyClause = columns.has('scout_policy_version_id') ? 'scout_policy_version_id IS NOT NULL' : '1 = 0';
  return `(${strategyClause} OR ${policyClause}) AND ${timeColumn} >= ?`;
}

function llmUsageReport(db, sinceMs) {
  if (!tableExists(db, 'llm_usage_events')) return { available: false, total: {}, by_provider_model_status_error: [] };
  const columns = columnsFor(db, 'llm_usage_events');
  const errorClass = columns.has('error_class') ? 'error_class' : 'NULL';
  const provider = columns.has('provider') ? 'provider' : 'NULL';
  const model = columns.has('model') ? 'model' : 'NULL';
  const totalTokens = columns.has('total_tokens') ? 'SUM(total_tokens) AS total_tokens' : 'NULL AS total_tokens';
  const requestBytes = columns.has('request_bytes') ? 'SUM(request_bytes) AS request_bytes' : 'NULL AS request_bytes';
  const responseBytes = columns.has('response_bytes') ? 'SUM(response_bytes) AS response_bytes' : 'NULL AS response_bytes';
  const latency = columns.has('latency_ms') ? 'AVG(latency_ms) AS avg_latency_ms, MAX(latency_ms) AS max_latency_ms' : 'NULL AS avg_latency_ms, NULL AS max_latency_ms';

  const total = scalar(db, `
    SELECT
      COUNT(*) AS events,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_events,
      SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS error_events,
      SUM(CASE WHEN ${errorClass} IS NOT NULL THEN 1 ELSE 0 END) AS classified_error_events,
      SUM(CASE WHEN ${errorClass} IN ('parse_error', 'invalid_decision_schema', 'empty_content') THEN 1 ELSE 0 END) AS parse_schema_empty_events,
      ${requestBytes},
      ${responseBytes},
      ${totalTokens},
      ${latency},
      MIN(created_at_ms) AS first_ms,
      MAX(created_at_ms) AS last_ms
    FROM llm_usage_events
    WHERE created_at_ms >= ?
  `, [sinceMs]);

  const byProvider = rows(db, `
    SELECT
      ${provider} AS provider,
      ${model} AS model,
      status,
      ${errorClass} AS error_class,
      COUNT(*) AS events,
      ${totalTokens},
      ${latency}
    FROM llm_usage_events
    WHERE created_at_ms >= ?
    GROUP BY provider, model, status, error_class
    ORDER BY events DESC, provider, model, status, error_class
  `, [sinceMs]);

  const events = num(total.events);
  const errors = num(total.error_events);
  return {
    available: true,
    total: {
      ...total,
      first_iso: iso(total.first_ms),
      last_iso: iso(total.last_ms),
      success_rate_percent: pct(total.success_events, events),
      error_rate_percent: pct(errors, events),
    },
    by_provider_model_status_error: byProvider,
  };
}

function llmBatchReport(db, sinceMs) {
  if (!tableExists(db, 'llm_batches')) return { available: false, total: {}, verdicts: [], recent: [] };
  const columns = columnsFor(db, 'llm_batches');
  const verdicts = rows(db, `
    SELECT
      verdict,
      COUNT(*) AS count,
      AVG(confidence) AS avg_confidence,
      MIN(confidence) AS min_confidence,
      MAX(confidence) AS max_confidence
    FROM llm_batches
    WHERE created_at_ms >= ?
    GROUP BY verdict
    ORDER BY count DESC, verdict
  `, [sinceMs]).map(row => ({
    verdict: row.verdict,
    count: num(row.count),
    avg_confidence: numOrNull(row.avg_confidence),
    min_confidence: numOrNull(row.min_confidence),
    max_confidence: numOrNull(row.max_confidence),
  }));

  const total = scalar(db, `
    SELECT
      COUNT(*) AS batches,
      AVG(confidence) AS avg_confidence,
      ${columns.has('payload_size_bytes') ? 'AVG(payload_size_bytes)' : 'NULL'} AS avg_payload_size_bytes,
      ${columns.has('candidate_count') ? 'AVG(candidate_count)' : 'NULL'} AS avg_candidate_count,
      MIN(created_at_ms) AS first_ms,
      MAX(created_at_ms) AS last_ms
    FROM llm_batches
    WHERE created_at_ms >= ?
  `, [sinceMs]);

  const recent = rows(db, `
    SELECT
      id,
      created_at_ms,
      ${col(columns, 'selected_mint')},
      verdict,
      confidence,
      ${col(columns, 'payload_size_bytes')},
      ${col(columns, 'candidate_count')}
    FROM llm_batches
    WHERE created_at_ms >= ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT 12
  `, [sinceMs]).map(row => ({
    id: row.id,
    created_at_ms: row.created_at_ms,
    created_at_iso: iso(row.created_at_ms),
    selected_mint_prefix: mintPrefix(row.selected_mint),
    verdict: row.verdict,
    confidence: numOrNull(row.confidence),
    payload_size_bytes: numOrNull(row.payload_size_bytes),
    candidate_count: numOrNull(row.candidate_count),
  }));

  return {
    available: true,
    total: {
      ...total,
      batches: num(total.batches),
      first_iso: iso(total.first_ms),
      last_iso: iso(total.last_ms),
    },
    verdicts,
    recent,
  };
}

function admissionsReport(db, sinceMs) {
  if (!tableExists(db, 'scout_llm_admissions')) return { available: false, total: {}, admitted_counts: [], reason_counts: [], recent: [] };
  const columns = columnsFor(db, 'scout_llm_admissions');
  const total = scalar(db, `
    SELECT
      COUNT(*) AS events,
      SUM(CASE WHEN admitted = 1 THEN 1 ELSE 0 END) AS admitted,
      SUM(CASE WHEN admitted = 0 THEN 1 ELSE 0 END) AS rejected,
      AVG(${columns.has('pre_score') ? 'pre_score' : 'NULL'}) AS avg_pre_score,
      MIN(created_at_ms) AS first_ms,
      MAX(created_at_ms) AS last_ms
    FROM scout_llm_admissions
    WHERE created_at_ms >= ?
  `, [sinceMs]);

  const admittedCounts = rows(db, `
    SELECT admitted, COUNT(*) AS count
    FROM scout_llm_admissions
    WHERE created_at_ms >= ?
    GROUP BY admitted
    ORDER BY admitted DESC
  `, [sinceMs]).map(row => ({ admitted: Boolean(row.admitted), count: num(row.count) }));

  const reasonCounts = rows(db, `
    SELECT ${col(columns, 'reason', "'unknown'")} , admitted, COUNT(*) AS count
    FROM scout_llm_admissions
    WHERE created_at_ms >= ?
    GROUP BY reason, admitted
    ORDER BY count DESC, reason
  `, [sinceMs]).map(row => ({ reason: row.reason || 'unknown', admitted: Boolean(row.admitted), count: num(row.count) }));

  const recent = rows(db, `
    SELECT
      id,
      created_at_ms,
      ${col(columns, 'mint')},
      admitted,
      ${col(columns, 'reason', "'unknown'")},
      ${col(columns, 'pre_score')},
      ${col(columns, 'batch_id')}
    FROM scout_llm_admissions
    WHERE created_at_ms >= ?
    ORDER BY created_at_ms DESC, id DESC
    LIMIT 12
  `, [sinceMs]).map(row => ({
    id: row.id,
    created_at_ms: row.created_at_ms,
    created_at_iso: iso(row.created_at_ms),
    mint_prefix: mintPrefix(row.mint),
    admitted: Boolean(row.admitted),
    reason: row.reason || 'unknown',
    pre_score: numOrNull(row.pre_score),
    batch_id: row.batch_id ?? null,
  }));

  return {
    available: true,
    total: {
      ...total,
      events: num(total.events),
      admitted: num(total.admitted),
      rejected: num(total.rejected),
      first_iso: iso(total.first_ms),
      last_iso: iso(total.last_ms),
    },
    admitted_counts: admittedCounts,
    reason_counts: reasonCounts,
    recent,
  };
}

function positionsReport(db, sinceMs) {
  if (!tableExists(db, 'dry_run_positions')) return { available: false, opened: {}, closed: {}, recent: [] };
  const columns = columnsFor(db, 'dry_run_positions');
  const openedWhere = scoutPositionWhere(columns, 'opened_at_ms');
  const closedAt = columns.has('closed_at_ms') ? 'closed_at_ms' : 'NULL';
  const executionMode = columns.has('execution_mode') ? 'execution_mode' : "'dry_run'";
  const exitReason = columns.has('exit_reason') ? 'exit_reason' : "'unknown'";
  const pnlSol = columns.has('pnl_sol') ? 'pnl_sol' : 'NULL';
  const pnlPercent = columns.has('pnl_percent') ? 'pnl_percent' : 'NULL';

  const opened = scalar(db, `
    SELECT
      COUNT(*) AS count,
      SUM(CASE WHEN status IN ('open', 'partial_exit') THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN ${executionMode} = 'live' THEN 1 ELSE 0 END) AS live_count,
      MIN(opened_at_ms) AS first_ms,
      MAX(opened_at_ms) AS last_ms
    FROM dry_run_positions
    WHERE ${openedWhere}
  `, [sinceMs]);

  const closed = scalar(db, `
    SELECT
      COUNT(*) AS count,
      COALESCE(SUM(${pnlSol}), 0) AS realized_pnl_sol,
      AVG(${pnlPercent}) AS avg_pnl_percent,
      SUM(CASE WHEN ${executionMode} = 'live' THEN 1 ELSE 0 END) AS live_count,
      MIN(${closedAt}) AS first_ms,
      MAX(${closedAt}) AS last_ms
    FROM dry_run_positions
    WHERE ${scoutPositionWhere(columns, closedAt)}
      AND status = 'closed'
  `, [sinceMs]);

  const exitReasonCounts = rows(db, `
    SELECT ${exitReason} AS exit_reason, COUNT(*) AS count, COALESCE(SUM(${pnlSol}), 0) AS pnl_sol
    FROM dry_run_positions
    WHERE ${scoutPositionWhere(columns, closedAt)}
      AND status = 'closed'
    GROUP BY exit_reason
    ORDER BY count DESC, exit_reason
  `, [sinceMs]).map(row => ({
    exit_reason: row.exit_reason || 'unknown',
    count: num(row.count),
    pnl_sol: num(row.pnl_sol),
  }));

  const tpCount = exitReasonCounts.filter(row => /^(TP|TRAILING_TP|BREAKEVEN_LOCK)$/i.test(row.exit_reason)).reduce((sum, row) => sum + row.count, 0);
  const slCount = exitReasonCounts.filter(row => /^SL$/i.test(row.exit_reason)).reduce((sum, row) => sum + row.count, 0);
  const cutoffCount = exitReasonCounts.filter(row => /cutoff|TIME_STOP|NO_TP/i.test(row.exit_reason)).reduce((sum, row) => sum + row.count, 0);

  const recent = rows(db, `
    SELECT
      id,
      mint,
      ${col(columns, 'symbol')},
      status,
      opened_at_ms,
      ${col(columns, 'closed_at_ms')},
      ${col(columns, 'execution_mode', "'dry_run'")},
      ${col(columns, 'exit_reason')},
      ${col(columns, 'pnl_sol')},
      ${col(columns, 'pnl_percent')},
      ${col(columns, 'scout_policy_score')}
    FROM dry_run_positions
    WHERE ${openedWhere}
       OR (${closedAt} IS NOT NULL AND ${scoutPositionWhere(columns, closedAt)})
    ORDER BY COALESCE(${closedAt}, opened_at_ms) DESC, id DESC
    LIMIT 12
  `, [sinceMs, sinceMs]).map(row => ({
    id: row.id,
    mint_prefix: mintPrefix(row.mint),
    symbol: row.symbol || null,
    status: row.status,
    execution_mode: row.execution_mode || 'dry_run',
    opened_at_ms: row.opened_at_ms,
    opened_at_iso: iso(row.opened_at_ms),
    closed_at_ms: row.closed_at_ms ?? null,
    closed_at_iso: iso(row.closed_at_ms),
    exit_reason: row.exit_reason || null,
    pnl_sol: numOrNull(row.pnl_sol),
    pnl_percent: numOrNull(row.pnl_percent),
    scout_policy_score: numOrNull(row.scout_policy_score),
  }));

  return {
    available: true,
    opened: {
      ...opened,
      count: num(opened.count),
      open_count: num(opened.open_count),
      live_count: num(opened.live_count),
      first_iso: iso(opened.first_ms),
      last_iso: iso(opened.last_ms),
    },
    closed: {
      ...closed,
      count: num(closed.count),
      live_count: num(closed.live_count),
      realized_pnl_sol: num(closed.realized_pnl_sol),
      avg_pnl_percent: numOrNull(closed.avg_pnl_percent),
      tp_count: tpCount,
      sl_count: slCount,
      cutoff_count: cutoffCount,
      exit_reason_counts: exitReasonCounts,
      first_iso: iso(closed.first_ms),
      last_iso: iso(closed.last_ms),
    },
    recent,
  };
}

function reportCaveats({ positions }) {
  const caveats = [];
  const closedCount = num(positions.closed?.count);
  if (closedCount < 10) {
    caveats.push({
      code: 'closed_outcome_sample_underpowered',
      message: 'Fewer than 10 closed scout outcomes in this window; do not use this report by itself to justify a learner run.',
      observed_count: closedCount,
      minimum_count: 10,
    });
  }
  return caveats;
}

function buildReport({ db, dbPath, sinceMs, format }) {
  const settings = settingsSnapshot(db);
  const strategy = activeStrategy(db);
  const llmUsage = llmUsageReport(db, sinceMs);
  const llmBatches = llmBatchReport(db, sinceMs);
  const admissions = admissionsReport(db, sinceMs);
  const positions = positionsReport(db, sinceMs);
  const providerErrors = num(llmUsage.total?.error_events);
  const batchCount = num(llmBatches.total?.batches);
  const admissionEvents = num(admissions.total?.events);
  const openedLive = num(positions.opened?.live_count);
  const closedLive = num(positions.closed?.live_count);
  const caveats = reportCaveats({ positions });

  return {
    generated_at: new Date().toISOString(),
    db: dbPath,
    since_ms: sinceMs,
    window_start: iso(sinceMs),
    format,
    settings,
    active_strategy: strategy,
    llm_usage: llmUsage,
    llm_batches: llmBatches,
    scout_llm_admissions: admissions,
    scout_positions: positions,
    caveats,
    checks: {
      has_closed_positions: num(positions.closed?.count) > 0,
      no_live_positions: openedLive + closedLive === 0,
      no_provider_errors: providerErrors === 0,
      has_llm_batches_or_admissions: batchCount + admissionEvents > 0,
      scout_strategy_active: strategy?.id === 'scout' && strategy.enabled === true,
      dry_run_mode: settings.trading_mode === 'dry_run',
    },
  };
}

function fmt(value, digits = 6) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return String(value);
}

function printText(report) {
  console.log('Scout decision quality report');
  console.log(`generated_at=${report.generated_at}`);
  console.log(`db=${report.db}`);
  console.log(`window_start=${report.window_start}`);
  console.log(`strategy=${report.active_strategy?.id || 'unknown'} trading_mode=${report.settings.trading_mode || 'unknown'}`);
  console.log('');
  console.log('llm_usage:');
  console.log(`  events=${fmt(report.llm_usage.total.events || 0, 0)} success=${fmt(report.llm_usage.total.success_events || 0, 0)} errors=${fmt(report.llm_usage.total.error_events || 0, 0)} success_rate=${fmt(report.llm_usage.total.success_rate_percent, 2)}%`);
  for (const row of report.llm_usage.by_provider_model_status_error || []) {
    console.log(`  ${row.provider || 'unknown'}/${row.model || 'unknown'} ${row.status}${row.error_class ? `:${row.error_class}` : ''} events=${row.events}`);
  }
  console.log('');
  console.log('llm_batches:');
  for (const row of report.llm_batches.verdicts || []) {
    console.log(`  ${row.verdict || 'unknown'} count=${row.count} avg_confidence=${fmt(row.avg_confidence, 2)}`);
  }
  console.log('');
  console.log('scout_llm_admissions:');
  for (const row of report.scout_llm_admissions.reason_counts || []) {
    console.log(`  ${row.admitted ? 'admitted' : 'rejected'} reason=${row.reason} count=${row.count}`);
  }
  console.log('');
  console.log('scout_positions:');
  console.log(`  opened=${fmt(report.scout_positions.opened.count || 0, 0)} open_now=${fmt(report.scout_positions.opened.open_count || 0, 0)} closed=${fmt(report.scout_positions.closed.count || 0, 0)} pnl_sol=${fmt(report.scout_positions.closed.realized_pnl_sol)}`);
  console.log(`  tp=${fmt(report.scout_positions.closed.tp_count || 0, 0)} sl=${fmt(report.scout_positions.closed.sl_count || 0, 0)} cutoff=${fmt(report.scout_positions.closed.cutoff_count || 0, 0)}`);
  for (const row of report.scout_positions.closed.exit_reason_counts || []) {
    console.log(`  exit_reason=${row.exit_reason} count=${row.count} pnl_sol=${fmt(row.pnl_sol)}`);
  }
  console.log('');
  console.log('caveats:');
  if (report.caveats.length === 0) console.log('  none');
  for (const caveat of report.caveats) {
    console.log(`  ${caveat.code}: ${caveat.message}`);
  }
  console.log('');
  console.log('recent_batches:');
  for (const row of report.llm_batches.recent || []) {
    console.log(`  #${row.id} ${row.created_at_iso} mint=${row.selected_mint_prefix || 'none'} verdict=${row.verdict} confidence=${fmt(row.confidence, 2)}`);
  }
  console.log('recent_positions:');
  for (const row of report.scout_positions.recent || []) {
    console.log(`  #${row.id} ${row.mint_prefix || 'none'} ${row.symbol || ''} ${row.status} mode=${row.execution_mode} exit=${row.exit_reason || 'n/a'} pnl_sol=${fmt(row.pnl_sol)}`);
  }
  console.log('');
  console.log('checks:');
  for (const [key, value] of Object.entries(report.checks)) {
    console.log(`  ${key}=${value ? 'PASS' : 'FAIL'}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['json', 'text'].includes(opts.format)) throw new Error('--format must be json or text');
  const dbPath = requiredDbPath(opts);
  const sinceMs = sinceMsFromOpts(opts);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const report = buildReport({ db, dbPath, sinceMs, format: opts.format });
    if (opts.format === 'json') console.log(JSON.stringify(report, null, 2));
    else printText(report);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`[scout-decision-quality-report] ${err.message}`);
  process.exit(1);
}
