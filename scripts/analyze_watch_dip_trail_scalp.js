#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

function usage() {
  return [
    'Usage:',
    '  node scripts/analyze_watch_dip_trail_scalp.js --db=/opt/trading-data/charon-shadow.sqlite --output-dir=reports/strategy/watch-dip-trail-scalp-<timestamp>',
    '',
    'Read-only shadow replay for early trailing-stop profiles. It opens SQLite readonly and writes JSON/CSV/Markdown reports.',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    minConfidence: 55,
    maxRows: 0,
  };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'output-dir') opts.outputDir = value;
    else if (key === 'min-confidence') opts.minConfidence = Number(value);
    else if (key === 'max-rows') opts.maxRows = Number(value);
    else throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }
  if (!opts.db) throw new Error(`--db is required.\n\n${usage()}`);
  if (!opts.outputDir) {
    const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
    opts.outputDir = path.join('reports', 'strategy', `watch-dip-trail-scalp-${stamp}`);
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

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolish(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function candidateMcap(candidate) {
  return numberOrNull(candidate?.metrics?.marketCapUsd)
    ?? numberOrNull(candidate?.metrics?.graduatedMarketCapUsd)
    ?? numberOrNull(candidate?.mcapSample?.marketCapUsd);
}

function candidateLiquidity(candidate) {
  return numberOrNull(candidate?.metrics?.liquidityUsd);
}

function maxHolderPercent(candidate) {
  return numberOrNull(candidate?.holders?.maxHolderPercent);
}

function top20Percent(candidate) {
  return numberOrNull(candidate?.holders?.top20Percent);
}

function savedWalletHolders(candidate) {
  return numberOrNull(candidate?.savedWalletExposure?.holderCount) ?? 0;
}

function gmgnFees(candidate) {
  return numberOrNull(candidate?.metrics?.gmgnTotalFeesSol) ?? 0;
}

function sourceCount(candidate) {
  return numberOrNull(candidate?.signals?.sourceCount) ?? 0;
}

function isDualSource(candidate) {
  const route = String(candidate?.signals?.route || '').toLowerCase();
  if (route.includes('dual')) return true;
  const sources = candidate?.signals?.sources;
  return Array.isArray(sources) ? new Set(sources.filter(Boolean)).size >= 2 : sourceCount(candidate) >= 2;
}

function configGrid() {
  const mcapBands = [
    { label: '$5k-$15k', min: 5_000, max: 15_000 },
    { label: '$8k-$25k', min: 8_000, max: 25_000 },
    { label: '$10k-$30k', min: 10_000, max: 30_000 },
    { label: '$15k-$45k', min: 15_000, max: 45_000 },
  ];
  const arms = [10, 12, 15, 20];
  const trails = [8, 10, 12, 15];
  const stops = [-25, -30, -35, -40];
  const tps = [40, 60, 80, 160, 999];
  const breakevens = [
    { label: 'off', arm: null, lock: null },
    { label: 'be10_lock3', arm: 10, lock: 3 },
    { label: 'be15_lock5', arm: 15, lock: 5 },
  ];
  const configs = [];
  for (const band of mcapBands) {
    for (const trailingArm of arms) {
      for (const trailingPercent of trails) {
        for (const tpPercent of tps) {
          for (const slPercent of stops) {
            for (const breakeven of breakevens) {
              configs.push({
                label: `${band.label}|tp${tpPercent}|arm${trailingArm}|trail${trailingPercent}|sl${slPercent}|${breakeven.label}`,
                band,
                tpPercent,
                slPercent,
                trailingArmPercent: trailingArm,
                trailingPercent,
                breakeven,
                minConfidence: 55,
                minLiquidity: 8_000,
                maxLiquidity: 25_000,
                maxHolder: 35,
                maxTop20: 75,
              });
            }
          }
        }
      }
    }
  }
  return configs;
}

function candidatePassesConfig(row, config) {
  const c = row.candidate;
  const mcap = row.entryMcap;
  const liquidity = candidateLiquidity(c);
  const maxHolder = maxHolderPercent(c);
  const top20 = top20Percent(c);
  if (row.confidence < config.minConfidence) return false;
  if (!boolish(c?.filters?.passed)) return false;
  if (!isDualSource(c)) return false;
  if (mcap == null || mcap < config.band.min || mcap > config.band.max) return false;
  if (liquidity == null || liquidity < config.minLiquidity || liquidity > config.maxLiquidity) return false;
  if (maxHolder != null && maxHolder > config.maxHolder) return false;
  if (top20 != null && top20 > config.maxTop20) return false;
  return true;
}

function replayPath(row, observations, config) {
  const entryMcap = row.entryMcap;
  if (!(entryMcap > 0)) return { status: 'invalid', exitReason: 'missing_entry_mcap' };
  const path = observations
    .filter(obs => obs.mint === row.mint && Number(obs.observed_at_ms) >= Number(row.atMs))
    .map(obs => ({
      atMs: Number(obs.observed_at_ms),
      mcap: numberOrNull(obs.market_cap_usd),
    }))
    .filter(obs => obs.mcap != null && obs.mcap > 0)
    .sort((a, b) => a.atMs - b.atMs);

  if (!path.length) {
    return {
      status: 'no_observations',
      entryMcap,
      exitMcap: null,
      highWaterMcap: entryMcap,
      pnlPercent: null,
      exitReason: 'NO_OBSERVATIONS',
      holdMs: null,
      observationCount: 0,
    };
  }

  let highWaterMcap = entryMcap;
  let trailingArmed = false;
  let breakevenArmed = false;
  let maxDrawdownPercent = 0;

  for (const point of path) {
    if (point.mcap > highWaterMcap) highWaterMcap = point.mcap;
    const pnlPercent = ((point.mcap / entryMcap) - 1) * 100;
    const drawdownPercent = highWaterMcap > 0 ? ((point.mcap / highWaterMcap) - 1) * 100 : 0;
    maxDrawdownPercent = Math.min(maxDrawdownPercent, drawdownPercent);

    if (!breakevenArmed && config.breakeven.arm != null && pnlPercent >= config.breakeven.arm) {
      breakevenArmed = true;
    }
    if (!trailingArmed && pnlPercent >= config.trailingArmPercent) {
      trailingArmed = true;
    }

    let exitReason = null;
    let exitMcap = point.mcap;
    let exitPnlPercent = pnlPercent;
    if (pnlPercent <= config.slPercent) {
      exitReason = 'SL';
      exitPnlPercent = config.slPercent;
      exitMcap = entryMcap * (1 + exitPnlPercent / 100);
    } else if (breakevenArmed && config.breakeven.lock != null && pnlPercent <= config.breakeven.lock) {
      exitReason = 'BREAKEVEN_LOCK';
      exitPnlPercent = config.breakeven.lock;
      exitMcap = entryMcap * (1 + exitPnlPercent / 100);
    } else if (pnlPercent >= config.tpPercent) {
      exitReason = 'TP';
      exitPnlPercent = config.tpPercent;
      exitMcap = entryMcap * (1 + exitPnlPercent / 100);
    } else if (trailingArmed && drawdownPercent <= -Math.abs(config.trailingPercent)) {
      exitReason = 'TRAILING_TP';
      exitMcap = highWaterMcap * (1 - Math.abs(config.trailingPercent) / 100);
      exitPnlPercent = ((exitMcap / entryMcap) - 1) * 100;
    }

    if (exitReason) {
      return {
        status: 'closed',
        entryMcap,
        exitMcap,
        highWaterMcap,
        pnlPercent: exitPnlPercent,
        exitReason,
        holdMs: point.atMs - row.atMs,
        observationCount: path.length,
        maxDrawdownPercent,
        highWaterCapture: highWaterMcap > 0 ? exitMcap / highWaterMcap : null,
      };
    }
  }

  const last = path.at(-1);
  const pnlPercent = ((last.mcap / entryMcap) - 1) * 100;
  return {
    status: 'censored',
    entryMcap,
    exitMcap: last.mcap,
    highWaterMcap,
    pnlPercent,
    exitReason: 'CENSORED',
    holdMs: last.atMs - row.atMs,
    observationCount: path.length,
    maxDrawdownPercent,
    highWaterCapture: highWaterMcap > 0 ? last.mcap / highWaterMcap : null,
  };
}

function percentile(values, p) {
  const clean = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * p)));
  return clean[index];
}

