#!/usr/bin/env node
import fs from 'node:fs';
import Database from 'better-sqlite3';

function parseArgs(argv) {
  const opts = {
    db: process.env.DB_PATH || '/opt/trading-data/charon-scout.sqlite',
    primaryDb: process.env.PRIMARY_DB_PATH || '/opt/trading-data/charon.sqlite',
  };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'primary-db') opts.primaryDb = value;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function scalar(db, sql, params = []) {
  try {
    return db.prepare(sql).get(...params);
  } catch {
    return null;
  }
}

function rows(db, sql, params = []) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function activeStrategy(db) {
  const row = scalar(db, 'SELECT id, name, config_json FROM strategies WHERE enabled = 1 LIMIT 1');
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
    position_size_sol: config.position_size_sol,
    max_open_positions: config.max_open_positions,
    tp_percent: config.tp_percent,
    sl_percent: config.sl_percent,
    use_llm: config.use_llm,
  };
}

function openMintSet(db) {
  if (!tableExists(db, 'dry_run_positions')) return new Set();
  return new Set(db.prepare(`
    SELECT mint FROM dry_run_positions
    WHERE status IN ('open', 'partial_exit')
  `).all().map(row => row.mint));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(opts.db)) throw new Error(`Scout DB not found: ${opts.db}`);
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const primary = fs.existsSync(opts.primaryDb)
    ? new Database(opts.primaryDb, { readonly: true, fileMustExist: true })
    : null;

  const tradingMode = scalar(db, "SELECT value FROM settings WHERE key = 'trading_mode'")?.value || 'unknown';
  const policyEnabled = scalar(db, "SELECT value FROM settings WHERE key = 'scout_policy_enabled'")?.value || 'unknown';
  const activePolicy = scalar(db, "SELECT value FROM settings WHERE key = 'scout_policy_active_version'")?.value || 'unknown';
  const positionCounts = scalar(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('open', 'partial_exit') THEN 1 ELSE 0 END) AS open_count,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
      SUM(CASE WHEN scout_reward_status = 'pending' THEN 1 ELSE 0 END) AS reward_pending,
      SUM(CASE WHEN scout_reward_status = 'recorded' THEN 1 ELSE 0 END) AS reward_recorded
    FROM dry_run_positions
  `) || {};
  const decisions = scalar(db, 'SELECT COUNT(*) AS n FROM scout_policy_decisions')?.n || 0;
  const rewards = scalar(db, 'SELECT COUNT(*) AS n FROM scout_reward_events')?.n || 0;
  const weights = scalar(db, 'SELECT COUNT(*) AS n FROM scout_policy_weights')?.n || 0;
  const candidateStats = scalar(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status != 'filtered' THEN 1 ELSE 0 END) AS filter_passed,
      COUNT(DISTINCT mint) AS unique_mints
    FROM candidates
  `) || {};
  const admissionStats = tableExists(db, 'scout_llm_admissions') ? scalar(db, `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN admitted = 1 THEN 1 ELSE 0 END) AS admitted,
      SUM(CASE WHEN reason = 'cooldown_skip' THEN 1 ELSE 0 END) AS cooldown_skips,
      SUM(CASE WHEN reason = 'score_skip' THEN 1 ELSE 0 END) AS score_skips,
      SUM(CASE WHEN reason = 'budget_cap_exhausted' THEN 1 ELSE 0 END) AS budget_skips,
      SUM(CASE WHEN exploration = 1 AND admitted = 1 THEN 1 ELSE 0 END) AS exploration_admits
    FROM scout_llm_admissions
  `) : {};
  const llmByProvider = rows(db, `
    SELECT provider, model, status, COUNT(*) AS n
    FROM llm_usage_events
    GROUP BY provider, model, status
    ORDER BY n DESC
  `);
  const llmByHour = rows(db, `
    SELECT strftime('%Y-%m-%dT%H:00:00Z', created_at_ms / 1000, 'unixepoch') AS hour_utc, COUNT(*) AS n
    FROM llm_usage_events
    GROUP BY hour_utc
    ORDER BY hour_utc DESC
    LIMIT 24
  `);
  const mintLeaders = rows(db, `
    SELECT mint, COUNT(*) AS candidates, MAX(created_at_ms) AS last_seen_at_ms
    FROM candidates
    GROUP BY mint
    HAVING COUNT(*) > 1
    ORDER BY candidates DESC, last_seen_at_ms DESC
    LIMIT 20
  `);
  const historicalDryRunMints = rows(db, `
    SELECT id, mint, symbol, status, opened_at_ms, closed_at_ms, pnl_sol, pnl_percent, scout_policy_score
    FROM dry_run_positions
    WHERE strategy_id = 'scout'
    ORDER BY id ASC
    LIMIT 20
  `);
  const pnl = scalar(db, `
    SELECT
      COALESCE(SUM(pnl_sol), 0) AS realized_pnl_sol,
      AVG(pnl_percent) AS avg_pnl_percent
    FROM dry_run_positions
    WHERE status = 'closed'
      AND strategy_id = 'scout'
  `) || {};

  const scoutOpen = openMintSet(db);
  const primaryOpen = primary ? openMintSet(primary) : new Set();
  const overlap = [...scoutOpen].filter(mint => primaryOpen.has(mint));
  const llmCallCount = llmByProvider.reduce((sum, row) => sum + Number(row.n || 0), 0);
  const admittedCount = Number(admissionStats?.admitted || 0);
  const dryRunPositionCount = Number(positionCounts.total || 0);

  const report = {
    db: opts.db,
    primary_db_checked: primary ? opts.primaryDb : null,
    trading_mode: tradingMode,
    scout_policy_enabled: policyEnabled,
    scout_policy_active_version: activePolicy,
    active_strategy: activeStrategy(db),
    candidates: {
      built: Number(candidateStats.total || 0),
      filter_passed: Number(candidateStats.filter_passed || 0),
      unique_mints: Number(candidateStats.unique_mints || 0),
      repeated_mint_leaders: mintLeaders,
    },
    llm_admissions: {
      total: Number(admissionStats?.total || 0),
      admitted: admittedCount,
      cooldown_skips: Number(admissionStats?.cooldown_skips || 0),
      score_skips: Number(admissionStats?.score_skips || 0),
      budget_skips: Number(admissionStats?.budget_skips || 0),
      exploration_admits: Number(admissionStats?.exploration_admits || 0),
    },
    llm_usage: {
      total_calls: llmCallCount,
      by_provider_model_status: llmByProvider,
      hourly: llmByHour,
      calls_per_admitted_candidate: admittedCount ? llmCallCount / admittedCount : null,
      calls_per_dry_run_position: dryRunPositionCount ? llmCallCount / dryRunPositionCount : null,
    },
    positions: {
      total: Number(positionCounts.total || 0),
      open: Number(positionCounts.open_count || 0),
      closed: Number(positionCounts.closed_count || 0),
      reward_pending: Number(positionCounts.reward_pending || 0),
      reward_recorded: Number(positionCounts.reward_recorded || 0),
      realized_pnl_sol: Number(pnl.realized_pnl_sol || 0),
      avg_pnl_percent: pnl.avg_pnl_percent == null ? null : Number(pnl.avg_pnl_percent),
      historical_dry_run_mints: historicalDryRunMints,
    },
    scout_policy: {
      decisions,
      rewards,
      weights,
    },
    duplicate_open_mints_with_primary: overlap,
    checks: {
      dry_run_mode: tradingMode === 'dry_run',
      scout_strategy_active: activeStrategy(db)?.id === 'scout',
      no_duplicate_open_mints_with_primary: overlap.length === 0,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  db.close();
  if (primary) primary.close();
}

main();
