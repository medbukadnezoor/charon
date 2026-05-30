#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function usage() {
  return [
    'Usage:',
    '  node scripts/scout_learner_readiness_report.js --db=/path/charon-scout.sqlite [--min-closed=20] [--max-open-rate=0.10] [--hours=24] [--format=text|json]',
    '',
    'Read-only learner readiness gate. Prints aggregate counts and mint prefixes only.',
    'Does not read .env, start PM2 processes, update reward events, or mutate policy weights.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = { minClosed: 20, maxOpenRate: 0.10, hours: 24, format: 'text' };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'min-closed') opts.minClosed = Number(value);
    else if (key === 'max-open-rate') opts.maxOpenRate = Number(value);
    else if (key === 'hours') opts.hours = Number(value);
    else if (key === 'format') opts.format = value;
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!opts.db) throw new Error(`--db is required.\n\n${usage()}`);
  if (!Number.isInteger(opts.minClosed) || opts.minClosed <= 0) throw new Error('--min-closed must be a positive integer');
  if (!Number.isFinite(opts.maxOpenRate) || opts.maxOpenRate < 0 || opts.maxOpenRate > 1) throw new Error('--max-open-rate must be a number between 0 and 1');
  if (!Number.isFinite(opts.hours) || opts.hours <= 0) throw new Error('--hours must be a positive number');
  if (!['json', 'text'].includes(opts.format)) throw new Error('--format must be json or text');
  opts.db = path.resolve(opts.db);
  if (!fs.existsSync(opts.db)) throw new Error(`Scout DB not found: ${opts.db}`);
  return opts;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columnsFor(db, name) {
  if (!tableExists(db, name)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map(row => row.name));
}

function scalar(db, sql, params = []) {
  return db.prepare(sql).get(...params) || {};
}

function safeJson(value, fallback = {}) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
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

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : null;
}

function mintPrefix(mint) {
  return mint ? String(mint).slice(0, 8) : null;
}

function activeStrategy(db) {
  if (!tableExists(db, 'strategies')) return null;
  const row = db.prepare('SELECT id, name, enabled, config_json FROM strategies WHERE enabled = 1 LIMIT 1').get();
  if (!row) return null;
  const config = safeJson(row.config_json, {});
  return {
    id: row.id,
    name: row.name,
    enabled: Boolean(row.enabled),
    max_open_positions: config.max_open_positions ?? null,
    scout_daily_buy_cap: config.scout_daily_buy_cap ?? null,
    use_llm: config.use_llm ?? null,
  };
}

