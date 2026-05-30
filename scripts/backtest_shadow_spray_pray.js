#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TP_GRID = [25, 35, 45, 60, 80, 100, 160];
const SL_GRID = [-15, -20, -25, -30, -35, -40, -50, -60];
const DRAG_GRID = [0, 2, 5, 10, 15];
const MCAP_BANDS = [
  { label: 'all', min: 0, max: Infinity },
  { label: '5k-15k', min: 5_000, max: 15_000 },
  { label: '8k-25k', min: 8_000, max: 25_000 },
  { label: '10k-30k', min: 10_000, max: 30_000 },
  { label: '10k-90k', min: 10_000, max: 90_000 },
];
const TRAILING_PROFILES = [
  { label: 'no_trail', enabled: false, arm: null, trail: null },
  { label: 'trail_arm35_drop20', enabled: true, arm: 35, trail: 20 },
  { label: 'trail_arm60_drop25', enabled: true, arm: 60, trail: 25 },
  { label: 'trail_arm80_drop30', enabled: true, arm: 80, trail: 30 },
];
const DIP_PROFILES = [
  { label: 'dip12_rec8_bh10', minPullback: 12, maxPullback: 55, minRecovery: 8, minBelowHigh: 10 },
  { label: 'dip20_rec8_bh10', minPullback: 20, maxPullback: 55, minRecovery: 8, minBelowHigh: 10 },
  { label: 'dip30_rec8_bh10', minPullback: 30, maxPullback: 55, minRecovery: 8, minBelowHigh: 10 },
  { label: 'dip30_rec12_bh15', minPullback: 30, maxPullback: 50, minRecovery: 12, minBelowHigh: 15 },
];

function usage() {
  return [
    'Usage:',
    '  node scripts/backtest_shadow_spray_pray.js --db=/opt/trading-data/charon-shadow.sqlite --output-dir=reports/strategy/spray-pray-YYYYMMDD',
    '',
    'Read-only replay over shadow token_observations. Writes CSV/JSON/Markdown reports.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'output-dir') opts.outputDir = value;
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!opts.db) throw new Error(`--db is required.\n\n${usage()}`);
  if (!opts.outputDir) {
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
    opts.outputDir = path.join('reports', 'strategy', `spray-pray-${stamp}`);
  }
  return opts;
}

