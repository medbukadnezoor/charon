#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DEFAULT_TPS = [25, 35, 45, 60, 80, 100, 160];
const DEFAULT_SLS = [-20, -25, -30, -35, -40, -50, -60];
const DEFAULT_MCAP_BANDS = [
  { label: '$5k-$15k', min: 5_000, max: 15_000 },
  { label: '$8k-$25k', min: 8_000, max: 25_000 },
  { label: '$10k-$30k', min: 10_000, max: 30_000 },
  { label: '$12k-$45k', min: 12_000, max: 45_000 },
  { label: '$15k-$45k', min: 15_000, max: 45_000 },
  { label: '$10k-$90k', min: 10_000, max: 90_000 },
];
const DEFAULT_CONFIDENCE_FLOORS = [60, 70];
const DEFAULT_TOP20_CAPS = [65, 75];
const DEFAULT_TRIGGER_PROFILES = [
  { label: 'pb12_rec8_bh10', minPullback: 12, maxPullback: 45, minRecovery: 8, minBelowHigh: 10 },
  { label: 'pb18_rec8_bh10', minPullback: 18, maxPullback: 45, minRecovery: 8, minBelowHigh: 10 },
  { label: 'pb25_rec8_bh10', minPullback: 25, maxPullback: 45, minRecovery: 8, minBelowHigh: 10 },
  { label: 'pb30_rec8_bh10', minPullback: 30, maxPullback: 45, minRecovery: 8, minBelowHigh: 10 },
  { label: 'pb25_rec12_bh10', minPullback: 25, maxPullback: 45, minRecovery: 12, minBelowHigh: 10 },
  { label: 'pb30_rec12_bh15', minPullback: 30, maxPullback: 45, minRecovery: 12, minBelowHigh: 15 },
];
const DRAG_SCENARIOS = [0, 2, 5, 10, 15];

export function usage() {
  return [
    'Usage:',
    '  node scripts/analyze_simple_rr_shadow.js --shadow-db=/opt/trading-data/charon-shadow.sqlite --output-dir=reports/strategy/simple-rr-YYYYMMDD',
    '',
    'Read-only shadow replay for simple hard TP/SL risk-reward configs.',
  ].join('\n');
}

export function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'shadow-db') opts.shadowDb = value;
    else if (key === 'live-db') opts.liveDb = value;
    else if (key === 'output-dir') opts.outputDir = value;
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!opts.shadowDb) throw new Error(`--shadow-db is required.\n\n${usage()}`);
  if (!opts.outputDir) {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    opts.outputDir = path.join('reports', 'strategy', `simple-rr-${stamp}`);
  }
  return opts;
}

function safeJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function num(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function pct(value) {
  return value == null || !Number.isFinite(value) ? '' : value.toFixed(2);
}

function pctFraction(value) {
  return value == null || !Number.isFinite(value) ? '' : `${pct(value * 100)}%`;
}

function pctSigned(value) {
  return value == null || !Number.isFinite(value) ? '' : `${pct(value)}%`;
}

function mdCell(value) {
  return String(value ?? '').replaceAll('|', '\\|');
}

function money(value) {
  return value == null || !Number.isFinite(value) ? '' : value.toFixed(2);
}

export function csvEscape(value) {
  if (value == null) return '';
  const text = Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text) || /[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

export function toCsv(rows, columns) {
  return [
    columns.join(','),
    ...rows.map(row => columns.map(column => csvEscape(row[column])).join(',')),
    '',
  ].join('\n');
}

function percentile(values, p) {
  const xs = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

function avg(values) {
  const xs = values.filter(value => Number.isFinite(value));
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function candidateFromPosition(row) {
  const snapshot = safeJson(row.snapshot_json, {});
  return snapshot?.candidate || {};
}

function getMetric(candidate, names) {
  for (const name of names) {
    const value = name.split('.').reduce((obj, key) => obj?.[key], candidate);
    const parsed = num(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function candidateLiquidity(candidate) {
  return getMetric(candidate, ['metrics.liquidityUsd', 'liquidityUsd']);
}

function candidateTop20(candidate) {
  return getMetric(candidate, ['holders.top20Percent', 'metrics.top20HolderPercent', 'top20HolderPercent', 'top20_holder_percent']);
}

function candidateMcap(candidate) {
  return getMetric(candidate, ['metrics.marketCapUsd', 'marketCapUsd', 'metrics.graduatedMarketCapUsd', 'mcapSample.marketCapUsd']);
}

function isDualSource(candidate) {
  const route = String(candidate?.signals?.route || '').toLowerCase();
  const flatRoute = String(candidate?.route || '').toLowerCase();
  if (route.includes('dual')) return true;
  if (flatRoute.includes('dual')) return true;
  const sources = candidate?.signals?.sources;
  if (Array.isArray(sources) && new Set(sources.filter(Boolean)).size >= 2) return true;
  if (Array.isArray(candidate?.sources) && new Set(candidate.sources.filter(Boolean)).size >= 2) return true;
  const sourceCount = num(candidate?.signals?.sourceCount);
  const flatSourceCount = num(candidate?.sourceCount);
  return (sourceCount != null && sourceCount >= 2) || (flatSourceCount != null && flatSourceCount >= 2);
}

function buildGrid() {
  const configs = [];
  for (const band of DEFAULT_MCAP_BANDS) {
    for (const trigger of DEFAULT_TRIGGER_PROFILES) {
      for (const tp of DEFAULT_TPS) {
        for (const sl of DEFAULT_SLS) {
          for (const confidenceFloor of DEFAULT_CONFIDENCE_FLOORS) {
            for (const top20Cap of DEFAULT_TOP20_CAPS) {
              configs.push({
                config_id: `${band.label}|${trigger.label}|tp${tp}|sl${sl}|conf${confidenceFloor}|top20${top20Cap}`,
                mcap_band: band.label,
                min_mcap: band.min,
                max_mcap: band.max,
                trigger_label: trigger.label,
                min_pullback_pct: trigger.minPullback,
                max_pullback_pct: trigger.maxPullback,
                min_recovery_from_low_pct: trigger.minRecovery,
                min_below_high_pct: trigger.minBelowHigh,
                tp_percent: tp,
                sl_percent: sl,
                confidence_floor: confidenceFloor,
                require_dual_source: true,
                min_liquidity_usd: 8_000,
                max_liquidity_usd: 35_000,
                top20_cap_percent: top20Cap,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

function classifyEntry(row, watchByPositionId, decisionById) {
  const watch = watchByPositionId.get(row.id);
  if (watch) {
    if (watch.watch_type === 'watch_dip') return 'watch_dip_trigger';
    return 'entry_watch_retry';
  }
  const decision = decisionById.get(row.llm_decision_id);
  const action = String(decision?.action || '').toLowerCase();
  const reason = `${decision?.reason || ''} ${row.snapshot_json || ''}`.toLowerCase();
  if (action.includes('watch_dip') || reason.includes('watch_dip') || reason.includes('watch-dip')) return 'watch_dip_trigger';
  if (action.includes('reentry') || reason.includes('reentry')) return 'first_watch_replay';
  return 'direct_buy';
}

function lastDecisionAction(snapshot) {
  const events = Array.isArray(snapshot?.decisionEvents) ? snapshot.decisionEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.stage === 'llm_decision') return `llm_${event.action || 'unknown'}`;
    if (event?.stage === 'entry_decision') return `entry_${event.action || 'unknown'}`;
  }
  return snapshot?.latestDecisionAction ? `latest_${snapshot.latestDecisionAction}` : 'shadow_observed';
}

function confidenceFromSnapshot(snapshot) {
  const events = Array.isArray(snapshot?.decisionEvents) ? snapshot.decisionEvents : [];
  const confidence = num(snapshot?.confidence) ?? num(snapshot?.llmConfidence);
  if (confidence != null) return confidence;
  if (events.some(event => event?.stage === 'llm_decision')) return 60;
  if (snapshot?.filterPassed === true) return 60;
  return null;
}

function snapshotPassesEntryAnchor(snapshot) {
  return snapshot?.filterPassed === true && isDualSource(snapshot);
}

function candleColor(row) {
  if (row.ohlcv_open == null || row.ohlcv_close == null) return null;
  if (row.ohlcv_close > row.ohlcv_open) return 'green';
  if (row.ohlcv_close < row.ohlcv_open) return 'red';
  return 'flat';
}

function trailingGreenWithoutPullback(points, pullbackThresholdPct = 8) {
  let count = 0;
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const row = points[index];
    if (candleColor(row) !== 'green') break;
    const high = num(row.ohlcv_high);
    const low = num(row.ohlcv_low);
    if (high == null || low == null || high <= 0) break;
    if (((high - low) / high) * 100 >= pullbackThresholdPct) break;
    count += 1;
  }
  return count;
}

function upperWickDominant(points) {
  const sample = points.filter(point => point.ohlcv_high != null).slice(-3);
  if (sample.length < 3) return false;
  const dominant = sample.filter(row => {
    const high = num(row.ohlcv_high);
    const low = num(row.ohlcv_low);
    const open = num(row.ohlcv_open);
    const close = num(row.ohlcv_close);
    if (high == null || low == null || open == null || close == null || high <= low) return false;
    const upper = high - Math.max(open, close);
    return upper / (high - low) >= 0.5;
  }).length;
  return dominant >= 2;
}

function evaluateTriggerAtPoint({ anchor, history, point, profile }) {
  const currentMcap = point.mcap;
  const baseline = anchor.mcap;
  if (!(currentMcap > 0) || !(baseline > 0)) return { trigger: false, reason: 'baseline_unavailable' };
  if (currentMcap < 10_000 || currentMcap > 90_000) return { trigger: false, reason: 'current_mcap_out_of_range' };
  const recentHigh = Math.max(baseline, ...history.map(item => item.mcap).filter(Number.isFinite));
  const observedLow = Math.min(...history.map(item => item.mcap).filter(Number.isFinite), currentMcap);
  const pullbackFromBaseline = ((baseline - observedLow) / baseline) * 100;
  const pullbackFromRecentHigh = ((recentHigh - observedLow) / recentHigh) * 100;
  const pullbackPct = Math.max(pullbackFromBaseline, pullbackFromRecentHigh);
  const recoveryFromLowPct = observedLow > 0 ? ((currentMcap - observedLow) / observedLow) * 100 : null;
  const distanceBelowHighPct = recentHigh > 0 ? ((currentMcap - recentHigh) / recentHigh) * 100 : null;
  const staircaseCount = trailingGreenWithoutPullback([...history, point], 8);

  if (pullbackPct < profile.minPullback) return { trigger: false, reason: 'pullback_too_small', pullbackPct, recoveryFromLowPct, distanceBelowHighPct };
  if (pullbackPct > profile.maxPullback) return { trigger: false, reason: 'pullback_too_deep', pullbackPct, recoveryFromLowPct, distanceBelowHighPct };
  if (recoveryFromLowPct == null || recoveryFromLowPct < profile.minRecovery) return { trigger: false, reason: 'recovery_from_low_too_small', pullbackPct, recoveryFromLowPct, distanceBelowHighPct };
  if (distanceBelowHighPct == null || distanceBelowHighPct > -profile.minBelowHigh) return { trigger: false, reason: 'too_close_to_recent_high', pullbackPct, recoveryFromLowPct, distanceBelowHighPct };
  if (staircaseCount >= 5) return { trigger: false, reason: 'staircase_without_pullback', pullbackPct, recoveryFromLowPct, distanceBelowHighPct, staircaseCount };
  if (upperWickDominant([...history, point])) return { trigger: false, reason: 'upper_wick_exhaustion', pullbackPct, recoveryFromLowPct, distanceBelowHighPct, staircaseCount };
  return { trigger: true, reason: 'llm_watch_dip_triggered', pullbackPct, recoveryFromLowPct, distanceBelowHighPct, staircaseCount };
}

function buildWatchDipEntriesForMint(mint, cleanPath) {
  const anchors = cleanPath.filter(point => snapshotPassesEntryAnchor(point.snapshot));
  if (!anchors.length) return [];
  const anchor = anchors[0];
  const rows = [];
  for (const profile of DEFAULT_TRIGGER_PROFILES) {
    let entryPoint = null;
    const afterAnchor = cleanPath.filter(item => item.at_ms > anchor.at_ms);
    for (let index = 0; index < afterAnchor.length; index += 1) {
      const point = afterAnchor[index];
      const history = afterAnchor.slice(0, index);
      const trigger = evaluateTriggerAtPoint({ anchor, history, point, profile });
      if (trigger.trigger) {
        entryPoint = { ...point, trigger, profile };
        break;
      }
    }
    if (!entryPoint) continue;
    const snapshot = anchor.snapshot || {};
    const futurePath = cleanPath
      .filter(point => point.at_ms > entryPoint.at_ms)
      .map(point => ({ at_ms: point.at_ms, mcap: point.mcap }));
    if (!futurePath.length) continue;
    rows.push({
      id: `${anchor.id}:${profile.label}`,
      mint,
      symbol: snapshot.symbol || '',
      status: 'shadow_watch_dip',
      entry_mode: 'watch_dip_default',
      opened_at_ms: entryPoint.at_ms,
      anchor_at_ms: anchor.at_ms,
      closed_at_ms: null,
      anchor_mcap: anchor.mcap,
      pre_entry_high_mcap: Math.max(anchor.mcap, ...afterAnchor.filter(item => item.at_ms <= entryPoint.at_ms).map(item => item.mcap)),
      entry_mcap: entryPoint.mcap,
      trigger_label: profile.label,
      min_pullback_pct: profile.minPullback,
      max_pullback_pct: profile.maxPullback,
      min_recovery_from_low_pct: profile.minRecovery,
      min_below_high_pct: profile.minBelowHigh,
      observed_pullback_pct: entryPoint.trigger.pullbackPct,
      observed_recovery_from_low_pct: entryPoint.trigger.recoveryFromLowPct,
      observed_below_high_pct: entryPoint.trigger.distanceBelowHighPct,
      staircase_count: entryPoint.trigger.staircaseCount,
      actual_exit_mcap: null,
      actual_high_water_mcap: Math.max(entryPoint.mcap, ...futurePath.map(next => next.mcap)),
      actual_pnl_percent: null,
      actual_exit_reason: null,
      confidence: confidenceFromSnapshot(snapshot),
      decision_action: snapshot.latestDecisionAction || '',
      liquidity_usd: entryPoint.liquidity_usd ?? anchor.liquidity_usd ?? candidateLiquidity(snapshot),
      top20_holder_percent: entryPoint.top20_holder_percent ?? anchor.top20_holder_percent ?? candidateTop20(snapshot),
      dual_source: isDualSource(snapshot),
      filter_passed: snapshot.filterPassed === true,
      observation_kind: entryPoint.observation_kind,
      observations: futurePath,
    });
  }
  return rows;
}

function loadObservationRows(db) {
  const observations = db.prepare(`
    SELECT
      id, mint, observed_at_ms, observation_kind, market_cap_usd, liquidity_usd,
      top20_holder_percent, feature_snapshot_json
      , ohlcv_open, ohlcv_high, ohlcv_low, ohlcv_close
    FROM token_observations
    WHERE execution_lane = ?
      AND market_cap_usd IS NOT NULL
      AND feature_snapshot_json IS NOT NULL
    ORDER BY mint, observed_at_ms, id
  `).all('shadow_dry_run');
  const byMint = new Map();
  for (const obs of observations) {
    if (!byMint.has(obs.mint)) byMint.set(obs.mint, []);
    byMint.get(obs.mint).push({
      id: obs.id,
      mint: obs.mint,
      at_ms: Number(obs.observed_at_ms),
      mcap: num(obs.market_cap_usd),
      liquidity_usd: num(obs.liquidity_usd),
      top20_holder_percent: num(obs.top20_holder_percent),
      observation_kind: obs.observation_kind,
      snapshot: safeJson(obs.feature_snapshot_json, {}),
      ohlcv_open: num(obs.ohlcv_open),
      ohlcv_high: num(obs.ohlcv_high),
      ohlcv_low: num(obs.ohlcv_low),
      ohlcv_close: num(obs.ohlcv_close),
    });
  }

  const rows = [];
  for (const [mint, path] of byMint.entries()) {
    const cleanPath = path
      .filter(point => point.mcap > 0 && Number.isFinite(point.at_ms))
      .sort((a, b) => a.at_ms - b.at_ms);
    if (cleanPath.length < 2) continue;
    rows.push(...buildWatchDipEntriesForMint(mint, cleanPath));
  }
  return rows;
}

function passesConfig(row, config) {
  if (!(row.entry_mcap > 0)) return false;
  if (!row.filter_passed) return false;
  if (row.trigger_label !== config.trigger_label) return false;
  if (row.entry_mcap < config.min_mcap || row.entry_mcap > config.max_mcap) return false;
  if (row.confidence == null || row.confidence < config.confidence_floor) return false;
  if (config.require_dual_source && !row.dual_source) return false;
  if (row.liquidity_usd == null || row.liquidity_usd < config.min_liquidity_usd || row.liquidity_usd > config.max_liquidity_usd) return false;
  if (row.top20_holder_percent != null && row.top20_holder_percent > config.top20_cap_percent) return false;
  return true;
}

function replayHardPath(row, config) {
  if (!(row.entry_mcap > 0)) return { status: 'no_observation', exit_reason: 'MISSING_ENTRY_MCAP' };
  const path = row.observations
    .filter(obs => obs.at_ms >= row.opened_at_ms && obs.mcap > 0)
    .sort((a, b) => a.at_ms - b.at_ms);
  if (!path.length) {
    return {
      status: 'no_observation',
      entry_mcap: row.entry_mcap,
      exit_mcap: null,
      high_water_mcap: row.actual_high_water_mcap ?? row.entry_mcap,
      gross_pnl_percent: null,
      exit_reason: 'NO_OBSERVATIONS',
      observation_count: 0,
    };
  }

  let highWater = row.entry_mcap;
  for (const point of path) {
    highWater = Math.max(highWater, point.mcap);
    const gross = ((point.mcap / row.entry_mcap) - 1) * 100;
    if (gross >= config.tp_percent) {
      return {
        status: 'resolved',
        entry_mcap: row.entry_mcap,
        exit_mcap: row.entry_mcap * (1 + config.tp_percent / 100),
        high_water_mcap: highWater,
        gross_pnl_percent: config.tp_percent,
        exit_reason: 'TP',
        observation_count: path.length,
      };
    }
    if (gross <= config.sl_percent) {
      return {
        status: 'resolved',
        entry_mcap: row.entry_mcap,
        exit_mcap: row.entry_mcap * (1 + config.sl_percent / 100),
        high_water_mcap: highWater,
        gross_pnl_percent: config.sl_percent,
        exit_reason: 'SL',
        observation_count: path.length,
      };
    }
  }
  const last = path[path.length - 1];
  return {
    status: 'censored',
    entry_mcap: row.entry_mcap,
    exit_mcap: last.mcap,
    high_water_mcap: highWater,
    gross_pnl_percent: ((last.mcap / row.entry_mcap) - 1) * 100,
      exit_reason: 'NO_TP_SL_HIT',
    observation_count: path.length,
  };
}

function summarizeConfig(rows, config, entryMode) {
  const eligible = rows.filter(row => row.entry_mode === entryMode && passesConfig(row, config));
  const outcomes = eligible.map(row => ({ row, replay: replayHardPath(row, config) }));
  const resolved = outcomes.filter(item => item.replay.status === 'resolved');
  const wins = resolved.filter(item => item.replay.exit_reason === 'TP');
  const losses = resolved.filter(item => item.replay.exit_reason === 'SL');
  const censored = outcomes.filter(item => item.replay.status === 'censored');
  const noObservation = outcomes.filter(item => item.replay.status === 'no_observation');
  const grossValues = resolved.map(item => item.replay.gross_pnl_percent);
  const penalizedGrossValues = outcomes.map(item => {
    if (item.replay.status === 'resolved') return item.replay.gross_pnl_percent;
    return config.sl_percent;
  });

  const scenario = {};
  for (const drag of DRAG_SCENARIOS) {
    const netValues = resolved.map(item => item.replay.gross_pnl_percent - drag);
    const penalizedNetValues = outcomes.map(item => {
      if (item.replay.status === 'resolved') return item.replay.gross_pnl_percent - drag;
      return config.sl_percent - drag;
    });
    scenario[`net_win_rate_${drag}pct_drag`] = resolved.length
      ? wins.filter(item => item.replay.gross_pnl_percent - drag > 0).length / resolved.length
      : null;
    scenario[`net_expectancy_${drag}pct_drag`] = avg(netValues);
    scenario[`penalized_expectancy_${drag}pct_drag`] = avg(penalizedNetValues);
  }

  const baselineWinRate = resolved.length ? wins.length / resolved.length : null;
  const penalizedWinRate = outcomes.length ? wins.length / outcomes.length : null;
  const passSample = resolved.length >= 30;
  const passBaseline = (scenario.net_win_rate_2pct_drag ?? 0) >= 0.60;
  const passConservative = (scenario.net_expectancy_5pct_drag ?? -Infinity) > 0;
  const passCensoring = outcomes.length ? (censored.length + noObservation.length) / outcomes.length <= 0.25 : false;
  const deployCandidate = passSample && passBaseline && passConservative && passCensoring;
  const rejectReasons = [];
  if (!passSample) rejectReasons.push(resolved.length ? 'sample<30' : 'no_resolved_paths');
  if (!passBaseline) rejectReasons.push('baseline_net_win_rate<60%');
  if (!passConservative) rejectReasons.push('5%_drag_expectancy<=0');
  if (!passCensoring) rejectReasons.push('censored_or_no_obs>25%');

  return {
    ...config,
    entry_mode: entryMode,
    eligible_count: eligible.length,
    resolved_count: resolved.length,
    wins: wins.length,
    losses: losses.length,
    censored_count: censored.length,
    no_observation_count: noObservation.length,
    gross_win_rate: baselineWinRate,
    penalized_win_rate: penalizedWinRate,
    gross_expectancy: avg(grossValues),
    penalized_gross_expectancy: avg(penalizedGrossValues),
    ...scenario,
    exploratory: resolved.length < 30 ? 'yes' : 'no',
    deploy_candidate: deployCandidate ? 'yes' : 'no',
    reject_reasons: rejectReasons.join('|') || 'passes_gates',
    outcomes,
  };
}

function liveFeeDragRows(db) {
  const rows = db.prepare(`
    SELECT id, mint, symbol, opened_at_ms, closed_at_ms, entry_mcap, exit_mcap, high_water_mcap, exit_reason, pnl_percent
    FROM dry_run_positions
    WHERE execution_mode = ? AND status = ?
    ORDER BY closed_at_ms DESC
  `).all('live', 'closed');
  return rows.map(row => {
    const entry = num(row.entry_mcap);
    const exit = num(row.exit_mcap);
    const realized = num(row.pnl_percent);
    const gross = entry > 0 && exit > 0 ? ((exit / entry) - 1) * 100 : null;
    return {
      id: row.id,
      mint: row.mint,
      symbol: row.symbol,
      opened_at_ms: row.opened_at_ms,
      closed_at_ms: row.closed_at_ms,
      entry_mcap: money(entry),
      exit_mcap: money(exit),
      high_water_mcap: money(num(row.high_water_mcap)),
      exit_reason: row.exit_reason,
      gross_pnl_percent: pct(gross),
      realized_pnl_percent: pct(realized),
      drag_percent: pct(gross != null && realized != null ? gross - realized : null),
    };
  });
}

function writeReport(outputDir, summaryRows, examples, allRows) {
  const rankRows = rows => rows
    .sort((a, b) => {
      const aScore = [
        a.deploy_candidate === 'yes' ? 1 : 0,
        a.resolved_count,
        a.eligible_count,
        -(a.censored_count + a.no_observation_count),
        a.net_expectancy_5pct_drag ?? -999,
      ];
      const bScore = [
        b.deploy_candidate === 'yes' ? 1 : 0,
        b.resolved_count,
        b.eligible_count,
        -(b.censored_count + b.no_observation_count),
        b.net_expectancy_5pct_drag ?? -999,
      ];
      for (let i = 0; i < aScore.length; i += 1) {
        if (aScore[i] !== bScore[i]) return bScore[i] - aScore[i];
      }
      return String(a.config_id).localeCompare(String(b.config_id));
    });
  const allTop = rankRows(summaryRows.filter(row => row.eligible_count > 0))
    .slice(0, 5);
  const highWinTop = summaryRows
    .filter(row => row.resolved_count >= 30 && (row.net_win_rate_2pct_drag ?? 0) >= 0.60)
    .sort((a, b) => {
      if ((a.net_win_rate_2pct_drag ?? 0) !== (b.net_win_rate_2pct_drag ?? 0)) {
        return (b.net_win_rate_2pct_drag ?? 0) - (a.net_win_rate_2pct_drag ?? 0);
      }
      return (b.net_expectancy_5pct_drag ?? -999) - (a.net_expectancy_5pct_drag ?? -999);
    })
    .slice(0, 5);
  const positiveExpectancyTop = summaryRows
    .filter(row => row.resolved_count >= 30 && (row.net_expectancy_5pct_drag ?? -Infinity) > 0)
    .sort((a, b) => (b.net_expectancy_5pct_drag ?? -999) - (a.net_expectancy_5pct_drag ?? -999))
    .slice(0, 5);
  const modeCounts = new Map();
  for (const row of allRows) modeCounts.set(row.entry_mode, (modeCounts.get(row.entry_mode) || 0) + 1);
  const topModes = [...modeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  const lines = [];
  lines.push('# Charon Simple 1:1 Shadow Strategy Review');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Verdict');
  lines.push('');
  const anyDeploy = summaryRows.some(row => row.deploy_candidate === 'yes');
  lines.push(anyDeploy
    ? 'Deploy verdict: review required. At least one simple hard TP/SL config clears the mechanical gates, but this report should still be treated as shadow-only evidence.'
    : 'Deploy verdict: no deploy. No simple hard TP/SL config clears sample, censoring, and fee-drag gates.');
  lines.push('');
  lines.push('## Live Pause Evidence');
  lines.push('');
  lines.push('- Primary DB guard was set to `trading_mode=dry_run` after checking open live positions were zero.');
  lines.push('- PM2 `charon` was stopped by owner-selected hard pause.');
  lines.push('- `charon-shadow`, both observation collectors, and `cli-proxy-api` were left running.');
  lines.push('');
  lines.push('## Shadow Sample Shape');
  lines.push('');
  lines.push(`Observation-derived entry events: ${allRows.length}`);
  lines.push(`Distinct mints: ${new Set(allRows.map(row => row.mint)).size}`);
  lines.push('This pass uses only `token_observations.feature_snapshot_json` and later shadow mcap observations. Existing live outcomes are not an input.');
  lines.push('');
  lines.push('Top entry modes by observation-derived event count:');
  for (const [mode, count] of topModes) lines.push(`- ${mode}: ${count}`);
  lines.push('');
  lines.push('## Top 5 Simple Configs');
  lines.push('');
  lines.push('| Rank | Config | Eligible | Resolved | Censored | No obs | Win rate 2% drag | Exp 5% drag | Pass | Reject reasons |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|---:|---|---|');
  allTop.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${mdCell(row.config_id)} | ${row.eligible_count} | ${row.resolved_count} | ${row.censored_count} | ${row.no_observation_count} | ${pctFraction(row.net_win_rate_2pct_drag)} | ${pctSigned(row.net_expectancy_5pct_drag)} | ${row.deploy_candidate} | ${mdCell(row.reject_reasons)} |`);
  });
  lines.push('');
  lines.push('## Top 5 With Entry Mode');
  lines.push('');
  lines.push('| Rank | Entry mode | Config | Eligible | Resolved | Censored | No obs | Win rate 2% drag | Exp 5% drag | Reject reasons |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---|');
  allTop.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.entry_mode} | ${mdCell(row.config_id)} | ${row.eligible_count} | ${row.resolved_count} | ${row.censored_count} | ${row.no_observation_count} | ${pctFraction(row.net_win_rate_2pct_drag)} | ${pctSigned(row.net_expectancy_5pct_drag)} | ${mdCell(row.reject_reasons)} |`);
  });
  lines.push('');
  lines.push('## Interesting But Rejected Pockets');
  lines.push('');
  lines.push('These are useful for reverse engineering, but they still fail at least one gate.');
  lines.push('');
  lines.push('High win-rate pockets:');
  lines.push('');
  lines.push('| Rank | Config | Eligible | Resolved | Censored | Win rate 2% drag | Exp 5% drag | Reject reasons |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|---|');
  highWinTop.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${mdCell(row.config_id)} | ${row.eligible_count} | ${row.resolved_count} | ${row.censored_count + row.no_observation_count} | ${pctFraction(row.net_win_rate_2pct_drag)} | ${pctSigned(row.net_expectancy_5pct_drag)} | ${mdCell(row.reject_reasons)} |`);
  });
  lines.push('');
  lines.push('Positive 5% drag expectancy pockets:');
  lines.push('');
  lines.push('| Rank | Config | Eligible | Resolved | Censored | Win rate 2% drag | Exp 5% drag | Reject reasons |');
  lines.push('|---:|---|---:|---:|---:|---:|---:|---|');
  positiveExpectancyTop.forEach((row, index) => {
    lines.push(`| ${index + 1} | ${mdCell(row.config_id)} | ${row.eligible_count} | ${row.resolved_count} | ${row.censored_count + row.no_observation_count} | ${pctFraction(row.net_win_rate_2pct_drag)} | ${pctSigned(row.net_expectancy_5pct_drag)} | ${mdCell(row.reject_reasons)} |`);
  });
  lines.push('');
  lines.push('## Rejections');
  lines.push('');
  const rejected = summaryRows.filter(row => row.reject_reasons !== 'passes_gates');
  const grouped = new Map();
  for (const row of rejected) {
    grouped.set(row.reject_reasons, (grouped.get(row.reject_reasons) || 0) + 1);
  }
  for (const [reason, count] of [...grouped.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    lines.push(`- ${reason}: ${count} configs`);
  }
  lines.push('');
  lines.push('## Output Files');
  lines.push('');
  lines.push('- `summary.csv`: one row per config and entry mode.');
  lines.push('- `examples.csv`: example replay rows with entry, exit, high-water, gross PnL, and net PnL.');
  lines.push('- `examples.csv`: observation-derived replay rows for the best configs.');
  lines.push('- `live_fee_drag.csv` is intentionally not produced in this shadow-only pass.');
  lines.push('');

  fs.writeFileSync(path.join(outputDir, 'report.md'), `${lines.join('\n')}\n`);
}

export function run(opts) {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const shadow = new Database(opts.shadowDb, { readonly: true, fileMustExist: true });
  const rows = loadObservationRows(shadow);
  const configs = buildGrid();
  const entryModes = [...new Set(rows.map(row => row.entry_mode))].sort();
  const summaries = [];
  for (const entryMode of entryModes) {
    for (const config of configs) summaries.push(summarizeConfig(rows, config, entryMode));
  }

  const summaryRows = summaries.map(({ outcomes, ...row }) => {
    const out = { ...row };
    for (const key of Object.keys(out)) {
      if (typeof out[key] === 'number') out[key] = Number.isInteger(out[key]) ? out[key] : out[key].toFixed(4);
      if (out[key] == null) out[key] = '';
    }
    return out;
  });
  const summaryColumns = Object.keys(summaryRows[0] || {});
  fs.writeFileSync(path.join(opts.outputDir, 'summary.csv'), toCsv(summaryRows, summaryColumns));

  const ranked = summaries
    .filter(row => row.eligible_count > 0)
    .sort((a, b) => {
      if (a.resolved_count !== b.resolved_count) return b.resolved_count - a.resolved_count;
      if (a.eligible_count !== b.eligible_count) return b.eligible_count - a.eligible_count;
      return (b.net_expectancy_5pct_drag ?? -999) - (a.net_expectancy_5pct_drag ?? -999);
    })
    .slice(0, 5);
  const exampleRows = [];
  for (const summary of ranked) {
    for (const item of summary.outcomes.slice(0, 20)) {
      exampleRows.push({
        config_id: summary.config_id,
        entry_mode: summary.entry_mode,
        mint: item.row.mint,
        symbol: item.row.symbol,
        status: item.replay.status,
        exit_reason: item.replay.exit_reason,
        anchor_mcap: money(item.row.anchor_mcap),
        pre_entry_high_mcap: money(item.row.pre_entry_high_mcap),
        trigger_label: item.row.trigger_label,
        observed_pullback_pct: pct(item.row.observed_pullback_pct),
        observed_recovery_from_low_pct: pct(item.row.observed_recovery_from_low_pct),
        observed_below_high_pct: pct(item.row.observed_below_high_pct),
        staircase_count: item.row.staircase_count,
        entry_mcap: money(item.replay.entry_mcap),
        exit_mcap: money(item.replay.exit_mcap),
        high_water_mcap: money(item.replay.high_water_mcap),
        gross_pnl_percent: pct(item.replay.gross_pnl_percent),
        net_pnl_2pct_drag: pct(item.replay.gross_pnl_percent == null ? null : item.replay.gross_pnl_percent - 2),
        observation_count: item.replay.observation_count,
      });
    }
  }
  fs.writeFileSync(path.join(opts.outputDir, 'examples.csv'), toCsv(exampleRows, Object.keys(exampleRows[0] || {
    config_id: '', entry_mode: '', mint: '', symbol: '', status: '', exit_reason: '', entry_mcap: '',
    exit_mcap: '', high_water_mcap: '', gross_pnl_percent: '', net_pnl_2pct_drag: '', observation_count: '',
  })));

  writeReport(opts.outputDir, summaries, exampleRows, rows);
  return { outputDir: opts.outputDir, rows: rows.length, configs: summaries.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