function settingsSnapshot(db) {
  if (!tableExists(db, 'settings')) return {};
  const keys = [
    'trading_mode',
    'scout_policy_enabled',
    'scout_policy_active_version',
    'scout_daily_buy_cap',
    'scout_daily_loss_stop_sol',
    'scout_learning_half_life_ms',
    'scout_llm_hourly_cap',
    'scout_llm_daily_cap',
  ];
  return Object.fromEntries(db.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (${keys.map(() => '?').join(',')})
    ORDER BY key
  `).all(...keys).map(row => [row.key, row.value]));
}

function positionWhere(columns) {
  const clauses = [];
  if (columns.has('strategy_id')) clauses.push("strategy_id = 'scout'");
  if (columns.has('scout_policy_version_id')) clauses.push('scout_policy_version_id IS NOT NULL');
  return clauses.length ? `(${clauses.join(' OR ')})` : '1 = 0';
}

function hasScoutFeatureSnapshot(snapshotJson) {
  const snapshot = safeJson(snapshotJson, {});
  const policySnapshot = snapshot?.decision?.scout_policy?.feature_snapshot
    || snapshot?.scout_policy?.feature_snapshot
    || null;
  return Array.isArray(policySnapshot?.feature_keys) && policySnapshot.feature_keys.length > 0;
}

function scoutFeatureSnapshot(snapshotJson) {
  const snapshot = safeJson(snapshotJson, {});
  return snapshot?.decision?.scout_policy?.feature_snapshot
    || snapshot?.scout_policy?.feature_snapshot
    || { feature_keys: [] };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function decayedWeight(previousWeight, elapsedMs, halfLifeMs) {
  if (!Number.isFinite(previousWeight)) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return previousWeight;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return previousWeight;
  return previousWeight * Math.pow(0.5, elapsedMs / halfLifeMs);
}

function updateFeatureWeight({
  currentWeight = 0,
  currentConfidence = 0,
  currentSamples = 0,
  reward,
  rewardWeight = 1,
  elapsedMs = 0,
  halfLifeMs,
}) {
  const base = decayedWeight(Number(currentWeight) || 0, elapsedMs, halfLifeMs);
  const sampleWeight = Math.max(0, Number(rewardWeight) || 0);
  const samples = Math.max(0, Number(currentSamples) || 0);
  const learningRate = sampleWeight / Math.max(4, samples + sampleWeight);
  const nextWeight = base + learningRate * ((Number(reward) || 0) - base);
  const nextSamples = samples + sampleWeight;
  return {
    weight: nextWeight,
    confidence: Math.min(1, Math.max(Number(currentConfidence) || 0, Math.sqrt(nextSamples) / 10)),
    sample_count: nextSamples,
  };
}

function calculateScoutReward(position = {}) {
  if (!position || position.status !== 'closed') return { eligible: false, reason: 'unresolved_position' };
  const pnlSol = numOrNull(position.pnl_sol);
  const pnlPercent = numOrNull(position.pnl_percent);
  const entryMcap = numOrNull(position.entry_mcap);
  const highWaterMcap = numOrNull(position.high_water_mcap);
  const highWaterMultiple = entryMcap && highWaterMcap ? highWaterMcap / entryMcap : null;
  const exitReason = String(position.exit_reason || '').toLowerCase();
  const source = position.execution_mode === 'live' ? 'live' : 'shadow';
  const drawdownPercent = highWaterMultiple && pnlPercent !== null
    ? Math.max(0, (highWaterMultiple - 1) * 100 - pnlPercent)
    : null;

  let reward = 0;
  if (source === 'live' && pnlSol !== null) reward += pnlSol * 50;
  if (pnlPercent !== null) reward += pnlPercent / 100;
  if (highWaterMultiple !== null && source !== 'live') reward += Math.log(Math.max(1, highWaterMultiple)) * 0.25;
  if (/sl|stop|cutoff|failed|error/.test(exitReason)) reward -= 0.5;
  if (/failed|error/.test(exitReason)) reward -= 0.5;
  if (drawdownPercent !== null && drawdownPercent > 40) reward -= Math.min(1, drawdownPercent / 100);

  return {
    eligible: true,
    source,
    realized_pnl_sol: pnlSol,
    realized_pnl_percent: pnlPercent,
    high_water_multiple: highWaterMultiple,
    drawdown_percent: drawdownPercent,
    reward: clamp(reward, -3, 3),
    reward_weight: source === 'live' ? 1 : 0.25,
    reason: exitReason || 'closed',
  };
}

function positionsReport(db, { minClosed, hours }) {
  if (!tableExists(db, 'dry_run_positions')) {
    return { available: false, totals: {}, closed: [], open: [] };
  }
  const columns = columnsFor(db, 'dry_run_positions');
  const where = positionWhere(columns);
  const sinceMs = Date.now() - hours * 60 * 60_000;
  const executionMode = columns.has('execution_mode') ? 'execution_mode' : "'dry_run'";
  const policyVersion = columns.has('scout_policy_version_id') ? 'scout_policy_version_id' : 'NULL';
  const rewardStatus = columns.has('scout_reward_status') ? 'scout_reward_status' : "'not_applicable'";
  const pnlSol = columns.has('pnl_sol') ? 'pnl_sol' : 'NULL';
  const pnlPercent = columns.has('pnl_percent') ? 'pnl_percent' : 'NULL';
  const exitReason = columns.has('exit_reason') ? 'exit_reason' : 'NULL';
  const closedAt = columns.has('closed_at_ms') ? 'closed_at_ms' : 'NULL';
  const highWaterMcap = columns.has('high_water_mcap') ? 'high_water_mcap' : 'NULL';
  const entryMcap = columns.has('entry_mcap') ? 'entry_mcap' : 'NULL';
  const policyScore = columns.has('scout_policy_score') ? 'scout_policy_score' : 'NULL';

  const totals = scalar(db, `
    SELECT
      COUNT(*) AS total_positions,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_positions,
      SUM(CASE WHEN status IN ('open', 'partial_exit') THEN 1 ELSE 0 END) AS open_positions,
      SUM(CASE WHEN ${executionMode} = 'live' THEN 1 ELSE 0 END) AS live_positions,
      SUM(CASE WHEN status = 'closed' AND ${policyVersion} IS NOT NULL THEN 1 ELSE 0 END) AS closed_with_policy,
      SUM(CASE WHEN status = 'closed' AND ${rewardStatus} = 'pending' THEN 1 ELSE 0 END) AS pending_rewards,
      SUM(CASE WHEN status = 'closed' AND ${rewardStatus} = 'recorded' THEN 1 ELSE 0 END) AS recorded_rewards,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN ${pnlSol} ELSE 0 END), 0) AS realized_pnl_sol,
      AVG(CASE WHEN status = 'closed' THEN ${pnlPercent} ELSE NULL END) AS avg_pnl_percent,
      MIN(CASE WHEN status = 'closed' THEN ${closedAt} ELSE NULL END) AS first_closed_ms,
      MAX(CASE WHEN status = 'closed' THEN ${closedAt} ELSE NULL END) AS last_closed_ms
    FROM dry_run_positions
    WHERE ${where}
  `);

  const closed = db.prepare(`
    SELECT
      id, mint, symbol, status, opened_at_ms, ${closedAt} AS closed_at_ms,
      ${executionMode} AS execution_mode, ${exitReason} AS exit_reason,
      ${pnlSol} AS pnl_sol, ${pnlPercent} AS pnl_percent,
      ${entryMcap} AS entry_mcap, ${highWaterMcap} AS high_water_mcap,
      ${policyVersion} AS scout_policy_version_id,
      ${policyScore} AS scout_policy_score,
      ${rewardStatus} AS scout_reward_status,
      snapshot_json
    FROM dry_run_positions
    WHERE ${where}
      AND status = 'closed'
    ORDER BY closed_at_ms DESC, id DESC
    LIMIT ?
  `).all(Math.max(minClosed, 25)).map(row => ({
    id: row.id,
    mint_prefix: mintPrefix(row.mint),
    symbol: row.symbol || null,
    closed_at_iso: iso(row.closed_at_ms),
    execution_mode: row.execution_mode || 'dry_run',
    exit_reason: row.exit_reason || null,
    pnl_sol: numOrNull(row.pnl_sol),
    pnl_percent: numOrNull(row.pnl_percent),
    high_water_multiple: row.entry_mcap && row.high_water_mcap ? num(row.high_water_mcap) / num(row.entry_mcap) : null,
    scout_policy_version_id: row.scout_policy_version_id ?? null,
      scout_policy_score: numOrNull(row.scout_policy_score),
      scout_reward_status: row.scout_reward_status || 'not_applicable',
      has_feature_snapshot: hasScoutFeatureSnapshot(row.snapshot_json),
      reward_preview: row.scout_reward_status === 'pending' ? calculateScoutReward(row) : null,
    }));

  const open = db.prepare(`
    SELECT
      id, mint, symbol, status, opened_at_ms,
      ${executionMode} AS execution_mode,
      ${entryMcap} AS entry_mcap,
      ${highWaterMcap} AS high_water_mcap,
      ${policyScore} AS scout_policy_score
    FROM dry_run_positions
    WHERE ${where}
      AND status IN ('open', 'partial_exit')
    ORDER BY opened_at_ms DESC, id DESC
    LIMIT 25
  `).all().map(row => ({
    id: row.id,
    mint_prefix: mintPrefix(row.mint),
    symbol: row.symbol || null,
    status: row.status,
    opened_at_iso: iso(row.opened_at_ms),
    age_min: Number(((Date.now() - Number(row.opened_at_ms || 0)) / 60_000).toFixed(1)),
    execution_mode: row.execution_mode || 'dry_run',
    high_water_multiple: row.entry_mcap && row.high_water_mcap ? num(row.high_water_mcap) / num(row.entry_mcap) : null,
    scout_policy_score: numOrNull(row.scout_policy_score),
  }));

  const exitReasonCounts = db.prepare(`
    SELECT ${exitReason} AS exit_reason, COUNT(*) AS count, COALESCE(SUM(${pnlSol}), 0) AS pnl_sol
    FROM dry_run_positions
    WHERE ${where}
      AND status = 'closed'
    GROUP BY exit_reason
    ORDER BY count DESC, exit_reason
  `).all().map(row => ({
    exit_reason: row.exit_reason || 'unknown',
    count: num(row.count),
    pnl_sol: num(row.pnl_sol),
  }));

  const recentWindow = scalar(db, `
    SELECT
      COUNT(*) AS closed_recent,
      COALESCE(SUM(${pnlSol}), 0) AS pnl_recent
    FROM dry_run_positions
    WHERE ${where}
      AND status = 'closed'
      AND ${closedAt} >= ?
  `, [sinceMs]);

  const closedCount = num(totals.closed_positions);
  const slCount = exitReasonCounts
    .filter(row => /^SL$/i.test(row.exit_reason))
    .reduce((sum, row) => sum + row.count, 0);
  const tpCount = exitReasonCounts
    .filter(row => /^(TP|TRAILING_TP|BREAKEVEN_LOCK)$/i.test(row.exit_reason))
    .reduce((sum, row) => sum + row.count, 0);
  const missingSnapshots = closed.filter(row => !row.has_feature_snapshot).length;

  return {
    available: true,
    totals: {
      total_positions: num(totals.total_positions),
      closed_positions: closedCount,
      open_positions: num(totals.open_positions),
      live_positions: num(totals.live_positions),
      closed_with_policy: num(totals.closed_with_policy),
      pending_rewards: num(totals.pending_rewards),
      recorded_rewards: num(totals.recorded_rewards),
      realized_pnl_sol: num(totals.realized_pnl_sol),
      avg_pnl_percent: numOrNull(totals.avg_pnl_percent),
      first_closed_iso: iso(totals.first_closed_ms),
      last_closed_iso: iso(totals.last_closed_ms),
      sl_count: slCount,
      tp_count: tpCount,
      sl_rate_percent: closedCount ? Number(((slCount / closedCount) * 100).toFixed(2)) : null,
      tp_rate_percent: closedCount ? Number(((tpCount / closedCount) * 100).toFixed(2)) : null,
      open_rate_percent: num(totals.total_positions) ? Number(((num(totals.open_positions) / num(totals.total_positions)) * 100).toFixed(2)) : null,
      missing_feature_snapshots_in_sample: missingSnapshots,
      recent_window_hours: hours,
      closed_recent: num(recentWindow.closed_recent),
      pnl_recent: num(recentWindow.pnl_recent),
    },
    exit_reason_counts: exitReasonCounts,
    closed,
    open,
  };
}

function rewardEventsReport(db) {
  if (!tableExists(db, 'scout_reward_events')) return { available: false, total_events: 0, unapplied_events: 0 };
  return {
    available: true,
    ...scalar(db, `
      SELECT
        COUNT(*) AS total_events,
        SUM(CASE WHEN applied_to_weights_at_ms IS NULL THEN 1 ELSE 0 END) AS unapplied_events,
        SUM(CASE WHEN source = 'live' THEN 1 ELSE 0 END) AS live_events,
        SUM(CASE WHEN source = 'shadow' THEN 1 ELSE 0 END) AS shadow_events
      FROM scout_reward_events
    `),
  };
}

function activePolicyVersion(db, settings) {
  if (!tableExists(db, 'scout_policy_versions')) return null;
  const version = settings.scout_policy_active_version || 'scout-v1';
  return db.prepare('SELECT id, version FROM scout_policy_versions WHERE version = ?').get(version)
    || db.prepare('SELECT id, version FROM scout_policy_versions ORDER BY id DESC LIMIT 1').get()
    || null;
}

function currentWeights(db, policyVersionId) {
  if (!tableExists(db, 'scout_policy_weights') || !policyVersionId) return new Map();
  const rows = db.prepare(`
    SELECT feature_key, weight, confidence, sample_count, live_sample_count, shadow_sample_count, last_reward_at_ms
    FROM scout_policy_weights
    WHERE policy_version_id = ?
  `).all(policyVersionId);
  return new Map(rows.map(row => [row.feature_key, {
    feature_key: row.feature_key,
    weight: num(row.weight),
    confidence: num(row.confidence),
    sample_count: num(row.sample_count),
    live_sample_count: num(row.live_sample_count),
    shadow_sample_count: num(row.shadow_sample_count),
    last_reward_at_ms: numOrNull(row.last_reward_at_ms),
  }]));
}

function unappliedRewardEvents(db, limit) {
  if (!tableExists(db, 'scout_reward_events')) return [];
  return db.prepare(`
    SELECT *
    FROM scout_reward_events
    WHERE applied_to_weights_at_ms IS NULL
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).reverse();
}

