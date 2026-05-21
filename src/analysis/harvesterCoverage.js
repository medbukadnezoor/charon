const RUNNER_THRESHOLDS = [2, 3, 5];
const TIMING_WINDOW_MS = 15 * 60_000;
const PLUS_TWO_HOURS_MS = 2 * 60 * 60_000;

const TABLE_CANDIDATES = [
  'sightings',
  'token_sightings',
  'harvester_sightings',
  'wallet_sightings',
  'tokens_seen',
  'seen_tokens',
  'tokens',
];

const MINT_COLUMNS = [
  'mint',
  'token_mint',
  'base_mint',
  'mint_address',
  'token_address',
  'contract_address',
  'ca',
  'address',
];

const TIMESTAMP_COLUMNS = [
  'sighted_at_ms',
  'seen_at_ms',
  'observed_at_ms',
  'first_seen_at_ms',
  'created_at_ms',
  'updated_at_ms',
  'timestamp_ms',
  'at_ms',
  'sighted_at',
  'seen_at',
  'observed_at',
  'first_seen_at',
  'created_at',
  'updated_at',
  'timestamp',
];

const SOURCE_COLUMNS = [
  'source',
  'provider',
  'surface',
  'origin',
  'kind',
  'source_name',
];

function percent(part, total) {
  return total ? part / total : null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeMint(value) {
  return String(value || '').trim();
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function firstMatchingColumn(columns, candidates) {
  const exact = new Map(columns.map(column => [String(column).toLowerCase(), column]));
  for (const candidate of candidates) {
    const match = exact.get(candidate.toLowerCase());
    if (match) return match;
  }
  return null;
}

function listTables(db) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map(row => row.name);
}

function scoreTable(tableName, columns) {
  const mintColumn = firstMatchingColumn(columns, MINT_COLUMNS);
  if (!mintColumn) return null;
  const timestampColumn = firstMatchingColumn(columns, TIMESTAMP_COLUMNS);
  const sourceColumn = firstMatchingColumn(columns, SOURCE_COLUMNS);
  const normalizedName = String(tableName).toLowerCase();
  let score = 1;
  if (normalizedName === 'sightings') score += 100;
  else if (normalizedName.includes('sighting')) score += 50;
  else if (TABLE_CANDIDATES.includes(normalizedName)) score += 20;
  if (timestampColumn) score += 5;
  if (sourceColumn) score += 1;
  return {
    table: tableName,
    mint_column: mintColumn,
    timestamp_column: timestampColumn,
    source_column: sourceColumn,
    score,
  };
}

export function detectHarvesterSightingSchema(db) {
  const candidates = [];
  for (const table of listTables(db)) {
    const columns = tableColumns(db, table);
    const candidate = scoreTable(table, columns);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => b.score - a.score || String(a.table).localeCompare(String(b.table)));
  return candidates[0] || null;
}

function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const numeric = finiteNumber(value);
  if (numeric != null) {
    if (numeric > 1_000_000_000_000) return Math.trunc(numeric);
    if (numeric > 1_000_000_000) return Math.trunc(numeric * 1000);
    return Math.trunc(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function compactSources(rows) {
  return [...new Set(rows.map(row => String(row.source || '').trim()).filter(Boolean))].sort();
}

function timingFlags(outcome, sightings) {
  const firstSeen = finiteNumber(outcome.first_seen_at_ms);
  const peakAt = finiteNumber(outcome.obs_max_mcap_at_ms) ?? finiteNumber(outcome.max_mcap_at_ms);
  const timestamped = sightings
    .map(row => row.sighted_at_ms)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  if (!Number.isFinite(firstSeen) || !timestamped.length) {
    return {
      earliest_sighting_at_ms: timestamped[0] ?? null,
      sighted_before_shadow: 0,
      sighted_within_15m: 0,
      sighted_within_plus_2h: 0,
      sighted_after_peak: 0,
      after_peak_computable: Number.isFinite(peakAt) ? 1 : 0,
    };
  }

  return {
    earliest_sighting_at_ms: timestamped[0],
    sighted_before_shadow: timestamped.some(value => value < firstSeen) ? 1 : 0,
    sighted_within_15m: timestamped.some(value => Math.abs(value - firstSeen) <= TIMING_WINDOW_MS) ? 1 : 0,
    sighted_within_plus_2h: timestamped.some(value => value >= firstSeen && value <= firstSeen + PLUS_TWO_HOURS_MS) ? 1 : 0,
    sighted_after_peak: Number.isFinite(peakAt) && timestamped.some(value => value > peakAt) ? 1 : 0,
    after_peak_computable: Number.isFinite(peakAt) ? 1 : 0,
  };
}

function fetchSightingsByMint(db, schema, mints) {
  const byMint = new Map(mints.map(mint => [mint, []]));
  if (!mints.length) return byMint;

  const table = quoteIdentifier(schema.table);
  const mintColumn = quoteIdentifier(schema.mint_column);
  const timestampExpr = schema.timestamp_column ? quoteIdentifier(schema.timestamp_column) : 'NULL';
  const sourceExpr = schema.source_column ? quoteIdentifier(schema.source_column) : 'NULL';

  for (let offset = 0; offset < mints.length; offset += 500) {
    const batch = mints.slice(offset, offset + 500);
    const placeholders = batch.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT ${mintColumn} AS mint, ${timestampExpr} AS sighted_at_raw, ${sourceExpr} AS source
      FROM ${table}
      WHERE ${mintColumn} IN (${placeholders})
    `).all(...batch);

    for (const row of rows) {
      const mint = normalizeMint(row.mint);
      if (!byMint.has(mint)) continue;
      byMint.get(mint).push({
        mint,
        sighted_at_ms: parseTimestampMs(row.sighted_at_raw),
        source: row.source == null ? null : String(row.source),
      });
    }
  }

  return byMint;
}

function coverageByThreshold(outcomeRows, threshold) {
  const rows = outcomeRows.filter(row => Number(row.multiple || 0) >= threshold);
  const covered = rows.filter(row => row.harvester_sighting_count > 0);
  return {
    threshold,
    total: rows.length,
    with_harvester_coverage: covered.length,
    coverage_rate: percent(covered.length, rows.length),
    sighted_before_shadow: covered.filter(row => row.sighted_before_shadow).length,
    sighted_within_15m: covered.filter(row => row.sighted_within_15m).length,
    sighted_within_plus_2h: covered.filter(row => row.sighted_within_plus_2h).length,
    sighted_after_peak: covered.filter(row => row.sighted_after_peak).length,
    after_peak_computable: covered.filter(row => row.after_peak_computable).length,
  };
}

function interpretationFor(summary) {
  if (summary.status === 'skipped') {
    return 'Harvester coverage probe skipped because no --harvester-db path was provided. Keep the 2h harvester cadence for now; this run cannot judge source overlap.';
  }
  if (summary.status === 'unsupported_schema') {
    return 'Harvester coverage probe could not identify a conservative mint-bearing sightings table. Keep the 2h cadence for now and inspect the harvester schema before using this data for cadence decisions.';
  }

  const runners2x = summary.coverage_by_threshold.find(row => row.threshold === 2);
  const overlap = runners2x?.coverage_rate;
  if (!Number.isFinite(overlap)) {
    return 'No 2x+ runner denominator was available. Keep the 2h cadence for now; this run has no statistical power for cadence-vs-source decisions.';
  }
  if (overlap < 0.10) {
    return 'Less than 10% of 2x+ runners overlap harvester sightings, so source bridging likely matters more than cadence changes. Keep the 2h cadence for now and prioritize a shadow-triggered harvest path if this pattern holds.';
  }
  if (overlap >= 0.40) {
    return 'At least 40% of 2x+ runners overlap harvester sightings, which weakens the token-source mismatch concern and makes cadence/timing analysis more useful. Keep the 2h cadence for now until timing buckets justify a change.';
  }
  return 'Harvester overlap is present but not dominant. Keep the 2h cadence for now and use the measured before/near/after timing buckets to decide whether a shadow-triggered harvest path is worth building.';
}

export function skippedHarvesterCoverage(reason = 'no --harvester-db path provided') {
  const summary = {
    status: 'skipped',
    reason,
    total_outcomes: 0,
    total_runners_2x: 0,
    total_runners_3x: 0,
    total_runners_5x: 0,
    outcomes_with_harvester_coverage: 0,
    coverage_by_threshold: RUNNER_THRESHOLDS.map(threshold => ({
      threshold,
      total: 0,
      with_harvester_coverage: 0,
      coverage_rate: null,
      sighted_before_shadow: 0,
      sighted_within_15m: 0,
      sighted_within_plus_2h: 0,
      sighted_after_peak: 0,
      after_peak_computable: 0,
    })),
    outcome_rows: [],
  };
  return { ...summary, interpretation: interpretationFor(summary) };
}

export function analyzeHarvesterCoverage(outcomes, db) {
  const schema = detectHarvesterSightingSchema(db);
  if (!schema) {
    const summary = {
      status: 'unsupported_schema',
      reason: 'No supported harvester sightings table with a recognizable mint column was found.',
      total_outcomes: outcomes.length,
      total_runners_2x: outcomes.filter(outcome => Number(outcome.multiple || 0) >= 2).length,
      total_runners_3x: outcomes.filter(outcome => Number(outcome.multiple || 0) >= 3).length,
      total_runners_5x: outcomes.filter(outcome => Number(outcome.multiple || 0) >= 5).length,
      outcomes_with_harvester_coverage: 0,
      coverage_rate: percent(0, outcomes.length),
      coverage_by_threshold: RUNNER_THRESHOLDS.map(threshold => ({
        threshold,
        total: outcomes.filter(outcome => Number(outcome.multiple || 0) >= threshold).length,
        with_harvester_coverage: 0,
        coverage_rate: percent(0, outcomes.filter(outcome => Number(outcome.multiple || 0) >= threshold).length),
        sighted_before_shadow: 0,
        sighted_within_15m: 0,
        sighted_within_plus_2h: 0,
        sighted_after_peak: 0,
        after_peak_computable: 0,
      })),
      outcome_rows: [],
    };
    return { ...summary, interpretation: interpretationFor(summary) };
  }

  const mints = [...new Set(outcomes.map(outcome => normalizeMint(outcome.mint)).filter(Boolean))];
  const sightingsByMint = fetchSightingsByMint(db, schema, mints);
  const outcomeRows = outcomes.map(outcome => {
    const mint = normalizeMint(outcome.mint);
    const sightings = sightingsByMint.get(mint) || [];
    const flags = timingFlags(outcome, sightings);
    return {
      mint,
      symbol: outcome.symbol || null,
      multiple: finiteNumber(outcome.multiple),
      runner_label: outcome.runner_label || null,
      first_seen_at_ms: finiteNumber(outcome.first_seen_at_ms),
      peak_at_ms: finiteNumber(outcome.obs_max_mcap_at_ms) ?? finiteNumber(outcome.max_mcap_at_ms),
      harvester_sighting_count: sightings.length,
      harvester_sources: compactSources(sightings),
      ...flags,
    };
  });
  const covered = outcomeRows.filter(row => row.harvester_sighting_count > 0);
  const summary = {
    status: 'ok',
    schema,
    total_outcomes: outcomes.length,
    total_runners_2x: outcomes.filter(outcome => Number(outcome.multiple || 0) >= 2).length,
    total_runners_3x: outcomes.filter(outcome => Number(outcome.multiple || 0) >= 3).length,
    total_runners_5x: outcomes.filter(outcome => Number(outcome.multiple || 0) >= 5).length,
    outcomes_with_harvester_coverage: covered.length,
    coverage_rate: percent(covered.length, outcomes.length),
    sighted_before_shadow: covered.filter(row => row.sighted_before_shadow).length,
    sighted_within_15m: covered.filter(row => row.sighted_within_15m).length,
    sighted_within_plus_2h: covered.filter(row => row.sighted_within_plus_2h).length,
    sighted_after_peak: covered.filter(row => row.sighted_after_peak).length,
    after_peak_computable: covered.filter(row => row.after_peak_computable).length,
    coverage_by_threshold: RUNNER_THRESHOLDS.map(threshold => coverageByThreshold(outcomeRows, threshold)),
    outcome_rows: outcomeRows,
  };
  return { ...summary, interpretation: interpretationFor(summary) };
}
