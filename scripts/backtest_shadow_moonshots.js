#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TARGET_MULTIPLES = [2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 100];
const STOP_LOSSES = [-40, -60, -80, -95];
const DRAG_PCT = 15;
const MCAP_BANDS = [
  { label: 'all', min: 0, max: Infinity },
  { label: '1k-5k', min: 1_000, max: 5_000 },
  { label: '5k-15k', min: 5_000, max: 15_000 },
  { label: '8k-25k', min: 8_000, max: 25_000 },
  { label: '10k-50k', min: 10_000, max: 50_000 },
  { label: '25k-100k', min: 25_000, max: 100_000 },
];
const DIP_PROFILES = [
  { label: 'dip20_rec8_bh10', minPullback: 20, maxPullback: 70, minRecovery: 8, minBelowHigh: 10 },
  { label: 'dip35_rec10_bh15', minPullback: 35, maxPullback: 80, minRecovery: 10, minBelowHigh: 15 },
];

function usage() {
  return [
    'Usage:',
    '  node scripts/backtest_shadow_moonshots.js --db=/opt/trading-data/charon-shadow.sqlite --output-dir=reports/strategy/moonshot-YYYYMMDD',
    '',
    'Read-only moonshot replay for 2x-100x spray-and-pray hypotheses.',
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
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '').replaceAll(':', '-');
    opts.outputDir = path.join('reports', 'strategy', `moonshot-${stamp}`);
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

function nested(obj, key) {
  return key.split('.').reduce((cur, part) => cur?.[part], obj);
}

function metric(snapshot, keys) {
  for (const key of keys) {
    const parsed = num(nested(snapshot, key));
    if (parsed != null) return parsed;
  }
  return null;
}

function sourceCount(snapshot) {
  return num(snapshot.sourceCount) ?? num(snapshot.signals?.sourceCount) ?? 0;
}

function isDualSource(snapshot) {
  if (String(snapshot.route || snapshot.signals?.route || '').toLowerCase().includes('dual')) return true;
  const sources = snapshot.sources || snapshot.signals?.sources;
  return Array.isArray(sources) ? new Set(sources.filter(Boolean)).size >= 2 : sourceCount(snapshot) >= 2;
}

function liquidity(point) {
  return num(point.liquidity_usd) ?? metric(point.snapshot, ['liquidityUsd', 'metrics.liquidityUsd']);
}

function top20(point) {
  return num(point.top20_holder_percent) ?? metric(point.snapshot, ['top20HolderPercent', 'holders.top20Percent']);
}

function savedWallets(point) {
  return num(point.saved_wallet_holders) ?? metric(point.snapshot, ['savedWalletHolders', 'savedWalletExposure.holderCount']) ?? 0;
}

function minimallySafe(point) {
  if (!(point.mcap >= 1_000 && point.mcap <= 100_000)) return false;
  const liq = liquidity(point);
  if (liq != null && liq < 1_000) return false;
  const t20 = top20(point);
  if (t20 != null && t20 > 90) return false;
  if (boolish(point.snapshot.trendingIsWashTrading) || boolish(point.snapshot.trending?.is_wash_trading)) return false;
  return sourceCount(point.snapshot) >= 1;
}

function loadPaths(db) {
  const rows = db.prepare(`
    SELECT id, mint, observed_at_ms, observation_kind, market_cap_usd, liquidity_usd,
           top20_holder_percent, saved_wallet_holders, feature_snapshot_json
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
    };
    if (!(point.mcap > 0) || !Number.isFinite(point.at_ms)) continue;
    if (!byMint.has(point.mint)) byMint.set(point.mint, []);
    byMint.get(point.mint).push(point);
  }
  for (const points of byMint.values()) points.sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
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
    mcap_band_value: point.mcap,
    liquidity_usd: liquidity(point),
    top20_holder_percent: top20(point),
    saved_wallet_holders: savedWallets(point),
    source_count: sourceCount(point.snapshot),
    dual_source: isDualSource(point.snapshot),
    filter_passed: boolish(point.snapshot.filterPassed),
    failure_codes: Array.isArray(point.snapshot.failureCodes) ? point.snapshot.failureCodes.join('|') : '',
    ...extra,
  };
}

function dipTrigger(anchor, history, point, profile) {
  const observed = [...history, point].map(item => item.mcap).filter(Number.isFinite);
  if (!(anchor.mcap > 0) || !(point.mcap > 0) || observed.length < 2) return null;
  const high = Math.max(anchor.mcap, ...observed);
  const low = Math.min(anchor.mcap, ...observed);
  const pullback = ((high - low) / high) * 100;
  const recovery = ((point.mcap - low) / low) * 100;
  const belowHigh = ((point.mcap - high) / high) * 100;
  if (pullback < profile.minPullback || pullback > profile.maxPullback) return null;
  if (recovery < profile.minRecovery) return null;
  if (belowHigh > -profile.minBelowHigh) return null;
  return { pullback_pct: pullback, recovery_pct: recovery, below_high_pct: belowHigh };
}

function entriesForPath(points) {
  if (points.length < 2) return [];
  const entries = [makeEntry(points[0], 'instant_first_seen')];
  const firstSafe = points.find(minimallySafe);
  if (firstSafe) entries.push(makeEntry(firstSafe, 'instant_min_safe'));
  const firstFilter = points.find(point => boolish(point.snapshot.filterPassed));
  if (firstFilter) entries.push(makeEntry(firstFilter, 'instant_filter_passed'));

  const anchor = firstSafe || points[0];
  const after = points.filter(point => point.at_ms > anchor.at_ms);
  for (const profile of DIP_PROFILES) {
    for (let index = 0; index < after.length; index += 1) {
      const point = after[index];
      if (!minimallySafe(point)) continue;
      const trigger = dipTrigger(anchor, after.slice(0, index), point, profile);
      if (!trigger) continue;
      entries.push(makeEntry(point, `wait_${profile.label}`, {
        anchor_mcap: anchor.mcap,
        anchor_at_ms: anchor.at_ms,
        ...trigger,
      }));
      break;
    }
  }
  return entries;
}

function futurePath(entry, points) {
  return points.filter(point => point.at_ms >= entry.entry_at_ms).sort((a, b) => a.at_ms - b.at_ms || a.id - b.id);
}

function labelPath(entry, points) {
  const future = futurePath(entry, points);
  if (!future.length || !(entry.entry_mcap > 0)) {
    return { max_multiple: null, max_pnl_percent: null, final_pnl_percent: null, observation_count: 0 };
  }
  const high = Math.max(...future.map(point => point.mcap));
  const last = future.at(-1);
  return {
    max_multiple: high / entry.entry_mcap,
    max_pnl_percent: ((high / entry.entry_mcap) - 1) * 100,
    final_pnl_percent: ((last.mcap / entry.entry_mcap) - 1) * 100,
    observation_count: future.length,
    first_at_ms: future[0].at_ms,
    last_at_ms: last.at_ms,
    hold_observed_hours: (last.at_ms - entry.entry_at_ms) / 3_600_000,
  };
}

function replay(entry, points, { targetMultiple, stopLoss }) {
  const future = futurePath(entry, points);
  if (!future.length || !(entry.entry_mcap > 0)) return { status: 'no_observation', exit_reason: 'NO_OBSERVATION' };
  const tpPercent = (targetMultiple - 1) * 100;
  let high = entry.entry_mcap;
  for (const point of future) {
    high = Math.max(high, point.mcap);
    const pnl = ((point.mcap / entry.entry_mcap) - 1) * 100;
    if (pnl >= tpPercent) return { status: 'closed', exit_reason: `${targetMultiple}x`, pnl_percent: tpPercent, high_water_mcap: high, exit_at_ms: point.at_ms };
    if (pnl <= stopLoss) return { status: 'closed', exit_reason: 'SL', pnl_percent: stopLoss, high_water_mcap: high, exit_at_ms: point.at_ms };
  }
  const last = future.at(-1);
  return {
    status: 'censored',
    exit_reason: 'CENSORED',
    pnl_percent: ((last.mcap / entry.entry_mcap) - 1) * 100,
    high_water_mcap: high,
    exit_at_ms: last.at_ms,
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

function passesBand(entry, band) {
  return entry.mcap_band_value >= band.min && entry.mcap_band_value <= band.max;
}

function summarizeLabels(entries, labels, entryMode, band) {
  const rows = entries
    .map(entry => ({ entry, label: labels.get(entry) }))
    .filter(item => item.entry.entry_mode === entryMode && passesBand(item.entry, band) && item.label?.max_multiple != null);
  const multiples = rows.map(item => item.label.max_multiple);
  const out = {
    entry_mode: entryMode,
    mcap_band: band.label,
    sample_count: rows.length,
    median_max_multiple: percentile(multiples, 0.5),
    p90_max_multiple: percentile(multiples, 0.9),
    p95_max_multiple: percentile(multiples, 0.95),
    p99_max_multiple: percentile(multiples, 0.99),
    avg_observed_hours: avg(rows.map(item => item.label.hold_observed_hours)),
  };
  for (const target of TARGET_MULTIPLES) {
    out[`hit_${target}x_count`] = rows.filter(item => item.label.max_multiple >= target).length;
    out[`hit_${target}x_rate`] = rows.length ? out[`hit_${target}x_count`] / rows.length : null;
  }
  return out;
}

function summarizeConfig(entries, labels, byMint, config) {
  const selected = entries.filter(entry => entry.entry_mode === config.entryMode && passesBand(entry, config.band));
  const outcomes = selected.map(entry => ({
    entry,
    label: labels.get(entry),
    replay: replay(entry, byMint.get(entry.mint) || [], config),
  }));
  const closed = outcomes.filter(item => item.replay.status === 'closed');
  const wins = closed.filter(item => item.replay.exit_reason !== 'SL');
  const losses = closed.filter(item => item.replay.exit_reason === 'SL');
  const censored = outcomes.filter(item => item.replay.status === 'censored');
  const noObs = outcomes.filter(item => item.replay.status === 'no_observation');
  const closedPnls = closed.map(item => item.replay.pnl_percent);
  const markToLastPnls = outcomes.map(item => item.replay.status === 'no_observation' ? -100 : item.replay.pnl_percent);
  const penalizedPnls = outcomes.map(item => {
    if (item.replay.status === 'closed') return item.replay.pnl_percent;
    return config.stopLoss;
  });
  const tailShare = (() => {
    const positive = closedPnls.filter(value => value > 0).sort((a, b) => b - a);
    const total = positive.reduce((sum, value) => sum + value, 0);
    return total > 0 ? positive.slice(0, 3).reduce((sum, value) => sum + value, 0) / total : null;
  })();
  const tpPercent = (config.targetMultiple - 1) * 100;
  return {
    config_id: `${config.entryMode}|${config.band.label}|target${config.targetMultiple}x|sl${config.stopLoss}`,
    entry_mode: config.entryMode,
    mcap_band: config.band.label,
    target_multiple: config.targetMultiple,
    tp_percent: tpPercent,
    sl_percent: config.stopLoss,
    risk_reward: tpPercent / Math.abs(config.stopLoss),
    breakeven_hit_rate: Math.abs(config.stopLoss) / (tpPercent + Math.abs(config.stopLoss)),
    sample_count: outcomes.length,
    closed_count: closed.length,
    wins: wins.length,
    losses: losses.length,
    censored_count: censored.length,
    no_observation_count: noObs.length,
    hit_rate_closed: closed.length ? wins.length / closed.length : null,
    hit_rate_all: outcomes.length ? wins.length / outcomes.length : null,
    avg_closed_pnl: avg(closedPnls),
    avg_mark_to_last_pnl: avg(markToLastPnls),
    avg_penalized_pnl: avg(penalizedPnls),
    avg_penalized_pnl_after_drag: avg(penalizedPnls.map(value => value - DRAG_PCT)),
    censor_rate: outcomes.length ? (censored.length + noObs.length) / outcomes.length : null,
    median_hold_hours_closed: percentile(closed.map(item => (item.replay.exit_at_ms - item.entry.entry_at_ms) / 3_600_000), 0.5),
    p95_max_multiple: percentile(outcomes.map(item => item.label?.max_multiple), 0.95),
    p99_max_multiple: percentile(outcomes.map(item => item.label?.max_multiple), 0.99),
    top3_positive_share: tailShare,
  };
}

function configs(entryModes) {
  const rows = [];
  for (const entryMode of entryModes) {
    for (const band of MCAP_BANDS) {
      for (const targetMultiple of TARGET_MULTIPLES) {
        for (const stopLoss of STOP_LOSSES) {
          rows.push({ entryMode, band, targetMultiple, stopLoss });
        }
      }
    }
  }
  return rows;
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

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '';
}

function fmtRate(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(3)}%` : '';
}

function rank(rows) {
  return rows
    .filter(row => row.sample_count >= 20)
    .sort((a, b) => {
      const scoreA = (a.avg_penalized_pnl_after_drag ?? -9999) + Math.log10(a.sample_count + 1);
      const scoreB = (b.avg_penalized_pnl_after_drag ?? -9999) + Math.log10(b.sample_count + 1);
      return scoreB - scoreA;
    });
}

function markdown({ outputDir, input, labelTop, configTop, caveats }) {
  const lines = [];
  lines.push('# Charon Shadow Moonshot Spray-And-Pray Backtest');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Intent');
  lines.push('');
  lines.push('Find low-win-rate entries that can plausibly hit 5x/10x/20x/50x/100x, not scalp-style TP/SL.');
  lines.push('');
  lines.push('## Input');
  lines.push('');
  lines.push(`- observations: ${input.observations}`);
  lines.push(`- mints with paths: ${input.mints}`);
  lines.push(`- entry candidates: ${input.entries}`);
  lines.push('');
  lines.push('## Highest Tail Labels');
  lines.push('');
  lines.push('| rank | entry | band | samples | hit 2x | hit 3x | hit 5x | hit 7x | hit 10x | hit 20x | hit 50x | hit 100x | p99 max multiple |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  labelTop.slice(0, 20).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.entry_mode} | ${row.mcap_band} | ${row.sample_count} | ${fmtRate(row.hit_2x_rate)} | ${fmtRate(row.hit_3x_rate)} | ${fmtRate(row.hit_5x_rate)} | ${fmtRate(row.hit_7x_rate)} | ${fmtRate(row.hit_10x_rate)} | ${fmtRate(row.hit_20x_rate)} | ${fmtRate(row.hit_50x_rate)} | ${fmtRate(row.hit_100x_rate)} | ${fmt(row.p99_max_multiple)} |`);
  });
  lines.push('');
  lines.push('## Best EV Configs With Stops');
  lines.push('');
  lines.push('| rank | entry | band | target | SL | R:R | samples | wins | hit all | censor | penalized after 15% drag | top3 gain share |');
  lines.push('|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  configTop.slice(0, 20).forEach((row, index) => {
    lines.push(`| ${index + 1} | ${row.entry_mode} | ${row.mcap_band} | ${row.target_multiple}x | ${row.sl_percent}% | ${fmt(row.risk_reward)} | ${row.sample_count} | ${row.wins} | ${fmtRate(row.hit_rate_all)} | ${fmtRate(row.censor_rate)} | ${fmt(row.avg_penalized_pnl_after_drag)}% | ${fmtRate(row.top3_positive_share)} |`);
  });
  lines.push('');
  lines.push('## Caveats');
  lines.push('');
  for (const caveat of caveats) lines.push(`- ${caveat}`);
  lines.push('');
  lines.push('## Files');
  lines.push('');
  for (const file of ['label_summary.csv', 'config_summary.csv', 'top_configs.csv', 'moonshot_examples.csv']) {
    lines.push(`- ${path.join(outputDir, file)}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function run(opts) {
  fs.mkdirSync(opts.outputDir, { recursive: true });
  const db = new Database(opts.db, { readonly: true, fileMustExist: true });
  const byMint = loadPaths(db);
  db.close();
  const entries = [];
  for (const points of byMint.values()) entries.push(...entriesForPath(points));
  const labels = new Map();
  for (const entry of entries) labels.set(entry, labelPath(entry, byMint.get(entry.mint) || []));
  const entryModes = [...new Set(entries.map(entry => entry.entry_mode))].sort();
  const labelRows = [];
  for (const entryMode of entryModes) {
    for (const band of MCAP_BANDS) labelRows.push(summarizeLabels(entries, labels, entryMode, band));
  }
  const labelTop = labelRows
    .filter(row => row.sample_count >= 20)
    .sort((a, b) => {
      if ((a.hit_100x_rate ?? 0) !== (b.hit_100x_rate ?? 0)) return (b.hit_100x_rate ?? 0) - (a.hit_100x_rate ?? 0);
      if ((a.hit_20x_rate ?? 0) !== (b.hit_20x_rate ?? 0)) return (b.hit_20x_rate ?? 0) - (a.hit_20x_rate ?? 0);
      return (b.p99_max_multiple ?? 0) - (a.p99_max_multiple ?? 0);
    });
  const configRows = configs(entryModes).map(config => summarizeConfig(entries, labels, byMint, config));
  const configTop = rank(configRows);
  const exampleRows = [];
  for (const row of labelTop.slice(0, 20)) {
    const matched = entries
      .filter(entry => entry.entry_mode === row.entry_mode && passesBand(entry, MCAP_BANDS.find(band => band.label === row.mcap_band)))
      .map(entry => ({ entry, label: labels.get(entry) }))
      .sort((a, b) => (b.label?.max_multiple ?? 0) - (a.label?.max_multiple ?? 0))
      .slice(0, 10);
    for (const item of matched) {
      exampleRows.push({
        entry_mode: row.entry_mode,
        mcap_band: row.mcap_band,
        mint: item.entry.mint,
        symbol: item.entry.symbol,
        entry_at_iso: new Date(item.entry.entry_at_ms).toISOString(),
        entry_mcap: fmt(item.entry.entry_mcap),
        max_multiple: fmt(item.label.max_multiple),
        final_pnl_percent: fmt(item.label.final_pnl_percent),
        observed_hours: fmt(item.label.hold_observed_hours),
        observation_count: item.label.observation_count,
      });
    }
  }
  const caveats = [
    'This labels observed high-water multiples, not guaranteed executable exits.',
    'Sparse observations can miss brief 10x-100x windows or invent exact target fills between samples.',
    'Rows without observations are outside this report, so universe coverage must be checked before deployment.',
    'Top EV rows can be dominated by one or two outliers; top3 positive gain share is reported for that reason.',
  ];
  fs.writeFileSync(path.join(opts.outputDir, 'label_summary.csv'), toCsv(labelRows));
  fs.writeFileSync(path.join(opts.outputDir, 'config_summary.csv'), toCsv(configRows));
  fs.writeFileSync(path.join(opts.outputDir, 'top_configs.csv'), toCsv(configTop.slice(0, 200)));
  fs.writeFileSync(path.join(opts.outputDir, 'moonshot_examples.csv'), toCsv(exampleRows));
  fs.writeFileSync(path.join(opts.outputDir, 'report.md'), markdown({
    outputDir: opts.outputDir,
    input: {
      observations: [...byMint.values()].reduce((sum, points) => sum + points.length, 0),
      mints: byMint.size,
      entries: entries.length,
    },
    labelTop,
    configTop,
    caveats,
  }));
  return {
    outputDir: opts.outputDir,
    observations: [...byMint.values()].reduce((sum, points) => sum + points.length, 0),
    mints: byMint.size,
    entries: entries.length,
    configs: configRows.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(run(parseArgs(process.argv.slice(2))), null, 2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