function projectedRewardEventsFromPendingPositions(db, existingEvents, limit) {
  const existingOutcomeIds = new Set(existingEvents.map(event => event.outcome_id).filter(Boolean));
  const columns = columnsFor(db, 'dry_run_positions');
  if (!columns.size) return { events: [], skipped_missing_snapshot: 0, skipped_existing_event: 0 };
  const where = positionWhere(columns);
  const rows = db.prepare(`
    SELECT *
    FROM dry_run_positions
    WHERE ${where}
      AND status = 'closed'
      AND scout_reward_status = 'pending'
    ORDER BY closed_at_ms DESC, id DESC
    LIMIT ?
  `).all(limit);
  const events = [];
  let skippedMissingSnapshot = 0;
  let skippedExistingEvent = 0;
  const createdAtMs = Date.now();
  for (const position of rows) {
    const outcomeId = `position:${position.id}`;
    if (existingOutcomeIds.has(outcomeId)) {
      skippedExistingEvent += 1;
      continue;
    }
    const snapshot = scoutFeatureSnapshot(position.snapshot_json);
    if (!Array.isArray(snapshot.feature_keys) || snapshot.feature_keys.length === 0) {
      skippedMissingSnapshot += 1;
      continue;
    }
    const reward = calculateScoutReward(position);
    if (!reward.eligible) continue;
    events.push({
      id: null,
      projected: true,
      position_id: position.id,
      outcome_id: outcomeId,
      mint: position.mint,
      source: reward.source,
      reward: reward.reward,
      reward_weight: reward.reward_weight,
      feature_snapshot_json: JSON.stringify(snapshot),
      created_at_ms: createdAtMs,
    });
  }
  return { events: events.reverse(), skipped_missing_snapshot: skippedMissingSnapshot, skipped_existing_event: skippedExistingEvent };
}

