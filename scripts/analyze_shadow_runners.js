#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { evaluateBuiltInRecipes } from '../src/analysis/filterEval.js';
import { analyzeHarvesterCoverage, skippedHarvesterCoverage } from '../src/analysis/harvesterCoverage.js';
import { analyzeHarvesterTradeTiming, skippedHarvesterTradeTiming } from '../src/analysis/harvesterTradeTiming.js';
import { attachWalletRecurrenceFeatures, buildWalletRecurrenceIndex, summarizeWalletPredictiveness } from '../src/analysis/walletPredictiveness.js';
import {
  crossTab,
  distribution,
  FIRST_MCAP_BANDS,
  materializeOutcomes,
  medianBy,
  outcomeCounts,
  PEAK_MCAP_BANDS,
  RUNNER_LABELS,
  TIME_TO_PEAK_BANDS,
  topMissedRunners,
} from '../src/analysis/runnerOutcomes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function usage() {
  return [
    'Usage:',
    '  node scripts/analyze_shadow_runners.js --db=/opt/trading-data/charon-shadow.sqlite [--harvester-db=/opt/trading-data/harvester.db] [--output-dir=reports/shadow-runner-analysis/<timestamp>] [--min-multiple=2] [--max-first-mcap=500000] [--skip-observations]',
    '',
    'Compatibility:',
    '  --out=<base-dir> writes to <base-dir>/<timestamp>.',
    '',
    'Produces:',
    '  runner_outcomes.json',
    '  runner_outcomes.csv',
    '  filter_comparison.json',
    '  filter_comparison.csv',
    '  wallet_predictiveness.json',
    '  wallet_predictiveness.csv',
    '  wallet_recurrence.json',
    '  wallet_recurrence.csv',
    '  harvester_coverage.json',
    '  harvester_coverage.csv when --harvester-db runs with a supported schema',
    '  harvester_trade_timing.json',
    '  harvester_trade_timing.csv when --harvester-db runs with supported trade history and candidate wallet rows',
    '  summary.md',
  ].join('\n');
}

export function parseArgs(argv) {
  const opts = {
    minMultiple: 2,
    maxFirstMcap: 500_000,
  };
  for (const arg of argv) {
    if (arg === '--skip-observations') {
      opts.skipObservations = true;
      continue;
    }
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    const [, key, value] = match;
    if (key === 'min-multiple') {
      opts.minMultiple = Number(value);
    } else if (key === 'max-first-mcap') {
      opts.maxFirstMcap = Number(value);
    } else if (key === 'output-dir') {
      opts.outputDir = value;
    } else if (key === 'out') {
      opts.out = value;
    } else if (key === 'db') {
      opts.db = value;
    } else if (key === 'harvester-db') {
      opts.harvesterDb = value;
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  if (!Number.isFinite(opts.minMultiple) || opts.minMultiple <= 0) {
    throw new Error(`--min-multiple must be a positive number.\n\n${usage()}`);
  }
  if (!Number.isFinite(opts.maxFirstMcap) || opts.maxFirstMcap <= 0) {
    throw new Error(`--max-first-mcap must be a positive number.\n\n${usage()}`);
  }
  return opts;
}

function assertDbPath(dbPath) {
  if (!dbPath) throw new Error(`--db is required.\n\n${usage()}`);
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`Shadow DB not found: ${resolved}`);
  return resolved;
}

function assertReadableHarvesterDbPath(dbPath) {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) throw new Error(`Harvester DB not found: ${resolved}`);
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    throw new Error(`Harvester DB is not readable: ${resolved}`);
  }
  return resolved;
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, '').replace(/:/g, '-');
}

function formatUsd(value) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `$${Math.round(Number(value)).toLocaleString('en-US')}`;
}

function formatMultiple(value) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `${Number(value).toFixed(2)}x`;
}

