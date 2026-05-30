import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const WINDOWS = {
  all: null,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

const SOURCE_LABELS = {
  live: 'live actual trades',
  shadow: 'shadow dry-run trades',
};

const SNAPSHOT_KEY_RE = /authorization|body|cookie|header|key|password|private|prompt|raw|request|response|secret|signature|token/i;

function safeJson(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function intOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function boolInt(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function compactScalar(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, 220);
  return null;
}

function compactObject(value, depth = 0) {
  if (value == null || depth > 2) return null;
  if (Array.isArray(value)) return value.slice(0, 12).map(item => compactObject(item, depth + 1)).filter(item => item != null);
  if (typeof value !== 'object') return compactScalar(value);
  const out = {};
  for (const [key, child] of Object.entries(value).slice(0, 40)) {
    if (SNAPSHOT_KEY_RE.test(key)) continue;
    const compact = compactObject(child, depth + 1);
    if (compact != null && !(typeof compact === 'object' && !Array.isArray(compact) && Object.keys(compact).length === 0)) {
      out[key] = compact;
    }
  }
  return out;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function sum(values) {
  return values.map(Number).filter(Number.isFinite).reduce((total, value) => total + value, 0);
}

function bucket(value, bands, fallback = 'unknown') {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  for (const band of bands) {
    if (n >= band.min && n < band.max) return band.label;
  }
  return fallback;
}

function groupCount(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field] == null || row[field] === '' ? 'unknown' : String(row[field]);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function groupPnl(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const key = row[field] == null || row[field] === '' ? 'unknown' : String(row[field]);
    const item = map.get(key) || { key, count: 0, closed: 0, wins: 0, pnlSol: 0, pnlPercentValues: [] };
    item.count += 1;
    if (row.status === 'closed') {
      item.closed += 1;
      item.wins += Number(row.pnlPercent || 0) > 0 ? 1 : 0;
      item.pnlSol += Number(row.pnlSol || 0);
      if (Number.isFinite(Number(row.pnlPercent))) item.pnlPercentValues.push(Number(row.pnlPercent));
    }
    map.set(key, item);
  }
  return [...map.values()]
    .map(item => ({
      ...item,
      winRate: item.closed ? item.wins / item.closed : null,
      avgPnlPercent: avg(item.pnlPercentValues),
      medianPnlPercent: median(item.pnlPercentValues),
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
}

function countRows(db, table) {
  if (!tableExists(db, table)) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
}

function maxValue(db, table, column) {
  if (!tableColumns(db, table).has(column)) return null;
  return db.prepare(`SELECT MAX(${column}) AS value FROM ${table}`).get().value ?? null;
}

function columnExpr(columns, column, fallback = 'NULL') {
  return columns.has(column) ? column : `${fallback} AS ${column}`;
}

function windowFilter(params, timeColumn = 'opened_at_ms') {
  const clauses = [];
  const args = {};
  if (params.window && params.window !== 'all') {
    const ms = WINDOWS[params.window];
    if (!ms) throw httpError(400, `Invalid window: ${params.window}`);
    clauses.push(`${timeColumn} >= @fromMs`);
    args.fromMs = Date.now() - ms;
  }
  if (params.fromId != null) {
    clauses.push('id >= @fromId');
    args.fromId = intOrNull(params.fromId);
  }
  if (params.toId != null) {
    clauses.push('id <= @toId');
    args.toId = intOrNull(params.toId);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function sanitizeSnapshot(rawSnapshot) {
  const snapshot = safeJson(rawSnapshot, {});
  if (!snapshot || typeof snapshot !== 'object') return {};
  const token = snapshot.token || {};
  const metrics = snapshot.metrics || {};
  const holders = snapshot.holders || {};
  const feeClaim = snapshot.feeClaim || {};
  const savedWalletExposure = snapshot.savedWalletExposure || {};
  const signals = snapshot.signals || {};
  const filters = snapshot.filters || {};
  const trending = snapshot.trending || {};
  const riskTemplate = snapshot.riskTemplate || snapshot.risk_template || snapshot.risk || {};
  return {
    route: signals.route || snapshot.route || null,
    sources: Array.isArray(signals.sources) ? signals.sources.slice(0, 12) : [],
    riskProfile: riskTemplate.id || riskTemplate.profile || riskTemplate.name || filters.riskProfile || null,
    watchType: snapshot.watchType || filters.watchType || null,
    cohort: snapshot.cohort || filters.cohort || null,
    token: compactObject({
      symbol: token.symbol,
      mint: token.mint,
      ageMs: token.ageMs,
      priceUsd: token.priceUsd,
      marketCapUsd: token.marketCapUsd ?? metrics.marketCapUsd,
      liquidityUsd: metrics.liquidityUsd,
      volume5mUsd: metrics.volume5mUsd,
      volume24hUsd: metrics.volume24hUsd,
    }),
    holder: compactObject({
      count: holders.count ?? metrics.holderCount,
      maxHolderPercent: holders.maxHolderPercent,
      top20Percent: holders.top20Percent,
    }),
    savedWallet: compactObject({
      holderCount: savedWalletExposure.holderCount,
      strongCount: savedWalletExposure.evidence?.summary?.strongCount,
      kolCount: savedWalletExposure.evidence?.summary?.kolCount,
      checked: savedWalletExposure.checked,
    }),
    fee: compactObject({
      claimSol: feeClaim.solAmount ?? feeClaim.amountSol,
      gmgnTotalFeeSol: feeClaim.gmgnTotalFeeSol,
      present: feeClaim.present,
    }),
    filters: compactObject({
      status: filters.status,
      passed: filters.passed,
      strategy: filters.strategy,
      failureCodes: filters.failureCodes,
      score: filters.score,
    }),
    trending: compactObject({
      source: trending.source,
      volumeUsd: trending.volumeUsd,
      swaps: trending.swaps,
      rugRatio: trending.rugRatio,
      bundlerRate: trending.bundlerRate,
    }),
  };
}

function normalizePosition(row) {
  const snapshot = sanitizeSnapshot(row.snapshot_json);
  const entryMcap = numberOrNull(row.entry_mcap);
  const highMcap = numberOrNull(row.high_water_mcap);
  const exitMcap = numberOrNull(row.exit_mcap);
  const openedAt = numberOrNull(row.opened_at_ms);
  const closedAt = numberOrNull(row.closed_at_ms);
  const runupPercent = entryMcap && highMcap ? ((highMcap / entryMcap) - 1) * 100 : null;
  const drawdownPercent = entryMcap && exitMcap ? ((exitMcap / entryMcap) - 1) * 100 : numberOrNull(row.pnl_percent);
  return {
    id: row.id,
    candidateId: row.candidate_id,
    mint: row.mint,
    symbol: row.symbol,
    status: row.status,
    openedAtMs: openedAt,
    closedAtMs: closedAt,
    holdMs: openedAt ? ((closedAt || Date.now()) - openedAt) : null,
    sizeSol: numberOrNull(row.size_sol),
    entryPrice: numberOrNull(row.entry_price),
    entryMcap,
    highWaterPrice: numberOrNull(row.high_water_price),
    highWaterMcap: highMcap,
    exitPrice: numberOrNull(row.exit_price),
    exitMcap,
    runupPercent,
    drawdownPercent,
    tpPercent: numberOrNull(row.tp_percent),
    slPercent: numberOrNull(row.sl_percent),
    effectiveSlPercent: numberOrNull(row.effective_sl_percent),
    trailingEnabled: boolInt(row.trailing_enabled),
    trailingArmPercent: numberOrNull(row.trailing_arm_percent),
    trailingPercent: numberOrNull(row.trailing_percent),
    trailingArmed: boolInt(row.trailing_armed),
    breakevenArmed: boolInt(row.breakeven_armed),
    breakevenArmedAtMs: numberOrNull(row.breakeven_armed_at_ms),
    breakevenLockPercent: numberOrNull(row.breakeven_lock_percent),
    cutoffChecks: intOrNull(row.cutoff_checks),
    nextCutoffAtMs: numberOrNull(row.next_cutoff_at_ms),
    exitReason: row.exit_reason,
    pnlPercent: numberOrNull(row.pnl_percent),
    pnlSol: numberOrNull(row.pnl_sol),
    llmDecisionId: row.llm_decision_id,
    executionMode: row.execution_mode || 'dry_run',
    strategyId: row.strategy_id || snapshot.filters?.strategy || 'unknown',
    route: snapshot.route,
    sources: snapshot.sources,
    riskProfile: snapshot.riskProfile,
    watchType: snapshot.watchType,
    cohort: snapshot.cohort,
    candidateMetrics: {
      holderCount: snapshot.holder?.count ?? null,
      maxHolderPercent: snapshot.holder?.maxHolderPercent ?? null,
      top20HolderPercent: snapshot.holder?.top20Percent ?? null,
      savedWalletCount: snapshot.savedWallet?.holderCount ?? null,
      savedWalletStrongCount: snapshot.savedWallet?.strongCount ?? null,
      gmgnFeeSol: snapshot.fee?.gmgnTotalFeeSol ?? snapshot.fee?.claimSol ?? null,
      filterStatus: snapshot.filters?.status ?? null,
      filterPassed: snapshot.filters?.passed ?? null,
    },
    snapshot,
  };
}

function selectPositions(db, params = {}) {
  if (!tableExists(db, 'dry_run_positions')) return [];
  const columns = tableColumns(db, 'dry_run_positions');
  const { where, args } = windowFilter(params);
  const statusClause = params.status && ['open', 'closed'].includes(params.status) ? `${where ? ' AND' : 'WHERE'} status = @status` : '';
  if (statusClause) args.status = params.status;
  const currentOnlyClause = params.currentOnly ? `${where || statusClause ? ' AND' : 'WHERE'} id >= 25` : '';
  const sql = `
    SELECT
      id, candidate_id, mint, symbol, status, opened_at_ms, closed_at_ms, size_sol,
      entry_price, entry_mcap, token_amount_est, high_water_price, high_water_mcap,
      tp_percent, sl_percent, ${columnExpr(columns, 'effective_sl_percent')},
      trailing_enabled, ${columnExpr(columns, 'trailing_arm_percent')}, trailing_percent,
      trailing_armed, ${columnExpr(columns, 'breakeven_armed', '0')},
      ${columnExpr(columns, 'breakeven_armed_at_ms')}, ${columnExpr(columns, 'breakeven_lock_percent', '0')},
      exit_price, exit_mcap, exit_reason, pnl_percent, pnl_sol, llm_decision_id,
      ${columnExpr(columns, 'execution_mode', "'dry_run'")}, ${columnExpr(columns, 'strategy_id', "'unknown'")},
      ${columnExpr(columns, 'cutoff_checks', '0')}, ${columnExpr(columns, 'next_cutoff_at_ms')},
      snapshot_json
    FROM dry_run_positions
    ${where}${statusClause}${currentOnlyClause}
    ORDER BY id DESC
    LIMIT @limit
  `;
  args.limit = Math.min(Math.max(intOrNull(params.limit) || 200, 1), 1000);
  return db.prepare(sql).all(args).map(normalizePosition);
}

function latestRowsByPosition(db, table, positionId, limit = 50) {
  if (!tableExists(db, table)) return [];
  const columns = tableColumns(db, table);
  if (!columns.has('position_id')) return [];
  const rows = db.prepare(`SELECT * FROM ${table} WHERE position_id = ? ORDER BY ${columns.has('at_ms') ? 'at_ms' : 'id'} ASC LIMIT ?`).all(positionId, limit);
  return rows.map(row => sanitizeRow(row));
}

function sanitizeRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (SNAPSHOT_KEY_RE.test(key) && !/_json$/.test(key)) continue;
    if (/_json$/.test(key)) out[key.replace(/_json$/, '')] = compactObject(safeJson(value, null));
    else out[key] = compactScalar(value);
  }
  return out;
}

function decisionContext(db, position) {
  const context = {
    llmDecision: null,
    llmBatch: null,
    decisionLogs: [],
    candidate: null,
    screeningEvents: [],
    watchRows: [],
    observations: [],
  };
  if (tableExists(db, 'llm_decisions') && position.llmDecisionId) {
    const row = db.prepare('SELECT * FROM llm_decisions WHERE id = ?').get(position.llmDecisionId);
    if (row) context.llmDecision = sanitizeRow(row);
  }
  if (tableExists(db, 'llm_batches')) {
    const batch = db.prepare('SELECT * FROM llm_batches WHERE selected_candidate_id = ? OR selected_mint = ? ORDER BY id DESC LIMIT 1').get(position.candidateId, position.mint);
    if (batch) context.llmBatch = sanitizeRow(batch);
  }
  if (tableExists(db, 'decision_logs')) {
    const logs = db.prepare('SELECT * FROM decision_logs WHERE selected_candidate_id = ? OR selected_mint = ? ORDER BY at_ms ASC LIMIT 30').all(position.candidateId, position.mint);
    context.decisionLogs = logs.map(sanitizeRow);
  }
  if (tableExists(db, 'candidates') && position.candidateId) {
    const row = db.prepare('SELECT * FROM candidates WHERE id = ?').get(position.candidateId);
    if (row) context.candidate = sanitizeRow(row);
  }
  if (tableExists(db, 'screening_events')) {
    const columns = tableColumns(db, 'screening_events');
    const rows = db.prepare(`
      SELECT *
      FROM screening_events
      WHERE mint = ? OR candidate_id = ?
      ORDER BY at_ms DESC
      LIMIT 20
    `).all(position.mint, position.candidateId);
    context.screeningEvents = rows.map(row => {
      const safe = sanitizeRow(row);
      if (!columns.has('screening_path')) safe.screening_path = null;
      return safe;
    });
  }
  if (tableExists(db, 'entry_watchlist')) {
    const rows = db.prepare(`
      SELECT *
      FROM entry_watchlist
      WHERE mint = ? OR triggered_position_id = ? OR original_candidate_id = ?
      ORDER BY COALESCE(triggered_at_ms, updated_at_ms, created_at_ms) DESC
      LIMIT 20
    `).all(position.mint, position.id, position.candidateId);
    context.watchRows = rows.map(sanitizeRow);
  }
  if (tableExists(db, 'token_observations')) {
    const rows = db.prepare('SELECT * FROM token_observations WHERE mint = ? ORDER BY observed_at_ms DESC LIMIT 20').all(position.mint);
    context.observations = rows.map(sanitizeRow);
  }
  return context;
}

export function createDashboardStore({ liveDbPath, shadowDbPath, openDatabase = path => new Database(path, { readonly: true, fileMustExist: true }) } = {}) {
  const configured = {
    live: liveDbPath ? path.resolve(liveDbPath) : null,
    shadow: shadowDbPath ? path.resolve(shadowDbPath) : null,
  };
  const dbs = {};
  const errors = {};
  for (const [source, dbPath] of Object.entries(configured)) {
    if (!dbPath) {
      errors[source] = 'not configured';
      continue;
    }
    try {
      dbs[source] = openDatabase(dbPath);
      dbs[source].pragma('query_only = ON');
    } catch (error) {
      errors[source] = error.message;
    }
  }

  function dbForSource(source) {
    if (!['live', 'shadow'].includes(source)) throw httpError(400, `Invalid source: ${source}`);
    if (!dbs[source]) throw httpError(503, `${source} source unavailable: ${errors[source] || 'not open'}`);
    return dbs[source];
  }

  function sourceInfo(source) {
    const db = dbs[source];
    if (!db) {
      return { source, label: SOURCE_LABELS[source], available: false, configured: Boolean(configured[source]), reason: errors[source] || 'not configured' };
    }
    const tables = [
      'dry_run_positions', 'dry_run_trades', 'tp_sl_rules', 'llm_decisions', 'llm_batches',
      'decision_logs', 'candidates', 'entry_watchlist', 'token_observation_queue',
      'token_observations', 'screening_events',
    ];
    const latestPositionId = maxValue(db, 'dry_run_positions', 'id');
    const latestDecisionAtMs = Math.max(
      Number(maxValue(db, 'llm_decisions', 'created_at_ms') || 0),
      Number(maxValue(db, 'decision_logs', 'at_ms') || 0),
    ) || null;
    const latestWatchAtMs = Math.max(
      Number(maxValue(db, 'entry_watchlist', 'updated_at_ms') || 0),
      Number(maxValue(db, 'token_observation_queue', 'updated_at_ms') || 0),
      Number(maxValue(db, 'token_observations', 'observed_at_ms') || 0),
    ) || null;
    const latestPositionAtMs = Math.max(
      Number(maxValue(db, 'dry_run_positions', 'opened_at_ms') || 0),
      Number(maxValue(db, 'dry_run_positions', 'closed_at_ms') || 0),
    ) || null;
    return {
      source,
      label: SOURCE_LABELS[source],
      available: true,
      configured: true,
      stale: latestPositionAtMs ? Date.now() - latestPositionAtMs > 24 * 60 * 60_000 : true,
      latestPositionId,
      latestPositionAtMs,
      latestDecisionAtMs,
      latestWatchAtMs,
      rowCounts: Object.fromEntries(tables.map(table => [table, countRows(db, table)])),
    };
  }

  function sources() {
    return {
      generatedAtMs: Date.now(),
      access: 'viewer-only',
      sources: [sourceInfo('live'), sourceInfo('shadow')],
    };
  }

  function summary(params = {}) {
    const source = params.source || 'live';
    const db = dbForSource(source);
    const positions = selectPositions(db, { ...params, limit: 5000 });
    const closed = positions.filter(position => position.status === 'closed');
    const open = positions.filter(position => position.status === 'open');
    const pnlPercents = closed.map(position => position.pnlPercent).filter(value => Number.isFinite(Number(value)));
    const runups = positions.map(position => position.runupPercent).filter(value => Number.isFinite(Number(value)));
    return {
      source,
      label: SOURCE_LABELS[source],
      window: params.window || 'all',
      currentOnly: Boolean(params.currentOnly),
      sampleWarning: closed.length < 30 ? 'live sample size too small for strategy conclusions' : null,
      counts: {
        positions: positions.length,
        open: open.length,
        closed: closed.length,
        wins: closed.filter(position => Number(position.pnlPercent || 0) > 0).length,
        losses: closed.filter(position => Number(position.pnlPercent || 0) < 0).length,
      },
      pnl: {
        totalSol: sum(closed.map(position => position.pnlSol)),
        avgPercent: avg(pnlPercents),
        medianPercent: median(pnlPercents),
        winRate: closed.length ? closed.filter(position => Number(position.pnlPercent || 0) > 0).length / closed.length : null,
        worstLossPercent: pnlPercents.length ? Math.min(...pnlPercents) : null,
        bestRunupPercent: runups.length ? Math.max(...runups) : null,
      },
      hold: {
        avgMs: avg(closed.map(position => position.holdMs)),
        medianMs: median(closed.map(position => position.holdMs)),
      },
      distributions: {
        exitReason: groupCount(closed, 'exitReason'),
        strategy: groupPnl(positions, 'strategyId'),
        executionMode: groupPnl(positions, 'executionMode'),
        route: groupPnl(positions, 'route'),
        riskProfile: groupPnl(positions, 'riskProfile'),
        watchType: groupPnl(positions, 'watchType'),
        cohort: groupPnl(positions, 'cohort'),
      },
      watchDip: watchDip(params).summary,
    };
  }

  function positions(params = {}) {
    const source = params.source || 'live';
    const db = dbForSource(source);
    return {
      source,
      label: SOURCE_LABELS[source],
      positions: selectPositions(db, params).map(position => {
        const { snapshot, ...rest } = position;
        return rest;
      }),
    };
  }

  function positionDetail(params = {}) {
    const source = params.source || 'live';
    const id = intOrNull(params.id);
    if (!id) throw httpError(400, 'id is required');
    const db = dbForSource(source);
    const position = selectPositions(db, { window: 'all', fromId: id, toId: id, limit: 1 })[0];
    if (!position || Number(position.id) !== id) throw httpError(404, `Position not found: ${id}`);
    return {
      source,
      label: SOURCE_LABELS[source],
      position,
      trades: latestRowsByPosition(db, 'dry_run_trades', id),
      rules: tableExists(db, 'tp_sl_rules') ? sanitizeRow(db.prepare('SELECT * FROM tp_sl_rules WHERE position_id = ?').get(id) || {}) : null,
      context: decisionContext(db, position),
    };
  }

  function watchDip(params = {}) {
    const source = params.source || 'live';
    const db = dbForSource(source);
    const nowMs = Date.now();
    const result = {
      source,
      summary: {
        noActiveWatchDip: true,
        decisionActions: [],
        entryWatchByType: [],
        entryWatchByStatus: [],
        active: 0,
        expired: 0,
        triggered: 0,
      },
      rows: [],
      observationQueue: [],
    };
    if (tableExists(db, 'decision_logs')) {
      result.summary.decisionActions = db.prepare(`
        SELECT action AS key, COUNT(*) AS count
        FROM decision_logs
        WHERE action IN ('llm_watch_dip_started', 'not_started', 'checked', 'triggered')
           OR action LIKE 'llm_watch_dip%'
        GROUP BY action
        ORDER BY count DESC
      `).all();
    }
    if (tableExists(db, 'entry_watchlist')) {
      const rows = db.prepare(`
        SELECT *
        FROM entry_watchlist
        ORDER BY COALESCE(triggered_at_ms, updated_at_ms, created_at_ms) DESC
        LIMIT 300
      `).all().map(sanitizeRow);
      result.rows = rows;
      result.summary.entryWatchByType = groupCount(rows, 'watch_type');
      result.summary.entryWatchByStatus = groupCount(rows, 'status');
      result.summary.active = rows.filter(row => row.status === 'active' && Number(row.expires_at_ms || 0) >= nowMs).length;
      result.summary.expired = rows.filter(row => row.status === 'expired' || (row.status === 'active' && Number(row.expires_at_ms || 0) < nowMs)).length;
      result.summary.triggered = rows.filter(row => row.status === 'triggered' || row.triggered_at_ms || row.triggered_position_id).length;
      result.summary.noActiveWatchDip = !rows.some(row => row.watch_type === 'llm_watch_dip' && row.status === 'active');
    }
    if (tableExists(db, 'token_observation_queue')) {
      result.observationQueue = db.prepare(`
        SELECT watch_status, decision_action, decision_stage, execution_lane, source_instance, COUNT(*) AS count
        FROM token_observation_queue
        GROUP BY watch_status, decision_action, decision_stage, execution_lane, source_instance
        ORDER BY count DESC
        LIMIT 50
      `).all();
    }
    return result;
  }

  function cohorts(params = {}) {
    const source = params.source || 'live';
    const db = dbForSource(source);
    const rows = selectPositions(db, { ...params, limit: 5000 });
    const withBuckets = rows.map(row => ({
      ...row,
      holderBucket: bucket(row.candidateMetrics.top20HolderPercent, [
        { label: '<25%', min: 0, max: 25 },
        { label: '25-35%', min: 25, max: 35 },
        { label: '35-45%', min: 35, max: 45 },
        { label: '45%+', min: 45, max: Infinity },
      ]),
      savedWalletBucket: bucket(row.candidateMetrics.savedWalletCount, [
        { label: '0', min: 0, max: 1 },
        { label: '1', min: 1, max: 2 },
        { label: '2-4', min: 2, max: 5 },
        { label: '5+', min: 5, max: Infinity },
      ]),
    }));
    return {
      source,
      label: SOURCE_LABELS[source],
      panels: {
        strategy: groupPnl(withBuckets, 'strategyId'),
        route: groupPnl(withBuckets, 'route'),
        exitReason: groupPnl(withBuckets, 'exitReason'),
        holderConcentration: groupPnl(withBuckets, 'holderBucket'),
        savedWallets: groupPnl(withBuckets, 'savedWalletBucket'),
        watchType: groupPnl(withBuckets, 'watchType'),
      },
    };
  }

  function shadowOutcomes() {
    const candidates = [
      path.resolve('reports/shadow-runner-analysis/SHADOW-RPT-1-2026-05-21T15-29-25Z/runner_outcomes.json'),
      ...fs.existsSync(path.resolve('reports/shadow-runner-analysis'))
        ? fs.readdirSync(path.resolve('reports/shadow-runner-analysis'))
          .map(name => path.resolve('reports/shadow-runner-analysis', name, 'runner_outcomes.json'))
        : [],
    ];
    const file = [...new Set(candidates)].filter(candidate => fs.existsSync(candidate)).sort().at(-1);
    if (!file) {
      return { status: 'unavailable', reason: 'runner_outcomes.json artifact not found', warning: 'shadow outcome data censored/incomplete' };
    }
    const rows = safeJson(fs.readFileSync(file, 'utf8'), []);
    if (!Array.isArray(rows)) {
      return { status: 'unavailable', reason: 'runner_outcomes.json is not an array', warning: 'shadow outcome data censored/incomplete' };
    }
    return {
      status: 'available',
      artifact: path.relative(process.cwd(), file),
      warning: 'analysis-only shadow observed outcomes; do not blend with live PnL',
      count: rows.length,
      runnerLabels: groupCount(rows, 'runner_label'),
      blockerSources: groupCount(rows, 'blocker_source'),
      observationCoverage: groupCount(rows.map(row => ({ observed: Number(row.has_observations) > 0 ? 'observed' : 'no_observation' })), 'observed'),
      sample: rows.slice(0, 50).map(row => compactObject({
        mint: row.mint,
        symbol: row.symbol,
        first_seen_at_ms: row.first_seen_at_ms,
        first_mcap_usd: row.first_mcap_usd,
        max_mcap_usd: row.max_mcap_usd,
        multiple: row.multiple,
        runner_label: row.runner_label,
        has_observations: row.has_observations,
        blocker_source: row.blocker_source,
        candidate_status: row.candidate_status,
      })),
    };
  }

  function close() {
    for (const db of Object.values(dbs)) db.close();
  }

  return {
    sources,
    summary,
    positions,
    positionDetail,
    watchDip,
    cohorts,
    shadowOutcomes,
    close,
    _dbs: dbs,
  };
}

export { sanitizeSnapshot, normalizePosition };