function learnerImpactSimulation(db, { settings, positions, limit = 200 }) {
  const policyVersion = activePolicyVersion(db, settings);
  const halfLifeMs = num(settings.scout_learning_half_life_ms, 7 * 24 * 60 * 60_000);
  if (!policyVersion) {
    return { available: false, reason: 'missing_policy_version', pending_positions: 0, simulated_updates: 0, deltas: [] };
  }

  const existingEvents = unappliedRewardEvents(db, limit);
  const projected = projectedRewardEventsFromPendingPositions(db, existingEvents, limit);
  const events = [...existingEvents, ...projected.events].slice(0, limit);
  const beforeWeights = currentWeights(db, policyVersion.id);
  const weights = new Map([...beforeWeights.entries()].map(([key, value]) => [key, { ...value }]));
  const touched = new Set();
  let simulatedUpdates = 0;
  let eligibleRewards = 0;
  let skippedEmptyFeatures = 0;

  for (const event of events) {
    const snapshot = safeJson(event.feature_snapshot_json, {});
    if (!Array.isArray(snapshot.feature_keys) || snapshot.feature_keys.length === 0) {
      skippedEmptyFeatures += 1;
      continue;
    }
    eligibleRewards += 1;
    for (const featureKey of snapshot.feature_keys) {
      const current = weights.get(featureKey) || {
        feature_key: featureKey,
        weight: 0,
        confidence: 0,
        sample_count: 0,
        live_sample_count: 0,
        shadow_sample_count: 0,
        last_reward_at_ms: null,
      };
      const next = updateFeatureWeight({
        currentWeight: current.weight,
        currentConfidence: current.confidence,
        currentSamples: current.sample_count,
        reward: event.reward,
        rewardWeight: event.reward_weight,
        elapsedMs: current.last_reward_at_ms ? Number(event.created_at_ms) - Number(current.last_reward_at_ms) : 0,
        halfLifeMs,
      });
      weights.set(featureKey, {
        ...current,
        weight: next.weight,
        confidence: next.confidence,
        sample_count: next.sample_count,
        live_sample_count: current.live_sample_count + (event.source === 'live' ? 1 : 0),
        shadow_sample_count: current.shadow_sample_count + (event.source === 'shadow' ? 1 : 0),
        last_reward_at_ms: Number(event.created_at_ms),
      });
      touched.add(featureKey);
      simulatedUpdates += 1;
    }
  }

  const deltas = [...touched].map(featureKey => {
    const before = beforeWeights.get(featureKey) || {
      feature_key: featureKey,
      weight: 0,
      confidence: 0,
      sample_count: 0,
      live_sample_count: 0,
      shadow_sample_count: 0,
    };
    const after = weights.get(featureKey);
    return {
      feature_key: featureKey,
      before_weight: before.weight,
      after_weight: after.weight,
      delta_weight: after.weight - before.weight,
      before_confidence: before.confidence,
      after_confidence: after.confidence,
      before_samples: before.sample_count,
      after_samples: after.sample_count,
    };
  }).sort((a, b) => Math.abs(b.delta_weight) - Math.abs(a.delta_weight));

  return {
    available: true,
    policy_version: policyVersion.version,
    existing_unapplied_events: existingEvents.length,
    projected_events_from_pending_positions: projected.events.length,
    skipped_existing_position_events: projected.skipped_existing_event,
    skipped_missing_feature_snapshot_positions: projected.skipped_missing_snapshot,
    skipped_empty_feature_events: skippedEmptyFeatures,
    pending_positions: num(positions.totals?.pending_rewards),
    eligible_rewards: eligibleRewards,
    simulated_updates: simulatedUpdates,
    top_positive_deltas: deltas.filter(row => row.delta_weight > 0).sort((a, b) => b.delta_weight - a.delta_weight).slice(0, 8),
    top_negative_deltas: deltas.filter(row => row.delta_weight < 0).sort((a, b) => a.delta_weight - b.delta_weight).slice(0, 8),
    largest_abs_deltas: deltas.slice(0, 12),
  };
}