function summarize(config, rows) {
  const closed = rows.filter(row => row.status === 'closed');
  const pnls = rows.map(row => row.pnlPercent).filter(value => Number.isFinite(value));
  const closedPnls = closed.map(row => row.pnlPercent).filter(value => Number.isFinite(value));
  const exitReasons = {};
  for (const row of rows) exitReasons[row.exitReason] = (exitReasons[row.exitReason] || 0) + 1;
  const screenshotStyle = closed.filter(row => row.pnlPercent >= 8 && row.pnlPercent <= 80).length;
  return {
    config: config.label,
    mcap_band: config.band.label,
    trailing_arm_percent: config.trailingArmPercent,
    trailing_percent: config.trailingPercent,
    tp_percent: config.tpPercent,
    sl_percent: config.slPercent,
    breakeven: config.breakeven.label,
    sample_count: rows.length,
    closed_count: closed.length,
    censored_count: rows.filter(row => row.status === 'censored').length,
    no_observation_count: rows.filter(row => row.status === 'no_observations').length,
    win_rate_closed: closed.length ? closed.filter(row => row.pnlPercent > 0).length / closed.length : null,
    screenshot_style_rate_closed: closed.length ? screenshotStyle / closed.length : null,
    avg_pnl_closed: closedPnls.length ? closedPnls.reduce((sum, value) => sum + value, 0) / closedPnls.length : null,
    median_pnl_closed: percentile(closedPnls, 0.5),
    p25_pnl_closed: percentile(closedPnls, 0.25),
    worst_pnl_closed: closedPnls.length ? Math.min(...closedPnls) : null,
    best_pnl_closed: closedPnls.length ? Math.max(...closedPnls) : null,
    avg_pnl_all_mark_to_last: pnls.length ? pnls.reduce((sum, value) => sum + value, 0) / pnls.length : null,
    median_hold_min_closed: percentile(closed.map(row => row.holdMs / 60_000), 0.5),
    avg_high_water_capture_closed: closed.length
      ? closed.reduce((sum, row) => sum + (Number(row.highWaterCapture) || 0), 0) / closed.length
      : null,
    trailing_exit_rate_closed: closed.length ? closed.filter(row => row.exitReason === 'TRAILING_TP').length / closed.length : null,
    exit_reasons: exitReasons,
  };
}