function safeJson(raw, fallback = {}) {
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

function boolish(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function sourceCount(snapshot) {
  return num(snapshot.sourceCount) ?? num(snapshot.signals?.sourceCount) ?? 0;
}

function isDualSource(snapshot) {
  if (String(snapshot.route || snapshot.signals?.route || '').toLowerCase().includes('dual')) return true;
  const sources = snapshot.sources || snapshot.signals?.sources;
  return Array.isArray(sources) ? new Set(sources.filter(Boolean)).size >= 2 : sourceCount(snapshot) >= 2;
}

function snapshotMetric(snapshot, keys) {
  for (const key of keys) {
    const value = key.split('.').reduce((obj, part) => obj?.[part], snapshot);
    const parsed = num(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function pointMcap(point) {
  return num(point.market_cap_usd) ?? snapshotMetric(point.snapshot, ['marketCapUsd', 'metrics.marketCapUsd', 'mcapSample.marketCapUsd']);
}

function pointLiquidity(point) {
  return num(point.liquidity_usd) ?? snapshotMetric(point.snapshot, ['liquidityUsd', 'metrics.liquidityUsd']);
}

function pointTop20(point) {
  return num(point.top20_holder_percent) ?? snapshotMetric(point.snapshot, ['top20HolderPercent', 'holders.top20Percent']);
}

function pointSavedWallets(point) {
  return num(point.saved_wallet_holders) ?? snapshotMetric(point.snapshot, ['savedWalletHolders', 'savedWalletExposure.holderCount']) ?? 0;
}

function pointConfidence(point) {
  return num(point.snapshot.confidence) ?? num(point.snapshot.llmConfidence) ?? null;
}

function minimallySafe(point) {
  const mcap = point.mcap;
  const liquidity = pointLiquidity(point);
  const top20 = pointTop20(point);
  if (!(mcap >= 5_000 && mcap <= 90_000)) return false;
  if (liquidity != null && liquidity < 5_000) return false;
  if (!isDualSource(point.snapshot)) return false;
  if (top20 != null && top20 > 85) return false;
  if (boolish(point.snapshot.trendingIsWashTrading) || boolish(point.snapshot.trending?.is_wash_trading)) return false;
  return true;
}

function passesBand(entry, band) {
  return entry.entry_mcap >= band.min && entry.entry_mcap <= band.max;
}

function loadPaths(db) {
  const rows = db.prepare(`
    SELECT
      id, mint, observed_at_ms, observation_kind, market_cap_usd, liquidity_usd,
      top20_holder_percent, saved_wallet_holders, feature_snapshot_json,
      ohlcv_open, ohlcv_high, ohlcv_low, ohlcv_close
    FROM token_observations
    WHERE execution_lane = 'shadow_dry_run'
      AND market_cap_usd IS NOT NULL
      AND feature_snapshot_json IS NOT NULL
    ORDER BY mint, observed_at_ms, id
  `).all();
  const byMint = new Map();
  for (const row of rows) {
    const snapshot = safeJson(row.feature_snapshot_json, {});
    const point = {
      ...row,
      at_ms: Number(row.observed_at_ms),
      snapshot,
      mcap: num(row.market_cap_usd),
      ohlcv_open: num(row.ohlcv_open),
      ohlcv_high: num(row.ohlcv_high),
      ohlcv_low: num(row.ohlcv_low),
      ohlcv_close: num(row.ohlcv_close),
    };
    if (!(point.mcap > 0) || !Number.isFinite(point.at_ms)) continue;
    if (!byMint.has(row.mint)) byMint.set(row.mint, []);
    byMint.get(row.mint).push(point);
  }
  for (const pathRows of byMint.values()) pathRows.sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
  return byMint;
}

function makeEntry(point, mode, extra = {}) {
  return {
    mint: point.mint,
    symbol: point.snapshot.symbol || point.snapshot.name || '',
    entry_mode: mode,
    entry_at_ms: point.at_ms,
    entry_observation_id: point.id,
    entry_mcap: point.mcap,
    liquidity_usd: pointLiquidity(point),
    top20_holder_percent: pointTop20(point),
    saved_wallet_holders: pointSavedWallets(point),
    source_count: sourceCount(point.snapshot),
    dual_source: isDualSource(point.snapshot),
    filter_passed: boolish(point.snapshot.filterPassed),
    confidence: pointConfidence(point),
    failure_codes: Array.isArray(point.snapshot.failureCodes) ? point.snapshot.failureCodes.join('|') : '',
    ...extra,
  };
}

function dipTrigger(anchor, history, point, profile) {
  const anchorMcap = anchor.mcap;
  const current = point.mcap;
  const observed = [...history, point].map(item => item.mcap).filter(Number.isFinite);
  if (!(anchorMcap > 0) || !(current > 0) || observed.length < 2) return null;
  const high = Math.max(anchorMcap, ...observed);
  const low = Math.min(anchorMcap, ...observed);
  const pullback = ((high - low) / high) * 100;
  const recovery = ((current - low) / low) * 100;
  const belowHigh = ((current - high) / high) * 100;
  if (pullback < profile.minPullback || pullback > profile.maxPullback) return null;
  if (recovery < profile.minRecovery) return null;
  if (belowHigh > -profile.minBelowHigh) return null;
  return { pullback_pct: pullback, recovery_pct: recovery, below_high_pct: belowHigh };
}

function buildEntriesForPath(pathRows) {
  const entries = [];
  if (pathRows.length < 2) return entries;
  const first = pathRows[0];
  entries.push(makeEntry(first, 'instant_first_seen'));

  const firstSafe = pathRows.find(minimallySafe);
  if (firstSafe) entries.push(makeEntry(firstSafe, 'instant_min_safe'));

  const firstFilter = pathRows.find(point => boolish(point.snapshot.filterPassed));
  if (firstFilter) entries.push(makeEntry(firstFilter, 'instant_filter_passed'));

  const anchor = firstSafe || first;
  const afterAnchor = pathRows.filter(point => point.at_ms > anchor.at_ms);
  for (const profile of DIP_PROFILES) {
    for (let index = 0; index < afterAnchor.length; index += 1) {
      const point = afterAnchor[index];
      if (!minimallySafe(point)) continue;
      const trigger = dipTrigger(anchor, afterAnchor.slice(0, index), point, profile);
      if (!trigger) continue;
      entries.push(makeEntry(point, `wait_${profile.label}`, {
        anchor_at_ms: anchor.at_ms,
        anchor_mcap: anchor.mcap,
        pullback_pct: trigger.pullback_pct,
        recovery_pct: trigger.recovery_pct,
        below_high_pct: trigger.below_high_pct,
      }));
      break;
    }
  }
  return entries;
}

function replay(entry, pathRows, config) {
  const future = pathRows.filter(point => point.at_ms >= entry.entry_at_ms).sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
  if (!future.length || !(entry.entry_mcap > 0)) {
    return { status: 'no_observation', exit_reason: 'NO_OBSERVATION', pnl_percent: null, high_water_percent: null, max_drawdown_percent: null };
  }
  let highWater = entry.entry_mcap;
  let trailingArmed = false;
  let maxDrawdown = 0;
  for (const point of future) {
    highWater = Math.max(highWater, point.mcap);
    const pnl = ((point.mcap / entry.entry_mcap) - 1) * 100;
    const drawdown = ((point.mcap / highWater) - 1) * 100;
    maxDrawdown = Math.min(maxDrawdown, drawdown);
    if (config.trailing.enabled && pnl >= config.trailing.arm) trailingArmed = true;

    if (pnl <= config.sl) {
      return closeReplay('SL', config.sl, entry, point, highWater, maxDrawdown, future.length);
    }
    if (pnl >= config.tp) {
      return closeReplay('TP', config.tp, entry, point, highWater, maxDrawdown, future.length);
    }
    if (trailingArmed && drawdown <= -config.trailing.trail) {
      const exitMcap = highWater * (1 - config.trailing.trail / 100);
      const exitPnl = ((exitMcap / entry.entry_mcap) - 1) * 100;
      return closeReplay('TRAILING_TP', exitPnl, entry, point, highWater, maxDrawdown, future.length);
    }
  }
  const last = future.at(-1);
  const pnl = ((last.mcap / entry.entry_mcap) - 1) * 100;
  return {
    status: 'censored',
    exit_reason: 'CENSORED',
    pnl_percent: pnl,
    exit_at_ms: last.at_ms,
    exit_mcap: last.mcap,
    high_water_mcap: highWater,
    high_water_percent: ((highWater / entry.entry_mcap) - 1) * 100,
    max_drawdown_percent: maxDrawdown,
    observation_count: future.length,
  };
}

function closeReplay(reason, pnl, entry, point, highWater, maxDrawdown, observationCount) {
  return {
    status: 'closed',
    exit_reason: reason,
    pnl_percent: pnl,
    exit_at_ms: point.at_ms,
    exit_mcap: entry.entry_mcap * (1 + pnl / 100),
    high_water_mcap: highWater,
    high_water_percent: ((highWater / entry.entry_mcap) - 1) * 100,
    max_drawdown_percent: maxDrawdown,
    observation_count: observationCount,
  };
}

function avg(values) {
  const xs = values.filter(Number.isFinite);
  return xs.length ? xs.reduce((sum, value) => sum + value, 0) / xs.length : null;
}

function percentile(values, p) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!xs.length) return null;
  return xs[Math.min(xs.length - 1, Math.max(0, Math.floor((xs.length - 1) * p)))];
}

function summarize(config, outcomes) {
  const closed = outcomes.filter(row => row.replay.status === 'closed');
  const wins = closed.filter(row => row.replay.pnl_percent > 0);
  const losses = closed.filter(row => row.replay.pnl_percent <= 0);
  const censored = outcomes.filter(row => row.replay.status === 'censored');
  const noObs = outcomes.filter(row => row.replay.status === 'no_observation');
  const closedPnls = closed.map(row => row.replay.pnl_percent);
  const penalized = outcomes.map(row => row.replay.status === 'closed' ? row.replay.pnl_percent : config.sl);
  const drag = {};
  for (const d of DRAG_GRID) {
    drag[`net_expectancy_${d}pct_drag`] = avg(closedPnls.map(value => value - d));
    drag[`penalized_expectancy_${d}pct_drag`] = avg(penalized.map(value => value - d));
  }
  const exitCounts = {};
  for (const row of closed) exitCounts[row.replay.exit_reason] = (exitCounts[row.replay.exit_reason] || 0) + 1;
  const rr = config.tp / Math.abs(config.sl);
  const breakevenWinRate = Math.abs(config.sl) / (config.tp + Math.abs(config.sl));
  return {
    config_id: `${config.entryMode}|${config.band.label}|tp${config.tp}|sl${config.sl}|${config.trailing.label}`,
    entry_mode: config.entryMode,
    mcap_band: config.band.label,
    tp_percent: config.tp,
    sl_percent: config.sl,
    risk_reward: rr,
    breakeven_win_rate: breakevenWinRate,
    trailing: config.trailing.label,
    sample_count: outcomes.length,
    closed_count: closed.length,
    wins: wins.length,
    losses: losses.length,
    censored_count: censored.length,
    no_observation_count: noObs.length,
    closed_win_rate: closed.length ? wins.length / closed.length : null,
    all_win_rate: outcomes.length ? wins.length / outcomes.length : null,
    avg_closed_pnl: avg(closedPnls),
    median_closed_pnl: percentile(closedPnls, 0.5),
    p25_closed_pnl: percentile(closedPnls, 0.25),
    worst_closed_pnl: closedPnls.length ? Math.min(...closedPnls) : null,
    best_closed_pnl: closedPnls.length ? Math.max(...closedPnls) : null,
    avg_high_water_percent: avg(outcomes.map(row => row.replay.high_water_percent)),
    avg_max_drawdown_percent: avg(outcomes.map(row => row.replay.max_drawdown_percent)),
    median_hold_min: percentile(closed.map(row => (row.replay.exit_at_ms - row.entry.entry_at_ms) / 60_000), 0.5),
    censor_rate: outcomes.length ? (censored.length + noObs.length) / outcomes.length : null,
    exit_counts_json: JSON.stringify(exitCounts),
    ...drag,
  };
}

function configs(entryModes) {
  const list = [];
  for (const entryMode of entryModes) {
    for (const band of MCAP_BANDS) {
      for (const tp of TP_GRID) {
        for (const sl of SL_GRID) {
          for (const trailing of TRAILING_PROFILES) {
            list.push({ entryMode, band, tp, sl, trailing });
          }
        }
      }
    }
  }
  return list;
}

function configId(config) {
  return `${config.entryMode}|${config.band.label}|tp${config.tp}|sl${config.sl}|${config.trailing.label}`;
}

function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text) || /[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function toCsv(rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [columns.join(','), ...rows.map(row => columns.map(column => csvEscape(row[column])).join(',')), ''].join('\n');
}

function fmtPct(value, scale = 1) {
  return Number.isFinite(value) ? `${(value * scale).toFixed(2)}%` : '';
}

function fmtNum(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '';
}

function markdownReport({ outputDir, input, top, hypotheses, caveats }) {
  const lines = [];
  lines.push('# Charon Shadow Spray-And-Pray Backtest');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Scope');
  lines.push('');
  lines.push('- Read-only replay over all `shadow_dry_run` token observations with market-cap paths.');
  lines.push('- Entry families: instant first-sight, instant minimally-safe, instant filter-passed, and dip-wait triggers.');
  lines.push('- Exit families: hard TP/SL and simple trailing profiles.');
  lines.push('- Censored rows are not treated as wins; penalized expectancy marks unresolved rows as SL.');
  lines.push('');
  lines.push('## Input');
  lines.push('');
  lines.push(`- shadow observations: ${input.observations}`);
  lines.push(`- distinct mints with paths: ${input.mints}`);
  lines.push(`- generated entry candidates: ${input.entries}`);
  lines.push('');
  lines.push('## Top Robust Configs');
  lines.push('');
  lines.push('| rank | entry | band | TP | SL | R:R | trail | samples | closed | censor | win closed | exp 5% drag | penalized 5% drag | median hold min |');
  lines.push('|---:|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|');
  top.slice(0, 15).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.entry_mode} | ${row.mcap_band} | ${row.tp_percent} | ${row.sl_percent} | ${fmtNum(row.risk_reward)} | ${row.trailing} | ${row.sample_count} | ${row.closed_count} | ${fmtPct(row.censor_rate, 100)} | ${fmtPct(row.closed_win_rate, 100)} | ${fmtPct(row.net_expectancy_5pct_drag)} | ${fmtPct(row.penalized_expectancy_5pct_drag)} | ${fmtNum(row.median_hold_min, 1)} |`);
  });
  lines.push('');
  lines.push('## Hypotheses');
  lines.push('');
  for (const item of hypotheses) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  for (const item of caveats) lines.push(`- ${item}`);
  lines.push('');
  lines.push('## Files');
  lines.push('');
  lines.push(`- ${path.join(outputDir, 'summary.csv')}`);
  lines.push(`- ${path.join(outputDir, 'top_configs.csv')}`);
  lines.push(`- ${path.join(outputDir, 'entry_mode_summary.csv')}`);
  lines.push(`- ${path.join(outputDir, 'examples.csv')}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function rankSummaries(rows) {
  return rows
    .filter(row => row.sample_count >= 20 && row.closed_count >= 15 && row.censor_rate <= 0.5)
    .sort((a, b) => {
      const scoreA = (a.penalized_expectancy_5pct_drag ?? -999) + Math.log10(a.closed_count + 1) + ((a.closed_win_rate ?? 0) * 5);
      const scoreB = (b.penalized_expectancy_5pct_drag ?? -999) + Math.log10(b.closed_count + 1) + ((b.closed_win_rate ?? 0) * 5);
      return scoreB - scoreA;
    });
}

function entryModeSummary(summaries) {
  const modes = [...new Set(summaries.map(row => row.entry_mode))].sort();
  return modes.map(mode => {
    const rows = summaries.filter(row => row.entry_mode === mode && row.sample_count >= 20);
    const best = rankSummaries(rows)[0] || rows.sort((a, b) => (b.penalized_expectancy_5pct_drag ?? -999) - (a.penalized_expectancy_5pct_drag ?? -999))[0];
    return best ? {
      entry_mode: mode,
      best_config_id: best.config_id,
      sample_count: best.sample_count,
      closed_count: best.closed_count,
      censor_rate: best.censor_rate,
      closed_win_rate: best.closed_win_rate,
      risk_reward: best.risk_reward,
      net_expectancy_5pct_drag: best.net_expectancy_5pct_drag,
      penalized_expectancy_5pct_drag: best.penalized_expectancy_5pct_drag,
    } : { entry_mode: mode };
  });
}

function run(opts) {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const byMint = loadPaths(db);
  db.close();

  const entries = [];
  for (const pathRows of byMint.values()) entries.push(...buildEntriesForPath(pathRows));
  const byMode = [...new Set(entries.map(entry => entry.entry_mode))].sort();
  const summaries = [];
  const examples = [];
  const configById = new Map();

  for (const config of configs(byMode)) {
    configById.set(configId(config), config);
    const matched = entries.filter(entry => entry.entry_mode === config.entryMode && passesBand(entry, config.band));
    const outcomes = matched.map(entry => {
      const replayed = replay(entry, byMint.get(entry.mint) || [], config);
      return { entry, replay: replayed };
    });
    const summary = summarize(config, outcomes);
    summaries.push(summary);
    if (summary.sample_count >= 20) {
      for (const row of outcomes.filter(item => item.replay.status === 'closed').slice(0, 3)) {
        examples.push({
          config_id: summary.config_id,
          mint: row.entry.mint,
          symbol: row.entry.symbol,
          entry_mode: row.entry.entry_mode,
          entry_at_iso: new Date(row.entry.entry_at_ms).toISOString(),
          entry_mcap: fmtNum(row.entry.entry_mcap),
          exit_reason: row.replay.exit_reason,
          pnl_percent: fmtNum(row.replay.pnl_percent),
          high_water_percent: fmtNum(row.replay.high_water_percent),
          max_drawdown_percent: fmtNum(row.replay.max_drawdown_percent),
          observations: row.replay.observation_count,
        });
      }
    }
  }

  const top = rankSummaries(summaries);
  const modeRows = entryModeSummary(summaries);
  const sortedEntryTimes = entries.map(entry => entry.entry_at_ms).filter(Number.isFinite).sort((a, b) => a - b);
  const firstSplit = sortedEntryTimes[Math.floor(sortedEntryTimes.length / 3)] ?? 0;
  const secondSplit = sortedEntryTimes[Math.floor((sortedEntryTimes.length * 2) / 3)] ?? Infinity;
  const timeSplitRows = [];
  const topOutcomeRows = [];
  for (const row of top.slice(0, 50)) {
    const config = configById.get(row.config_id);
    if (!config) continue;
    const matched = entries.filter(entry => entry.entry_mode === config.entryMode && passesBand(entry, config.band));
    const outcomes = matched.map(entry => ({ entry, replay: replay(entry, byMint.get(entry.mint) || [], config) }));
    for (const [period, periodOutcomes] of [
      ['early', outcomes.filter(item => item.entry.entry_at_ms <= firstSplit)],
      ['middle', outcomes.filter(item => item.entry.entry_at_ms > firstSplit && item.entry.entry_at_ms <= secondSplit)],
      ['late', outcomes.filter(item => item.entry.entry_at_ms > secondSplit)],
    ]) {
      timeSplitRows.push({ period, ...summarize(config, periodOutcomes) });
    }
    if (topOutcomeRows.length < 2000) {
      for (const item of outcomes.slice(0, 40)) {
        topOutcomeRows.push({
          config_id: row.config_id,
          mint: item.entry.mint,
          symbol: item.entry.symbol,
          entry_mode: item.entry.entry_mode,
          entry_at_iso: new Date(item.entry.entry_at_ms).toISOString(),
          entry_mcap: fmtNum(item.entry.entry_mcap),
          liquidity_usd: fmtNum(item.entry.liquidity_usd),
          top20_holder_percent: fmtNum(item.entry.top20_holder_percent),
          saved_wallet_holders: item.entry.saved_wallet_holders,
          status: item.replay.status,
          exit_reason: item.replay.exit_reason,
          pnl_percent: fmtNum(item.replay.pnl_percent),
          high_water_percent: fmtNum(item.replay.high_water_percent),
          max_drawdown_percent: fmtNum(item.replay.max_drawdown_percent),
          observations: item.replay.observation_count,
        });
      }
    }
  }
  const best = top[0];
  const bestInstant = top.find(row => row.entry_mode.startsWith('instant'));
  const bestDip = top.find(row => row.entry_mode.startsWith('wait_'));
  const hypotheses = [
    best ? `Primary candidate: ${best.entry_mode} in ${best.mcap_band}, TP ${best.tp_percent}, SL ${best.sl_percent}, ${best.trailing}, R:R ${fmtNum(best.risk_reward)}.` : 'No robust config cleared the minimum sample/censor gates.',
    bestInstant ? `Instant-entry hypothesis: ${bestInstant.entry_mode} needs at least R:R ${fmtNum(bestInstant.risk_reward)} after drag to stay interesting.` : 'Instant-entry hypothesis did not clear robustness gates.',
    bestDip ? `Dip-wait hypothesis: ${bestDip.entry_mode} reduces chase risk if its penalized expectancy beats instant with similar sample size.` : 'Dip-wait hypothesis did not clear robustness gates.',
  ];
  const caveats = [
    'Observation cadence is sparse; TP/SL ordering between observations is unknown.',
    'Market-cap replay is not a signed fill model; apply slippage/fee drag before considering live use.',
    'This is a grid search over many configs, so top rows are hypotheses, not proof.',
    'Censored rows remain a major risk; use penalized expectancy for conservative ranking.',
  ];

  fs.writeFileSync(path.join(opts.outputDir, 'summary.csv'), toCsv(summaries));
  fs.writeFileSync(path.join(opts.outputDir, 'top_configs.csv'), toCsv(top.slice(0, 100)));
  fs.writeFileSync(path.join(opts.outputDir, 'entry_mode_summary.csv'), toCsv(modeRows));
  fs.writeFileSync(path.join(opts.outputDir, 'time_split_top_configs.csv'), toCsv(timeSplitRows));
  fs.writeFileSync(path.join(opts.outputDir, 'top_outcomes.csv'), toCsv(topOutcomeRows));
  fs.writeFileSync(path.join(opts.outputDir, 'examples.csv'), toCsv(examples.slice(0, 500)));
  fs.writeFileSync(path.join(opts.outputDir, 'report.md'), markdownReport({
    outputDir: opts.outputDir,
    input: {
      observations: [...byMint.values()].reduce((sum, rows) => sum + rows.length, 0),
      mints: byMint.size,
      entries: entries.length,
    },
    top,
    hypotheses,
    caveats,
  }));
  fs.writeFileSync(path.join(opts.outputDir, 'hypotheses.json'), JSON.stringify({ best, bestInstant, bestDip, hypotheses, caveats }, null, 2));

  return { outputDir: opts.outputDir, observations: [...byMint.values()].reduce((sum, rows) => sum + rows.length, 0), mints: byMint.size, entries: entries.length, configs: summaries.length, robustConfigs: top.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(run(parseArgs(process.argv.slice(2))), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