function llmHealthReport(db, hours) {
  if (!tableExists(db, 'llm_usage_events')) return { available: false, recent_errors: 0 };
  const sinceMs = Date.now() - hours * 60 * 60_000;
  const columns = columnsFor(db, 'llm_usage_events');
  const errorClass = columns.has('error_class') ? 'error_class' : 'NULL';
  return {
    available: true,
    ...scalar(db, `
      SELECT
        COUNT(*) AS events,
        SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS recent_errors,
        SUM(CASE WHEN ${errorClass} IN ('parse_error', 'invalid_decision_schema', 'empty_content') THEN 1 ELSE 0 END) AS semantic_errors
      FROM llm_usage_events
      WHERE created_at_ms >= ?
    `, [sinceMs]),
  };
}

function evaluateReadiness({ settings, strategy, positions, rewards, llm, minClosed, maxOpenRate }) {
  const blocks = [];
  const warnings = [];
  const totals = positions.totals || {};
  const openRate = num(totals.total_positions) ? num(totals.open_positions) / num(totals.total_positions) : 0;

  if (settings.trading_mode !== 'dry_run') blocks.push({ code: 'not_dry_run', message: `trading_mode is ${settings.trading_mode || 'unknown'}, expected dry_run` });
  if (strategy?.id !== 'scout' || strategy.enabled !== true) blocks.push({ code: 'scout_strategy_not_active', message: 'active strategy is not enabled scout' });
  if (totals.live_positions > 0) blocks.push({ code: 'live_rows_present', message: `${totals.live_positions} scout-attributed positions are marked live` });
  if (totals.open_positions > 0) blocks.push({ code: 'open_positions_pending', message: `${totals.open_positions} scout positions are still open; wait for closure before training` });
  if (openRate > maxOpenRate) blocks.push({ code: 'open_censor_rate_high', message: `open-position censor rate is ${(openRate * 100).toFixed(2)}%, max ${(maxOpenRate * 100).toFixed(2)}%` });
  if (totals.closed_positions < minClosed) blocks.push({ code: 'closed_sample_under_minimum', message: `${totals.closed_positions} closed outcomes, minimum ${minClosed}` });
  if (totals.pending_rewards <= 0) blocks.push({ code: 'no_pending_rewards', message: 'no closed scout positions have pending rewards for learner input' });
  if (totals.closed_with_policy < Math.min(minClosed, totals.closed_positions)) blocks.push({ code: 'missing_policy_attribution', message: 'some closed scout rows lack scout_policy_version_id' });
  if (totals.missing_feature_snapshots_in_sample > 0) blocks.push({ code: 'missing_feature_snapshots', message: `${totals.missing_feature_snapshots_in_sample} sampled closed rows lack scout feature snapshots` });

  if (totals.realized_pnl_sol < 0) warnings.push({ code: 'negative_realized_pnl', message: `closed scout PnL is ${totals.realized_pnl_sol} SOL` });
  if (totals.tp_count === 0 && totals.closed_positions > 0) warnings.push({ code: 'no_tp_outcomes', message: 'closed scout sample has zero TP-like exits' });
  if (totals.sl_rate_percent >= 60) warnings.push({ code: 'high_sl_rate', message: `SL rate is ${totals.sl_rate_percent}%` });
  if (num(llm.recent_errors) > 0) warnings.push({ code: 'recent_provider_errors', message: `${num(llm.recent_errors)} recent LLM provider errors in the readiness window` });
  if (num(rewards.unapplied_events) > 0) warnings.push({ code: 'unapplied_reward_events_exist', message: `${num(rewards.unapplied_events)} reward events are already waiting for weight application` });

  return {
    ready: blocks.length === 0,
    status: blocks.length ? 'BLOCK_LEARNER_RUN' : warnings.length ? 'WARN_MANUAL_REVIEW' : 'PASS_LEARNER_RUN',
    blocks,
    warnings,
  };
}