function formatMinutes(ms) {
  if (!Number.isFinite(Number(ms))) return 'n/a';
  return `${(Number(ms) / 60_000).toFixed(1)}m`;
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDateTime(ms) {
  if (!Number.isFinite(Number(ms))) return 'n/a';
  return new Date(Number(ms)).toISOString();
}

function markdownTableRow(values) {
  return values.map(value => String(value ?? '').replace(/\|/g, '\\|')).join(' | ').replace(/^/, '| ').replace(/$/, ' |');
}

export function csvEscape(value) {
  if (value == null) return '';
  const scalar = Array.isArray(value) || (typeof value === 'object')
    ? JSON.stringify(value)
    : String(value);
  if (/["\n\r,]/.test(scalar)) return `"${scalar.replace(/"/g, '""')}"`;
  return scalar;
}

export function toCsv(rows, preferredColumns = []) {
  const columns = [
    ...preferredColumns,
    ...[...new Set(rows.flatMap(row => Object.keys(row)))].filter(column => !preferredColumns.includes(column)),
  ];
  return [
    columns.map(csvEscape).join(','),
    ...rows.map(row => columns.map(column => csvEscape(row[column])).join(',')),
  ].join('\n') + '\n';
}

function markdownDistribution(title, rows) {
  const lines = [
    `## ${title}`,
    '',
    '| Band | Count |',
    '| --- | ---: |',
  ];
  for (const [band, count] of Object.entries(rows)) {
    lines.push(`| ${band} | ${count} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function markdownCrossTab(title, rows, rowLabel, columns) {
  const lines = [
    `## ${title}`,
    '',
    `| ${rowLabel} | ${columns.join(' | ')} | Total |`,
    `| --- | ${columns.map(() => '---:').join(' | ')} | ---: |`,
  ];
  for (const row of rows) {
    lines.push(`| ${row[rowLabel] || row.band || row.group || row.label} | ${columns.map(column => row[column] || 0).join(' | ')} | ${row.total} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function markdownMedianMultipleByFirstMcap(rows) {
  const lines = [
    '## Median Multiple By First-Seen Market Cap Band',
    '',
    '| First MC Band | Count | Median Multiple |',
    '| --- | ---: | ---: |',
  ];
  for (const row of rows) {
    lines.push(`| ${row.group} | ${row.count} | ${formatMultiple(row.median)} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function bandNumber(value, bands) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'unknown';
  for (const band of bands) {
    if (number >= band.min && number < band.max) return band.label;
  }
  return bands.at(-1)?.fallback || 'unknown';
}

function featureDistributions(outcomes) {
  const runners3x = outcomes.filter(outcome => Number(outcome.multiple) >= 3);
  const holderBands = [
    { label: '<50', min: 0, max: 50 },
    { label: '50-99', min: 50, max: 100 },
    { label: '100-249', min: 100, max: 250 },
    { label: '250-499', min: 250, max: 500 },
    { label: '500+', min: 500, max: Infinity, fallback: '500+' },
  ];
  const liquidityBands = [
    { label: '<$10k', min: 0, max: 10_000 },
    { label: '$10k-$25k', min: 10_000, max: 25_000 },
    { label: '$25k-$50k', min: 25_000, max: 50_000 },
    { label: '$50k-$100k', min: 50_000, max: 100_000 },
    { label: '$100k+', min: 100_000, max: Infinity, fallback: '$100k+' },
  ];
  const ageBands = [
    { label: '<5m', min: 0, max: 5 * 60_000 },
    { label: '5-15m', min: 5 * 60_000, max: 15 * 60_000 },
    { label: '15-60m', min: 15 * 60_000, max: 60 * 60_000 },
    { label: '1-6h', min: 60 * 60_000, max: 6 * 60 * 60_000 },
    { label: '6h+', min: 6 * 60 * 60_000, max: Infinity, fallback: '6h+' },
  ];

  const countField = field => distribution(runners3x.map(outcome => ({
    value: outcome[field] == null ? 'unknown' : String(outcome[field]),
  })), 'value');
  const booleanField = field => distribution(runners3x.map(outcome => ({
    value: Number(outcome[field]) > 0 ? 'present' : 'absent',
  })), 'value');
  const binnedField = (field, bands) => distribution(runners3x.map(outcome => ({
    value: outcome[field] == null ? 'unknown' : bandNumber(outcome[field], bands),
  })), 'value');

  return {
    total_3x_runners: runners3x.length,
    source_count: countField('first_source_count'),
    holders: binnedField('first_holders', holderBands),
    liquidity: binnedField('first_liquidity_usd', liquidityBands),
    fee_claim: booleanField('first_fee_claim_present'),
    graduated: booleanField('first_graduated_present'),
    trending_source: distribution(runners3x.map(outcome => ({
      value: outcome.first_trending_source || 'unknown',
    })), 'value'),
    age_at_first_sight: binnedField('first_age_ms', ageBands),
  };
}

function markdownFeatureDistributions(features) {
  const lines = [
    '## 3x+ Runner Feature Distributions',
    '',
    `3x+ runner count: ${features.total_3x_runners}`,
    '',
  ];

  for (const [name, rows] of Object.entries(features)) {
    if (name === 'total_3x_runners') continue;
    lines.push(`### ${name.replace(/_/g, ' ')}`, '', '| Value | Count |', '| --- | ---: |');
    for (const [value, count] of Object.entries(rows)) {
      lines.push(`| ${value} | ${count} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function markdownFilterComparison(rows) {
  const lines = [
    '## Filter Comparison',
    '',
    '| Recipe | Guide | Threshold | Precision | Recall | F1 | FP Count | Median Caught TTP |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const row of rows) {
    lines.push([
      row.recipe_name,
      row.guide_source || '',
      `${row.threshold}x`,
      formatPercent(row.precision),
      formatPercent(row.recall),
      formatPercent(row.f1),
      row.fp,
      formatMinutes(row.median_time_to_peak_ms),
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |'));
  }
  lines.push('');
  return lines.join('\n');
}

function formatDecimal(value, decimals = 2) {
  if (!Number.isFinite(Number(value))) return 'n/a';
  return Number(value).toFixed(decimals);
}

function markdownWalletPredictiveness(summary) {
  const coverage = summary.coverage;
  const lines = [
    '## WPA-1 Candidate Wallet Predictiveness',
    '',
    'Candidate wallet evidence is extracted only from `candidates.candidate_json`; `signal_events` and `screening_events` contain saved-wallet counts only and do not contain full wallet addresses.',
    '',
    '### Candidate Wallet Coverage',
    '',
    '| Segment | With Candidate Wallet Evidence | Total | Coverage |',
    '| --- | ---: | ---: | ---: |',
    markdownTableRow(['All outcomes', coverage.outcomes_with_candidate_wallet_evidence, coverage.total_outcomes, formatPercent(coverage.all_outcome_coverage)]),
    markdownTableRow(['2x+ runners', coverage.runners_2x_with_candidate_wallet_evidence, coverage.runners_2x_total, formatPercent(coverage.runners_2x_coverage)]),
    markdownTableRow(['3x+ runners', coverage.runners_3x_with_candidate_wallet_evidence, coverage.runners_3x_total, formatPercent(coverage.runners_3x_coverage)]),
    markdownTableRow(['5x+ runners', coverage.runners_5x_with_candidate_wallet_evidence, coverage.runners_5x_total, formatPercent(coverage.runners_5x_coverage)]),
    '',
    '### Runner Vs Non-Runner Wallet Overlap',
    '',
    '| Threshold | Group | Outcomes | Evidence Rate | Median Wallets | Avg Wallets | Median Tier-A | Smart-Degen Rate |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const row of summary.threshold_comparison) {
    lines.push(markdownTableRow([
      `${row.threshold}x`,
      row.group,
      row.outcomes,
      formatPercent(row.wallet_evidence_rate),
      formatDecimal(row.median_candidate_wallet_address_count, 1),
      formatDecimal(row.avg_candidate_wallet_address_count, 2),
      formatDecimal(row.median_candidate_tier_a_wallet_count, 1),
      formatPercent(row.smart_degen_present_rate),
    ]));
  }

  lines.push(
    '',
    '### Wallet Quality By Runner Label',
    '',
    '| Runner Label | Total | No Wallet Evidence | Tier A | Tier B | Tier C | Universe Only |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  );
  for (const row of summary.quality_by_runner_label) {
    lines.push(markdownTableRow([
      row.runner_label,
      row.total,
      row.no_wallet_evidence,
      row.tier_a,
      row.tier_b,
      row.tier_c,
      row.universe_only,
    ]));
  }

  lines.push('', 'Limitations:', '');
  for (const limitation of summary.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

function markdownWalletRecurrence(recurrence) {
  const lines = [
    '## WPA-2 Wallet Recurrence Index',
    '',
    'This index counts public candidate wallet addresses across distinct mints. Repeated evidence for the same wallet within one mint counts once.',
    '',
    'Limitation: recurrence does not prove the wallet bought before shadow first sighting; it is a prioritization signal only.',
    '',
    '### Recurrence Threshold Summary',
    '',
    '| Min Runner Mints | Wallets | Runner Mint Links | Distinct Runner Mints Covered | Max Runner Mints | Wallets With 3x+ Mint | Wallets With 5x+ Mint |',
    '| ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const row of recurrence.threshold_summaries) {
    lines.push(markdownTableRow([
      row.min_runner_mints,
      row.recurring_wallet_count,
      row.total_runner_mint_links,
      row.distinct_runner_mints_covered,
      row.max_runner_mint_count,
      row.wallets_with_3x_runner_mints,
      row.wallets_with_5x_runner_mints,
    ]));
  }

  lines.push(
    '',
    '### Top Recurring Wallets Among Runners',
    '',
    '| Wallet | Runner Mints | 3x+ Mints | 5x+ Mints | Non-Runner Mints | Max Multiple | Best Tier | Tags |',
    '| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
  );

  const top = recurrence.top_recurring_wallets.slice(0, 15);
  if (!top.length) {
    lines.push(markdownTableRow(['none', 0, 0, 0, 0, 'n/a', 'n/a', '']));
  } else {
    for (const row of top) {
      lines.push(markdownTableRow([
        row.wallet_address,
        row.runner_mint_count,
        row.runner_3x_mint_count,
        row.runner_5x_mint_count,
        row.non_runner_mint_count,
        formatMultiple(row.max_multiple),
        row.best_observed_tier,
        (row.observed_tags || []).slice(0, 5).join(', '),
      ]));
    }
  }

  lines.push('', 'Limitations:', '');
  for (const limitation of recurrence.limitations) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

function markdownHarvesterCoverage(coverage) {
  const lines = [
    '## WPA-3 Harvester Sighting Coverage Probe',
    '',
  ];

  if (coverage.status === 'skipped') {
    lines.push(
      `Status: skipped. ${coverage.reason}`,
      '',
      coverage.interpretation,
      '',
    );
    return lines.join('\n');
  }

  if (coverage.status === 'unsupported_schema') {
    lines.push(
      'Status: unsupported schema.',
      '',
      coverage.reason,
      '',
      coverage.interpretation,
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    `Status: ran against \`${coverage.schema.table}\` using mint column \`${coverage.schema.mint_column}\`${coverage.schema.timestamp_column ? ` and timestamp column \`${coverage.schema.timestamp_column}\`` : ' without a recognized timestamp column'}.`,
    '',
    '| Segment | With Harvester Coverage | Total | Coverage | Before Shadow | Within +/-15m | Within +2h | After Peak |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    markdownTableRow([
      'All outcomes',
      coverage.outcomes_with_harvester_coverage,
      coverage.total_outcomes,
      formatPercent(coverage.coverage_rate),
      coverage.sighted_before_shadow,
      coverage.sighted_within_15m,
      coverage.sighted_within_plus_2h,
      coverage.sighted_after_peak,
    ]),
  );

  for (const row of coverage.coverage_by_threshold) {
    lines.push(markdownTableRow([
      `${row.threshold}x+ runners`,
      row.with_harvester_coverage,
      row.total,
      formatPercent(row.coverage_rate),
      row.sighted_before_shadow,
      row.sighted_within_15m,
      row.sighted_within_plus_2h,
      row.sighted_after_peak,
    ]));
  }

  lines.push(
    '',
    coverage.interpretation,
    '',
    'Cadence-vs-source recommendation: keep the 2h harvester cadence for now; use this measured coverage to decide whether a shadow-triggered harvest path matters before changing cadence.',
    '',
  );
  return lines.join('\n');
}

function markdownHarvesterTradeTiming(timing) {
  const lines = [
    '## WPA-4 Harvester Trade Timing Probe',
    '',
    'This probe joins WPA-1 candidate wallet addresses to already-populated harvester trade/swap history by mint and wallet. It does not backfill Helius data or prove absence of buys when no matching row exists.',
    '',
  ];

  if (timing.status === 'skipped') {
    lines.push(`Status: skipped. ${timing.reason}`, '');
    return lines.join('\n');
  }

  if (timing.status === 'unsupported_schema' || timing.status === 'no_trade_history') {
    lines.push(
      `Status: ${timing.status.replace(/_/g, ' ')}.`,
      '',
      timing.reason,
      '',
    );
    return lines.join('\n');
  }

  lines.push(
    `Status: ran against \`${timing.schema.table}\` using mint column \`${timing.schema.mint_column}\`, wallet column \`${timing.schema.wallet_column}\`, timestamp column \`${timing.schema.timestamp_column}\`${timing.schema.side_column ? `, and side/action column \`${timing.schema.side_column}\`` : ', without a recognized side/action column'}.`,
    '',
    '| Segment | Candidate Pairs | Buy Before Shadow | Buy After Shadow | Unknown-Side Pairs | No Matched Trade | Non-Buy Matched Trade |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    markdownTableRow([
      'All candidate mint-wallet pairs',
      timing.timing.total_pairs,
      timing.timing.bought_before_shadow,
      timing.timing.bought_after_shadow,
      timing.timing.unknown_side_pairs,
      timing.timing.no_matched_trade,
      timing.timing.no_buy_trade,
    ]),
  );

  for (const row of timing.timing_by_threshold) {
    lines.push(markdownTableRow([
      `${row.threshold}x+ runners`,
      row.total_pairs,
      row.bought_before_shadow,
      row.bought_after_shadow,
      row.unknown_side_pairs,
      row.no_matched_trade,
      row.no_buy_trade,
    ]));
  }

  lines.push('', 'Limitations:', '');
  for (const limitation of timing.limitations || []) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

function coverageSummary(outcomes) {
  const firstSeen = outcomes.map(outcome => Number(outcome.first_seen_at_ms)).filter(Number.isFinite);
  const signalCount = outcomes.reduce((sum, outcome) => sum + Number(outcome.signal_count || 0), 0);
  const observedCount = outcomes.filter(outcome => outcome.has_observations).length;
  return {
    total_mints: outcomes.length,
    total_signals: signalCount,
    first_seen_min_ms: firstSeen.length ? Math.min(...firstSeen) : null,
    first_seen_max_ms: firstSeen.length ? Math.max(...firstSeen) : null,
    observed_mints: observedCount,
    observation_coverage: outcomes.length ? observedCount / outcomes.length : null,
  };
}

function observationSummary(outcomes) {
  const observed = outcomes.filter(outcome => outcome.has_observations);
  const densities = observed.map(outcome => Number(outcome.observation_count)).filter(Number.isFinite).sort((a, b) => a - b);
  const gapAt = threshold => outcomes.filter(outcome => Number(outcome.multiple) >= threshold && !outcome.has_observations).length;
  return {
    observed_mints: observed.length,
    coverage_percent: outcomes.length ? observed.length / outcomes.length : null,
    observation_rows: densities.reduce((sum, value) => sum + value, 0),
    density_min: densities.length ? densities[0] : null,
    density_median: densities.length ? densities[Math.floor(densities.length / 2)] : null,
    density_max: densities.length ? densities[densities.length - 1] : null,
    obs_exceeds_signal_max: outcomes.filter(outcome => outcome.obs_exceeds_signal_max).length,
    obs_label_differs: outcomes.filter(outcome => outcome.obs_runner_label_differs).length,
    runner_gaps: {
      '2x': gapAt(2),
      '3x': gapAt(3),
      '5x': gapAt(5),
    },
  };
}

function markdownObservationSummary(summary) {
  return [
    '## Observation Coverage',
    '',
    `- Outcomes with observations: ${summary.observed_mints} (${formatPercent(summary.coverage_percent)})`,
    `- Observation rows across covered mints: ${summary.observation_rows}`,
    `- Observation density per covered mint: min ${summary.density_min ?? 'n/a'}, median ${summary.density_median ?? 'n/a'}, max ${summary.density_max ?? 'n/a'}`,
    `- Mints where observation max exceeds signal max: ${summary.obs_exceeds_signal_max}`,
    `- Mints where observation-implied runner label differs: ${summary.obs_label_differs}`,
    '- Signal-based `runner_label` and `multiple` are preserved; observation fields are secondary evidence only.',
    '',
    '### Runner Coverage Gaps',
    '',
    '| Signal Threshold | Runner mints without observations |',
    '| --- | ---: |',
    `| 2x+ | ${summary.runner_gaps['2x']} |`,
    `| 3x+ | ${summary.runner_gaps['3x']} |`,
    `| 5x+ | ${summary.runner_gaps['5x']} |`,
    '',
    'Per-event forward horizon tables are deferred for now; per-mint forward horizon columns are included in `runner_outcomes.json`.',
    '',
  ].join('\n');
}

function tradabilitySummary(outcomes, { minMultiple }) {
  const runners = outcomes.filter(outcome => Number(outcome.multiple) >= minMultiple);
  const observedRunners = runners.filter(outcome => outcome.has_observations);
  const drawdowns = observedRunners
    .map(outcome => Number(outcome.obs_drawdown_before_peak_percent))
    .filter(Number.isFinite);
  const timeToPeaks = runners
    .map(outcome => Number(outcome.time_to_peak_ms))
    .filter(Number.isFinite);
  return {
    runner_count: runners.length,
    observed_runner_count: observedRunners.length,
    time_to_peak_median_ms: median(timeToPeaks),
    drawdown_count: drawdowns.length,
    drawdown_median: median(drawdowns),
    drawdown_max: drawdowns.length ? Math.max(...drawdowns) : null,
  };
}

function markdownTradabilityNotes(summary, { minMultiple }) {
  const lines = [
    '## Tradability Notes',
    '',
    `- Runner framing threshold: ${minMultiple}x+.`,
    `- Runners in scope: ${summary.runner_count}.`,
    `- Median signal-based time to peak: ${formatMinutes(summary.time_to_peak_median_ms)}.`,
    `- Observation-covered runners with drawdown evidence: ${summary.drawdown_count}.`,
  ];
  if (summary.drawdown_count) {
    lines.push(
      `- Median drawdown before observed peak: ${formatPercent(summary.drawdown_median)}.`,
      `- Worst drawdown before observed peak: ${formatPercent(summary.drawdown_max)}.`,
    );
  } else {
    lines.push('- Drawdown before peak cannot be reliably summarized because no observation-covered runners had usable market-cap observations before peak.');
  }
  lines.push('');
  return lines.join('\n');
}

function recommendationSummary({ outcomes, filterComparison, minMultiple, maxFirstMcap }) {
  const inFrame = outcomes.filter(outcome => Number(outcome.first_mcap_usd) <= maxFirstMcap);
  const bandRows = medianBy(inFrame.filter(outcome => Number(outcome.multiple) >= minMultiple), 'first_mcap_band', 'multiple', {
    groups: FIRST_MCAP_BANDS,
  }).sort((a, b) => b.count - a.count || Number(b.median || 0) - Number(a.median || 0));
  const thresholdRows = filterComparison
    .filter(row => Number(row.threshold) === Number(minMultiple) && row.tp > 0)
    .slice()
    .sort((a, b) => Number(b.f1 || 0) - Number(a.f1 || 0) || Number(b.recall || 0) - Number(a.recall || 0))
    .slice(0, 5);
  return { bandRows: bandRows.slice(0, 5), thresholdRows };
}

function markdownRecommendations(summary, { minMultiple, maxFirstMcap }) {
  const lines = [
    '## Recommendations',
    '',
    `These recommendations are framed for ${minMultiple}x+ runners first seen at or below ${formatUsd(maxFirstMcap)}.`,
    'Wallet-aware filter recipes in this report are offline classifiers only, candidate-coverage limited, and do not change Charon runtime behavior.',
    '',
  ];
  if (!summary.bandRows.length && !summary.thresholdRows.length) {
    lines.push('No data-backed recommendation is available from this run; review the generated report after running against a populated shadow DB.', '');
    return lines.join('\n');
  }
  if (summary.bandRows.length) {
    lines.push('### Market-cap bands worth A/B testing', '', '| First MC Band | Runner Count | Median Multiple |', '| --- | ---: | ---: |');
    for (const row of summary.bandRows) {
      lines.push(markdownTableRow([row.group, row.count, formatMultiple(row.median)]));
    }
    lines.push('');
  }
  if (summary.thresholdRows.length) {
    lines.push('### Filter lanes worth A/B testing', '', '| Recipe | Guide | Precision | Recall | F1 | TP | FP |', '| --- | --- | ---: | ---: | ---: | ---: | ---: |');
    for (const row of summary.thresholdRows) {
      lines.push(markdownTableRow([
        row.recipe_name,
        row.guide_source || '',
        formatPercent(row.precision),
        formatPercent(row.recall),
        formatPercent(row.f1),
        row.tp,
        row.fp,
      ]));
    }
    lines.push('');
  }
  return lines.join('\n');
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildSummary({ dbPath, outDir, outcomes, warnings, minMultiple, maxFirstMcap, harvesterCoverage, harvesterTradeTiming }) {
  const counts = outcomeCounts(outcomes);
  const coverage = coverageSummary(outcomes);
  const firstMcapBands = distribution(outcomes, 'first_mcap_band');
  const peakMcapBands = distribution(outcomes, 'peak_mcap_band');
  const timeToPeakBands = distribution(outcomes, 'time_to_peak_band');
  const firstMcapByLabel = crossTab(outcomes, 'first_mcap_band', 'runner_label', {
    rows: FIRST_MCAP_BANDS,
    columns: RUNNER_LABELS,
  }).map(row => ({ band: row.first_mcap_band, ...row }));
  const peakMcapByLabel = crossTab(outcomes, 'peak_mcap_band', 'runner_label', {
    rows: PEAK_MCAP_BANDS,
    columns: RUNNER_LABELS,
  }).map(row => ({ band: row.peak_mcap_band, ...row }));
  const timeToPeakByLabel = crossTab(outcomes, 'time_to_peak_band', 'runner_label', {
    rows: TIME_TO_PEAK_BANDS,
    columns: RUNNER_LABELS,
  }).map(row => ({ band: row.time_to_peak_band, ...row }));
  const medianMultipleByFirstMcap = medianBy(outcomes, 'first_mcap_band', 'multiple', {
    groups: FIRST_MCAP_BANDS,
  });
  const features3x = featureDistributions(outcomes);
  const filterThresholds = [...new Set([2, 3, 5, minMultiple].map(Number))].sort((a, b) => a - b);
  const walletRecurrence = buildWalletRecurrenceIndex(outcomes);
  attachWalletRecurrenceFeatures(outcomes, walletRecurrence);
  const filterComparison = evaluateBuiltInRecipes(outcomes, { thresholds: filterThresholds });
  const missed = topMissedRunners(
    outcomes.filter(outcome => Number(outcome.first_mcap_usd) <= maxFirstMcap),
    { limit: 10, threshold: minMultiple },
  );
  const observations = observationSummary(outcomes);
  const tradability = tradabilitySummary(outcomes, { minMultiple });
  const recommendations = recommendationSummary({ outcomes, filterComparison, minMultiple, maxFirstMcap });
  const walletPredictiveness = summarizeWalletPredictiveness(outcomes);

  const lines = [
    '# Shadow Runner Analysis',
    '',
    `DB: \`${dbPath}\``,
    `Output: \`${path.relative(repoRoot, outDir)}\``,
    '',
    '## Coverage',
    '',
    `- Date range: ${formatDateTime(coverage.first_seen_min_ms)} to ${formatDateTime(coverage.first_seen_max_ms)}`,
    `- Total mints: ${counts.total_mints}`,
    `- Total signals: ${coverage.total_signals}`,
    `- Observation coverage: ${coverage.observed_mints} mints (${formatPercent(coverage.observation_coverage)})`,
    `- 2x+: ${counts.runners_2x}`,
    `- 3x+: ${counts.runners_3x}`,
    `- 5x+: ${counts.runners_5x}`,
    `- 10x+: ${counts.runners_10x}`,
    '',
  ];

  if (warnings.length) {
    lines.push('## Caveats', '');
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push(
    '## Movement Distribution',
    '',
    markdownCrossTab('Runner Label By First-Seen Market Cap Band', firstMcapByLabel, 'band', RUNNER_LABELS),
    markdownCrossTab('Runner Label By Peak Market Cap Band', peakMcapByLabel, 'band', RUNNER_LABELS),
    markdownCrossTab('Runner Label By Time-To-Peak Band', timeToPeakByLabel, 'band', RUNNER_LABELS),
    markdownMedianMultipleByFirstMcap(medianMultipleByFirstMcap),
    '## Feature Profiles',
    '',
    markdownFeatureDistributions(features3x),
    markdownWalletPredictiveness(walletPredictiveness),
    markdownWalletRecurrence(walletRecurrence),
    markdownHarvesterCoverage(harvesterCoverage),
    markdownHarvesterTradeTiming(harvesterTradeTiming),
    markdownObservationSummary(observations),
    markdownTradabilityNotes(tradability, { minMultiple }),
    markdownFilterComparison(filterComparison),
    markdownDistribution('First-Seen Market Cap Bands', firstMcapBands),
    markdownDistribution('Peak Market Cap Bands', peakMcapBands),
    markdownDistribution('Time To Peak Bands', timeToPeakBands),
    '## Top Missed Runners',
    '',
    '| Mint | Symbol | Multiple | First MC | Peak MC | TTP | Candidate | Blockers |',
    '| --- | --- | ---: | ---: | ---: | ---: | --- | --- |',
  );

  for (const row of missed) {
    lines.push(markdownTableRow([
      row.mint,
      row.symbol || '',
      formatMultiple(row.multiple),
      formatUsd(row.first_mcap_usd),
      formatUsd(row.max_mcap_usd),
      formatMinutes(row.time_to_peak_ms),
      row.candidate_status || 'none',
      (row.blocker_reasons || []).join(', ') || 'none',
    ]));
  }
  lines.push('');
  lines.push(markdownRecommendations(recommendations, { minMultiple, maxFirstMcap }));

  return {
    markdown: lines.join('\n'),
    counts,
    firstMcapBands,
    peakMcapBands,
    timeToPeakBands,
    firstMcapByLabel,
    peakMcapByLabel,
    timeToPeakByLabel,
    medianMultipleByFirstMcap,
    features3x,
    filterComparison,
    observations,
    tradability,
    missed,
    recommendations,
    walletPredictiveness,
    walletRecurrence,
    harvesterCoverage,
    harvesterTradeTiming,
  };
}

function printStdout({ report }) {
  const { counts, firstMcapBands, peakMcapBands, timeToPeakBands, missed } = report;
  console.log('Shadow runner analysis complete');
  console.log(`total_mints=${counts.total_mints}`);
  console.log(`2x+=${counts.runners_2x} 3x+=${counts.runners_3x} 5x+=${counts.runners_5x} 10x+=${counts.runners_10x}`);
  console.log(`first_seen_mcap_bands=${JSON.stringify(firstMcapBands)}`);
  console.log(`peak_mcap_bands=${JSON.stringify(peakMcapBands)}`);
  console.log(`time_to_peak_bands=${JSON.stringify(timeToPeakBands)}`);
  console.log('top_missed_runners=' + missed.slice(0, 5).map(row => {
    const blockers = (row.blocker_reasons || []).join(',') || 'none';
    return `${row.mint}:${formatMultiple(row.multiple)}:${blockers}`;
  }).join(' | '));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dbPath = assertDbPath(opts.db);
  const harvesterDbPath = opts.harvesterDb ? assertReadableHarvesterDbPath(opts.harvesterDb) : null;
  const outDir = opts.outputDir
    ? path.resolve(repoRoot, opts.outputDir)
    : path.join(path.resolve(repoRoot, opts.out || 'reports/shadow-runner-analysis'), timestampSlug());

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const harvesterDb = harvesterDbPath ? new Database(harvesterDbPath, { readonly: true, fileMustExist: true }) : null;
  try {
    const { outcomes, warnings } = materializeOutcomes(db, { skipObservations: Boolean(opts.skipObservations) });
    const harvesterCoverage = harvesterDb
      ? analyzeHarvesterCoverage(outcomes, harvesterDb)
      : skippedHarvesterCoverage('no --harvester-db path provided');
    const harvesterTradeTiming = harvesterDb
      ? analyzeHarvesterTradeTiming(outcomes, harvesterDb)
      : skippedHarvesterTradeTiming('no --harvester-db path provided');
    const report = buildSummary({
      dbPath,
      outDir,
      outcomes,
      warnings,
      minMultiple: opts.minMultiple,
      maxFirstMcap: opts.maxFirstMcap,
      harvesterCoverage,
      harvesterTradeTiming,
    });

    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'runner_outcomes.json'), `${JSON.stringify(outcomes, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'runner_outcomes.csv'), toCsv(outcomes));
    fs.writeFileSync(path.join(outDir, 'filter_comparison.json'), `${JSON.stringify(report.filterComparison, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'filter_comparison.csv'), toCsv(report.filterComparison, [
      'recipe_name',
      'guide_source',
      'threshold',
      'tp',
      'fp',
      'fn',
      'tn',
      'precision',
      'recall',
      'f1',
      'false_positive_rate',
      'median_time_to_peak_ms',
    ]));
    fs.writeFileSync(path.join(outDir, 'wallet_predictiveness.json'), `${JSON.stringify(report.walletPredictiveness, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'wallet_predictiveness.csv'), toCsv(report.walletPredictiveness.threshold_comparison));
    fs.writeFileSync(path.join(outDir, 'wallet_recurrence.json'), `${JSON.stringify(report.walletRecurrence, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, 'wallet_recurrence.csv'), toCsv(report.walletRecurrence.wallet_rows, [
      'wallet_address',
      'distinct_mint_count',
      'runner_mint_count',
      'runner_2x_mint_count',
      'runner_3x_mint_count',
      'runner_5x_mint_count',
      'non_runner_mint_count',
      'max_multiple',
      'best_observed_tier',
      'observed_tiers',
      'observed_tags',
      'smart_degen_mint_count',
    ]));
    fs.writeFileSync(path.join(outDir, 'harvester_coverage.json'), `${JSON.stringify(report.harvesterCoverage, null, 2)}\n`);
    if (report.harvesterCoverage.status === 'ok') {
      fs.writeFileSync(path.join(outDir, 'harvester_coverage.csv'), toCsv(report.harvesterCoverage.outcome_rows, [
        'mint',
        'symbol',
        'multiple',
        'runner_label',
        'first_seen_at_ms',
        'peak_at_ms',
        'harvester_sighting_count',
        'earliest_sighting_at_ms',
        'sighted_before_shadow',
        'sighted_within_15m',
        'sighted_within_plus_2h',
        'sighted_after_peak',
        'harvester_sources',
      ]));
    }
    fs.writeFileSync(path.join(outDir, 'harvester_trade_timing.json'), `${JSON.stringify(report.harvesterTradeTiming, null, 2)}\n`);
    if (report.harvesterTradeTiming.status === 'ok' && report.harvesterTradeTiming.pair_rows.length) {
      fs.writeFileSync(path.join(outDir, 'harvester_trade_timing.csv'), toCsv(report.harvesterTradeTiming.pair_rows, [
        'mint',
        'wallet_address',
        'symbol',
        'multiple',
        'runner_label',
        'first_seen_at_ms',
        'timing_bucket',
        'matched_trade_count',
        'buy_trade_count',
        'unknown_side_trade_count',
        'first_trade_at_ms',
        'first_buy_at_ms',
        'first_unknown_side_trade_at_ms',
        'first_trade_side',
        'first_trade_side_raw',
      ]));
    }
    fs.writeFileSync(path.join(outDir, 'summary.md'), report.markdown);

    for (const warning of warnings) console.warn(`warning: ${warning}`);
    printStdout({ report });
    console.log(`report_dir=${outDir}`);
  } finally {
    if (harvesterDb) harvesterDb.close();
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
