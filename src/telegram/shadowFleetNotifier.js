import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  DB_PATH,
  SHADOW_FLEET_NOTIFIER_ENABLED,
  SHADOW_FLEET_NOTIFIER_INITIAL_DELAY_MS,
  SHADOW_FLEET_NOTIFIER_INTERVAL_MS,
  SHADOW_FLEET_NOTIFIER_WINDOW_MS,
  SHADOW_MODE,
} from '../config.js';
import { escapeHtml } from '../format.js';

const execFileAsync = promisify(execFile);
const DEFAULT_PM2_NAMES = [
  'charon-shadow',
  'charon-shadow-observation-collector',
  'charon-shadow-sync',
  'charon-ohlcv-export',
];

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function settingValue(db, key, fallback = null) {
  if (!tableExists(db, 'settings')) return fallback;
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

function safeCount(db, sql, params = []) {
  try {
    return Number(db.prepare(sql).get(...params)?.count || 0);
  } catch {
    return 0;
  }
}

function ageText(ms, atMs) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return 'never';
  const delta = Math.max(0, atMs - n);
  if (delta < 60_000) return 'now';
  if (delta < 60 * 60_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 24 * 60 * 60_000) return `${Math.floor(delta / (60 * 60_000))}h ago`;
  return `${Math.floor(delta / (24 * 60 * 60_000))}d ago`;
}

function statusMark(status) {
  return status === 'online' ? 'OK' : 'WARN';
}

function parsePm2List(stdout) {
  const rows = JSON.parse(stdout || '[]');
  return rows.map(row => ({
    name: row.name,
    status: row.pm2_env?.status || 'unknown',
    exitCode: row.pm2_env?.exit_code ?? null,
    restarts: row.pm2_env?.restart_time ?? 0,
    unstableRestarts: row.pm2_env?.unstable_restarts ?? 0,
    cron: row.pm2_env?.cron_restart || null,
  }));
}