function csvEscape(value) {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/["\n\r,]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return [columns.join(','), ...rows.map(row => columns.map(column => csvEscape(row[column])).join(','))].join('\n') + '\n';
}

function fmtPct(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';
}

function fmtNum(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : 'n/a';
}

function mdCell(value) {
  return String(value ?? 'n/a').replace(/\|/g, '\\|');
}

function markdownReport({ top, outputDir, startedRows, notes }) {
  const lines = [
    '# Watch-Dip Trail-Scalp Replay',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Scope',
    '',
    '- Read-only replay over shadow `decision_logs` + `token_observations`.',
    '- Entry point is `llm_watch_dip_not_started` WATCH rows, because `entry_watchlist` has no triggered rows yet.',
    '- This is hypothesis generation, not deploy evidence.',
    '',
    '## Input',
    '',
    `- candidate rows considered: ${startedRows}`,
    ...notes.map(note => `- ${note}`),
    '',
    '## Top Configs',
    '',
    '| rank | mcap band | tp % | arm % | trail % | sl % | breakeven | samples | closed | censored | no obs | win closed | screenshot-style closed | trailing exits closed | avg pnl closed | median pnl closed | worst pnl | hold min | high-water capture |',
    '|---:|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  top.forEach((row, index) => {
    const cells = [
      index + 1,
      mdCell(row.mcap_band),
      fmtNum(row.tp_percent, 0),
      fmtNum(row.trailing_arm_percent, 0),
      fmtNum(row.trailing_percent, 0),
      fmtNum(row.sl_percent, 0),
      mdCell(row.breakeven),
      row.sample_count,
      row.closed_count,
      row.censored_count,
      row.no_observation_count,
      fmtPct(row.win_rate_closed),
      fmtPct(row.screenshot_style_rate_closed),
      fmtPct(row.trailing_exit_rate_closed),
      fmtNum(row.avg_pnl_closed),
      fmtNum(row.median_pnl_closed),
      fmtNum(row.worst_pnl_closed),
      fmtNum(row.median_hold_min_closed),
      fmtPct(row.avg_high_water_capture_closed),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  });
  lines.push('', '## Files', '', `- ${path.join(outputDir, 'summary.json')}`, `- ${path.join(outputDir, 'summary.csv')}`, `- ${path.join(outputDir, 'examples.csv')}`, '');
  return lines.join('\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = path.resolve(opts.db);
  const outputDir = path.resolve(opts.outputDir);
  fs.mkdirSync(outputDir, { recursive: true });

  const db = new Database(dbPath, { readonly: true });
  const limitSql = opts.maxRows > 0 ? 'LIMIT ?' : '';
  const args = opts.maxRows > 0 ? ['llm_watch_dip_not_started', opts.minConfidence, opts.maxRows] : ['llm_watch_dip_not_started', opts.minConfidence];
  const decisionRows = db.prepare(`
    SELECT id, at_ms, selected_candidate_id, selected_mint, confidence, candidate_json
    FROM decision_logs
    WHERE action = ?
      AND verdict = 'WATCH'
      AND confidence >= ?
      AND selected_mint IS NOT NULL
      AND candidate_json IS NOT NULL
    ORDER BY at_ms
    ${limitSql}
  `).all(...args);

  const candidates = decisionRows.map(row => {
    const candidate = safeJson(row.candidate_json, {});
    return {
      id: row.id,
      atMs: Number(row.at_ms),
      candidateId: row.selected_candidate_id,
      mint: row.selected_mint,
      confidence: Number(row.confidence || 0),
      candidate,
      entryMcap: candidateMcap(candidate),
      liquidity: candidateLiquidity(candidate),
      maxHolderPercent: maxHolderPercent(candidate),
      top20Percent: top20Percent(candidate),
      savedWalletHolders: savedWalletHolders(candidate),
      gmgnFees: gmgnFees(candidate),
      sourceCount: sourceCount(candidate),
      route: candidate?.signals?.route || null,
    };
  }).filter(row => row.mint && row.entryMcap > 0);

  const observations = db.prepare(`
    SELECT mint, observed_at_ms, market_cap_usd
    FROM token_observations
    WHERE market_cap_usd IS NOT NULL
    ORDER BY mint, observed_at_ms
  `).all();

  const byMint = new Map();
  for (const obs of observations) {
    const bucket = byMint.get(obs.mint) || [];
    bucket.push(obs);
    byMint.set(obs.mint, bucket);
  }

  const summaries = [];
  const examples = [];
  for (const config of configGrid()) {
    const matched = candidates.filter(row => candidatePassesConfig(row, config));
    const replays = matched.map(row => ({
      ...replayPath(row, byMint.get(row.mint) || [], config),
      mint: row.mint,
      candidate_id: row.candidateId,
      decision_log_id: row.id,
      confidence: row.confidence,
      liquidity: row.liquidity,
      max_holder_percent: row.maxHolderPercent,
      top20_percent: row.top20Percent,
      saved_wallet_holders: row.savedWalletHolders,
      gmgn_fees: row.gmgnFees,
      source_count: row.sourceCount,
      route: row.route,
      config: config.label,
    }));
    summaries.push(summarize(config, replays));
    for (const row of replays.filter(item => item.status === 'closed' && item.pnlPercent >= 8 && item.pnlPercent <= 80).slice(0, 3)) {
      examples.push(row);
    }
  }

  const ranked = summaries
    .filter(row => row.sample_count >= 5)
    .sort((a, b) => {
      const scoreA = (a.screenshot_style_rate_closed || 0) * Math.log10(a.closed_count + 1) + (a.avg_pnl_closed || -100) / 1000;
      const scoreB = (b.screenshot_style_rate_closed || 0) * Math.log10(b.closed_count + 1) + (b.avg_pnl_closed || -100) / 1000;
      return scoreB - scoreA;
    });

  const payload = {
    generated_at: new Date().toISOString(),
    db_path: dbPath,
    input: {
      decision_rows: decisionRows.length,
      candidate_rows: candidates.length,
      observation_rows: observations.length,
      min_confidence: opts.minConfidence,
    },
    notes: [
      'entry point is llm_watch_dip_not_started WATCH rows, not actual trigger rows',
      'paths use sparse token_observations market_cap_usd samples',
      'censored rows are marked to last observation but not treated as closed exits',
    ],
    top: ranked.slice(0, 25),
    all: summaries,
  };

  fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outputDir, 'summary.csv'), toCsv(summaries));
  fs.writeFileSync(path.join(outputDir, 'examples.csv'), toCsv(examples));
  fs.writeFileSync(path.join(outputDir, 'report.md'), markdownReport({
    top: ranked.slice(0, 10),
    outputDir,
    startedRows: candidates.length,
    notes: payload.notes,
  }));
  console.log(`Wrote ${outputDir}`);
  console.log(JSON.stringify(ranked.slice(0, 5), null, 2));
}

main();