function buildReport({ db, dbPath, minClosed, maxOpenRate, hours }) {
  const settings = settingsSnapshot(db);
  const strategy = activeStrategy(db);
  const positions = positionsReport(db, { minClosed, hours });
  const rewards = rewardEventsReport(db);
  const llm = llmHealthReport(db, hours);
  const learnerImpact = learnerImpactSimulation(db, { settings, positions });
  const readiness = evaluateReadiness({ settings, strategy, positions, rewards, llm, minClosed, maxOpenRate });
  return {
    generated_at: new Date().toISOString(),
    db: dbPath,
    min_closed: minClosed,
    max_open_rate: maxOpenRate,
    recent_window_hours: hours,
    settings,
    active_strategy: strategy,
    scout_positions: positions,
    scout_reward_events: rewards,
    learner_impact_simulation: learnerImpact,
    llm_health: llm,
    readiness,
  };
}

function fmt(value, digits = 6) {
  if (value === null || value === undefined) return 'n/a';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
  return String(value);
}

function printText(report) {
  const totals = report.scout_positions.totals || {};
  console.log('Scout learner readiness report');
  console.log(`generated_at=${report.generated_at}`);
  console.log(`db=${report.db}`);
  console.log(`status=${report.readiness.status} ready=${report.readiness.ready ? 'yes' : 'no'}`);
  console.log(`strategy=${report.active_strategy?.id || 'unknown'} trading_mode=${report.settings.trading_mode || 'unknown'}`);
  console.log('');
  console.log('position_sample:');
  console.log(`  closed=${fmt(totals.closed_positions, 0)}/${report.min_closed} open=${fmt(totals.open_positions, 0)} live=${fmt(totals.live_positions, 0)} pending_rewards=${fmt(totals.pending_rewards, 0)} recorded_rewards=${fmt(totals.recorded_rewards, 0)}`);
  console.log(`  open_rate=${fmt(totals.open_rate_percent, 2)}% max_open_rate=${fmt(report.max_open_rate * 100, 2)}%`);
  console.log(`  pnl_sol=${fmt(totals.realized_pnl_sol)} avg_pnl_percent=${fmt(totals.avg_pnl_percent, 2)} tp=${fmt(totals.tp_count, 0)} sl=${fmt(totals.sl_count, 0)} sl_rate=${fmt(totals.sl_rate_percent, 2)}%`);
  console.log(`  first_closed=${totals.first_closed_iso || 'n/a'} last_closed=${totals.last_closed_iso || 'n/a'}`);
  console.log('');
  console.log('exit_reasons:');
  for (const row of report.scout_positions.exit_reason_counts || []) {
    console.log(`  ${row.exit_reason}: count=${row.count} pnl_sol=${fmt(row.pnl_sol)}`);
  }
  console.log('');
  console.log('blocks:');
  if (!report.readiness.blocks.length) console.log('  none');
  for (const row of report.readiness.blocks) console.log(`  ${row.code}: ${row.message}`);
  console.log('');
  console.log('warnings:');
  if (!report.readiness.warnings.length) console.log('  none');
  for (const row of report.readiness.warnings) console.log(`  ${row.code}: ${row.message}`);
  console.log('');
  console.log('learner_impact_simulation:');
  if (!report.learner_impact_simulation.available) {
    console.log(`  unavailable: ${report.learner_impact_simulation.reason || 'unknown'}`);
  } else {
    console.log(`  policy_version=${report.learner_impact_simulation.policy_version} pending_positions=${fmt(report.learner_impact_simulation.pending_positions, 0)} existing_unapplied_events=${fmt(report.learner_impact_simulation.existing_unapplied_events, 0)} projected_events=${fmt(report.learner_impact_simulation.projected_events_from_pending_positions, 0)} eligible_rewards=${fmt(report.learner_impact_simulation.eligible_rewards, 0)} simulated_updates=${fmt(report.learner_impact_simulation.simulated_updates, 0)}`);
    console.log(`  skipped_existing_position_events=${fmt(report.learner_impact_simulation.skipped_existing_position_events, 0)} skipped_missing_snapshots=${fmt(report.learner_impact_simulation.skipped_missing_feature_snapshot_positions, 0)} skipped_empty_events=${fmt(report.learner_impact_simulation.skipped_empty_feature_events, 0)}`);
    console.log('  top_negative_deltas:');
    if (!report.learner_impact_simulation.top_negative_deltas.length) console.log('    none');
    for (const row of report.learner_impact_simulation.top_negative_deltas.slice(0, 5)) {
      console.log(`    ${row.feature_key}: ${fmt(row.before_weight, 4)} -> ${fmt(row.after_weight, 4)} delta=${fmt(row.delta_weight, 4)} samples=${fmt(row.before_samples, 2)}->${fmt(row.after_samples, 2)}`);
    }
    console.log('  top_positive_deltas:');
    if (!report.learner_impact_simulation.top_positive_deltas.length) console.log('    none');
    for (const row of report.learner_impact_simulation.top_positive_deltas.slice(0, 5)) {
      console.log(`    ${row.feature_key}: ${fmt(row.before_weight, 4)} -> ${fmt(row.after_weight, 4)} delta=${fmt(row.delta_weight, 4)} samples=${fmt(row.before_samples, 2)}->${fmt(row.after_samples, 2)}`);
    }
  }
  console.log('');
  console.log('open_positions:');
  if (!report.scout_positions.open.length) console.log('  none');
  for (const row of report.scout_positions.open) {
    console.log(`  #${row.id} ${row.mint_prefix || 'none'} ${row.symbol || ''} age_min=${fmt(row.age_min, 1)} high_water_multiple=${fmt(row.high_water_multiple, 3)} score=${fmt(row.scout_policy_score, 4)}`);
  }
  console.log('');
  console.log('recent_closed:');
  for (const row of report.scout_positions.closed.slice(0, 12)) {
    console.log(`  #${row.id} ${row.mint_prefix || 'none'} ${row.symbol || ''} exit=${row.exit_reason || 'n/a'} pnl_sol=${fmt(row.pnl_sol)} reward=${row.scout_reward_status} snapshot=${row.has_feature_snapshot ? 'yes' : 'no'}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    const report = buildReport({ db, dbPath: opts.db, minClosed: opts.minClosed, maxOpenRate: opts.maxOpenRate, hours: opts.hours });
    if (opts.format === 'json') console.log(JSON.stringify(report, null, 2));
    else printText(report);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`[scout-learner-readiness-report] ${err.message}`);
  process.exit(1);
}