export async function collectPm2Status({ names = DEFAULT_PM2_NAMES, execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl('pm2', ['jlist'], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
    const wanted = new Set(names);
    return parsePm2List(stdout).filter(row => wanted.has(row.name));
  } catch (err) {
    return [{ name: 'pm2', status: 'error', exitCode: null, restarts: 0, unstableRestarts: 0, error: err.message }];
  }
}

function providerRows(db, sinceMs) {
  if (!tableExists(db, 'provider_call_ledger')) return [];
  return db.prepare(`
    SELECT provider, endpoint, status, COUNT(*) AS count
    FROM provider_call_ledger
    WHERE at_ms >= ?
    GROUP BY provider, endpoint, status
    ORDER BY provider, endpoint, status
  `).all(sinceMs);
}

function queueRows(db) {
  if (!tableExists(db, 'token_observation_queue')) return [];
  return db.prepare(`
    SELECT tier, status, watch_status, COUNT(*) AS count
    FROM token_observation_queue
    GROUP BY tier, status, watch_status
    ORDER BY tier, status, watch_status
  `).all();
}

function lastCollectorRun(db) {
  if (!tableExists(db, 'telemetry_collector_runs')) return null;
  return db.prepare(`
    SELECT collector_id, status, claimed_count, observed_count, provider_ok_count,
      provider_error_count, budget_skip_count, started_at_ms, finished_at_ms, last_error
    FROM telemetry_collector_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() || null;
}

export function collectShadowDbSummary({ dbPath, atMs = Date.now(), windowMs = 30 * 60_000 } = {}) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const sinceMs = atMs - windowMs;
    const budgetStart = Number(settingValue(db, 'telemetry_birdeye_budget_start_ms', 0)) || 0;
    const budgetSinceMs = Math.max(sinceMs, budgetStart);
    const dailyCap = Number(settingValue(db, 'telemetry_birdeye_daily_call_cap', 0)) || 0;
    const observations = tableExists(db, 'token_observations')
      ? db.prepare(`
        SELECT COUNT(*) AS count, MAX(observed_at_ms) AS newest_ms
        FROM token_observations
        WHERE source_instance = 'shadow' AND observed_at_ms >= ?
      `).get(sinceMs)
      : { count: 0, newest_ms: null };
    const candidates = tableExists(db, 'candidates')
      ? db.prepare('SELECT COUNT(*) AS count, MAX(created_at_ms) AS newest_ms FROM candidates WHERE created_at_ms >= ?').get(sinceMs)
      : { count: 0, newest_ms: null };
    const openPositions = safeCount(db, "SELECT COUNT(*) AS count FROM dry_run_positions WHERE status IN ('open', 'partial_exit')");
    return {
      dbPath,
      windowMs,
      sinceMs,
      budgetStart,
      budgetSinceMs,
      dailyCap,
      candidates,
      observations,
      openPositions,
      providerRows: providerRows(db, budgetSinceMs),
      queueRows: queueRows(db),
      lastCollectorRun: lastCollectorRun(db),
    };
  } finally {
    db.close();
  }
}

function providerText(rows, dailyCap) {
  const birdeye = rows.filter(row => row.provider === 'birdeye');
  if (!birdeye.length) return `Birdeye: 0${dailyCap ? ` / ${dailyCap}` : ''}`;
  const networkCalls = birdeye
    .filter(row => row.endpoint !== 'budget_policy' && ['ok', 'error'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const parts = birdeye.map(row => `${row.endpoint.replace('/defi/v3/', '')}:${row.status}=${row.count}`);
  return `Birdeye: ${networkCalls}${dailyCap ? ` / ${dailyCap}` : ''} (${parts.join(', ')})`;
}

function queueText(rows) {
  if (!rows.length) return 'Queue: unavailable';
  const activePending = rows
    .filter(row => row.status === 'pending' && ['active', 'promoted'].includes(row.watch_status))
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const errors = rows
    .filter(row => row.status === 'error')
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  const observed = rows
    .filter(row => row.status === 'observed')
    .reduce((sum, row) => sum + Number(row.count || 0), 0);
  return `Queue: pending=${activePending}, observed=${observed}, errors=${errors}`;
}

function collectorText(run, atMs) {
  if (!run) return 'Collector: no runs';
  const lastAt = Number(run.finished_at_ms || run.started_at_ms || 0);
  const error = run.last_error ? `, last=${String(run.last_error).slice(0, 120)}` : '';
  return `Collector: ${run.status}, claimed=${run.claimed_count}, observed=${run.observed_count}, ok=${run.provider_ok_count}, err=${run.provider_error_count}, budget=${run.budget_skip_count}, ${ageText(lastAt, atMs)}${error}`;
}

export function buildShadowFleetMessage({ pm2Rows = [], dbSummary, atMs = Date.now() } = {}) {
  const lines = [
    '<b>Shadow Fleet</b>',
    `At: <code>${escapeHtml(new Date(atMs).toISOString())}</code>`,
    '',
    '<b>Processes</b>',
  ];
  if (!pm2Rows.length) {
    lines.push('No PM2 rows found.');
  } else {
    for (const row of pm2Rows) {
      const extra = row.status === 'stopped' && row.cron ? ` cron=${row.cron} exit=${row.exitCode ?? 'n/a'}` : '';
      const unstable = Number(row.unstableRestarts || 0) > 0 ? ` unstable=${row.unstableRestarts}` : '';
      lines.push(`${statusMark(row.status)} <code>${escapeHtml(row.name)}</code>: ${escapeHtml(row.status)} restarts=${row.restarts}${unstable}${escapeHtml(extra)}`);
    }
  }
  lines.push(
    '',
    '<b>Shadow DB</b>',
    `Candidates: ${Number(dbSummary?.candidates?.count || 0)} recent, latest=${escapeHtml(ageText(dbSummary?.candidates?.newest_ms, atMs))}`,
    `OHLCV observations: ${Number(dbSummary?.observations?.count || 0)} recent, latest=${escapeHtml(ageText(dbSummary?.observations?.newest_ms, atMs))}`,
    `Open dry-run positions: ${Number(dbSummary?.openPositions || 0)}`,
    escapeHtml(providerText(dbSummary?.providerRows || [], Number(dbSummary?.dailyCap || 0))),
    escapeHtml(queueText(dbSummary?.queueRows || [])),
    escapeHtml(collectorText(dbSummary?.lastCollectorRun || null, atMs)),
  );
  return lines.join('\n');
}

export async function buildShadowFleetNotification({
  dbPath,
  atMs = Date.now(),
  windowMs = 30 * 60_000,
  pm2Names = DEFAULT_PM2_NAMES,
  execFileImpl,
} = {}) {
  const [pm2Rows, dbSummary] = await Promise.all([
    collectPm2Status({ names: pm2Names, execFileImpl }),
    Promise.resolve(collectShadowDbSummary({ dbPath, atMs, windowMs })),
  ]);
  return {
    pm2Rows,
    dbSummary,
    message: buildShadowFleetMessage({ pm2Rows, dbSummary, atMs }),
  };
}

let notifierStarted = false;

export function startShadowFleetNotifier({
  dbPath = DB_PATH,
  intervalMs = SHADOW_FLEET_NOTIFIER_INTERVAL_MS,
  initialDelayMs = SHADOW_FLEET_NOTIFIER_INITIAL_DELAY_MS,
  windowMs = SHADOW_FLEET_NOTIFIER_WINDOW_MS,
  sendFn = null,
  setIntervalFn = setInterval,
  setTimeoutFn = setTimeout,
  consoleObj = console,
} = {}) {
  if (!SHADOW_MODE || !SHADOW_FLEET_NOTIFIER_ENABLED || notifierStarted) return false;
  notifierStarted = true;
  const run = async () => {
    try {
      const { message } = await buildShadowFleetNotification({ dbPath, windowMs });
      const deliver = sendFn || (await import('./send.js')).sendTelegram;
      await deliver(message);
      consoleObj.log('[shadow-notifier] summary sent');
    } catch (err) {
      consoleObj.log(`[shadow-notifier] ${err.message}`);
    }
  };
  setTimeoutFn(run, Math.max(0, Number(initialDelayMs) || 0));
  setIntervalFn(run, Math.max(5 * 60_000, Number(intervalMs) || 30 * 60_000));
  return true;
}
