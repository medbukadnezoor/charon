import {
  extractCandidateWalletFeatures,
  walletFeatureDefaults,
} from './walletPredictiveness.js';
import { CABAL_BURST_DEFAULTS, computeCabalBursts } from './cabalBursts.js';
import { GAKE_EXIT_DEFAULTS, computeGakeExitFlags } from './gakeExitFlags.js';
import { OHLCV_SIGNAL_DEFAULTS, computeOhlcvSignals } from './ohlcvSignals.js';

const SCREENING_WINDOW_MS = 15 * 60 * 1000;

const STATUS_RANK = new Map([
  ['new', 0],
  ['filtered', 1],
  ['candidate', 2],
  ['watch', 3],
  ['pass', 4],
  ['buy', 5],
]);

const BLOCKER_ACTION_RE = /block|reject|filter|skip/i;
const BLOCKER_STAGE_RE = /block|reject|filter/i;
export const RUNNER_LABELS = ['sub-2x', '2x-3x', '3x-5x', '5x-10x', '10x+', 'unknown'];
export const FIRST_MCAP_BANDS = ['<$5k', '$5k-$10k', '$10k-$25k', '$25k-$50k', '$50k-$100k', '$100k-$250k', '$250k-$500k', '$500k+', 'unknown'];
export const PEAK_MCAP_BANDS = ['<$50k', '$50k-$100k', '$100k-$250k', '$250k-$500k', '$500k-$1M', '$1M+', 'unknown'];
export const TIME_TO_PEAK_BANDS = ['<5m', '5-15m', '15-60m', '1-6h', '6h+', 'unknown'];
export const OBSERVATION_HORIZONS = [
  ['5m', 5 * 60_000],
  ['15m', 15 * 60_000],
  ['30m', 30 * 60_000],
  ['60m', 60 * 60_000],
  ['2h', 2 * 60 * 60_000],
  ['6h', 6 * 60 * 60_000],
  ['24h', 24 * 60 * 60_000],
];

function safeJson(raw, fallback = null) {
  if (raw == null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value) {
  const parsed = finiteNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null && value !== '');
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value.filter(item => item != null && item !== '').map(String);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function uniq(values) {
  return [...new Set(values.filter(value => value != null && value !== '').map(String))];
}

function bool(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function tableColumns(db, tableName) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${tableName})`).all().map(row => row.name));
  } catch {
    return new Set();
  }
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function selectListForColumns(columns, fields) {
  return fields.map(field => (columns.has(field) ? field : `NULL AS ${field}`)).join(', ');
}

function requireColumns(columns, tableName, required) {
  const missing = required.filter(column => !columns.has(column));
  if (missing.length) {
    throw new Error(`${tableName} missing required column(s): ${missing.join(', ')}`);
  }
}

export function validateAnalysisSchema(db) {
  const warnings = [];
  if (!tableExists(db, 'signal_events')) {
    throw new Error('signal_events table is required for shadow runner analysis');
  }
  requireColumns(tableColumns(db, 'signal_events'), 'signal_events', [
    'mint',
    'kind',
    'at_ms',
    'source',
    'payload_json',
  ]);

  const hasScreeningEvents = tableExists(db, 'screening_events');
  if (hasScreeningEvents) {
    requireColumns(tableColumns(db, 'screening_events'), 'screening_events', [
      'mint',
      'at_ms',
      'stage',
      'action',
      'reason_code',
    ]);
  } else {
    warnings.push('screening_events table missing; blocker attribution is degraded to candidates.filter_result_json only.');
  }

  const hasCandidates = tableExists(db, 'candidates');
  if (hasCandidates) {
    requireColumns(tableColumns(db, 'candidates'), 'candidates', [
      'mint',
      'status',
      'created_at_ms',
      'updated_at_ms',
      'candidate_json',
      'filter_result_json',
    ]);
  } else {
    warnings.push('candidates table missing; candidate status and fallback blockers are unavailable.');
  }

  const hasDryRunPositions = tableExists(db, 'dry_run_positions');
  if (hasDryRunPositions) {
    requireColumns(tableColumns(db, 'dry_run_positions'), 'dry_run_positions', [
      'mint',
      'status',
      'pnl_percent',
      'exit_reason',
    ]);
  } else {
    warnings.push('dry_run_positions table missing; dry-run entry attribution is unavailable.');
  }

  const hasTokenObservations = tableExists(db, 'token_observations');
  if (hasTokenObservations) {
    requireColumns(tableColumns(db, 'token_observations'), 'token_observations', [
      'mint',
      'observed_at_ms',
      'market_cap_usd',
    ]);
  }

  return { hasScreeningEvents, hasCandidates, hasDryRunPositions, hasTokenObservations, warnings };
}

export function assignMcapBand(mcap) {
  const value = finiteNumber(mcap);
  if (value == null) return 'unknown';
  if (value < 5_000) return '<$5k';
  if (value < 10_000) return '$5k-$10k';
  if (value < 25_000) return '$10k-$25k';
  if (value < 50_000) return '$25k-$50k';
  if (value < 100_000) return '$50k-$100k';
  if (value < 250_000) return '$100k-$250k';
  if (value < 500_000) return '$250k-$500k';
  return '$500k+';
}

export function assignPeakBand(mcap) {
  const value = finiteNumber(mcap);
  if (value == null) return 'unknown';
  if (value < 50_000) return '<$50k';
  if (value < 100_000) return '$50k-$100k';
  if (value < 250_000) return '$100k-$250k';
  if (value < 500_000) return '$250k-$500k';
  if (value < 1_000_000) return '$500k-$1M';
  return '$1M+';
}

export function assignTimeBand(ms) {
  const value = finiteNumber(ms);
  if (value == null || value < 0) return 'unknown';
  if (value < 5 * 60_000) return '<5m';
  if (value < 15 * 60_000) return '5-15m';
  if (value < 60 * 60_000) return '15-60m';
  if (value < 6 * 60 * 60_000) return '1-6h';
  return '6h+';
}

export function assignRunnerLabel(multiple) {
  const value = finiteNumber(multiple);
  if (value == null) return 'unknown';
  if (value >= 10) return '10x+';
  if (value >= 5) return '5x-10x';
  if (value >= 3) return '3x-5x';
  if (value >= 2) return '2x-3x';
  return 'sub-2x';
}

function marketCapFromPayload(payload) {
  return finiteNumber(firstDefined(
    payload?.marketCapUsd,
    payload?.market_cap_usd,
    payload?.marketCap,
    payload?.market_cap,
    payload?.mcapUsd,
    payload?.mcap_usd,
    payload?.mcap,
    payload?.fdv,
    payload?.usd_market_cap,
    payload?.metrics?.marketCapUsd,
    payload?.metrics?.market_cap_usd,
    payload?.token?.marketCapUsd,
    payload?.token?.market_cap_usd,
    payload?.token?.marketCap,
    payload?.token?.mcap,
  ));
}

function priceFromPayload(payload) {
  return finiteNumber(firstDefined(
    payload?.priceUsd,
    payload?.price_usd,
    payload?.price,
    payload?.usdPrice,
    payload?.metrics?.priceUsd,
    payload?.token?.priceUsd,
    payload?.token?.price,
  ));
}

function sourcesFromPayload(payload, row) {
  const sources = [
    ...arrayFrom(payload?.sources),
    ...arrayFrom(payload?.signals?.sources),
    ...arrayFrom(payload?.source ? String(payload.source) : null),
    ...arrayFrom(row.source),
  ];
  return uniq(sources);
}

function extractSignalFeatures(row, payload) {
  const sources = sourcesFromPayload(payload, row);
  const feeClaim = firstDefined(payload?.feeClaim, payload?.fee_claim, payload?.signals?.feeClaim);
  const graduated = firstDefined(payload?.graduated, payload?.graduation, payload?.graduatedCoin, payload?.signals?.graduated);
  const trending = firstDefined(payload?.trending, payload?.signals?.trending);
  return {
    symbol: firstDefined(payload?.symbol, payload?.token?.symbol, payload?.baseToken?.symbol, null),
    first_price_usd: priceFromPayload(payload),
    first_age_ms: finiteInteger(firstDefined(payload?.ageMs, payload?.age_ms, payload?.age, payload?.signals?.ageMs)),
    first_source_count: finiteInteger(firstDefined(payload?.sourceCount, payload?.source_count, payload?.signals?.sourceCount, sources.length || null)),
    first_sources: sources,
    first_holders: finiteInteger(firstDefined(payload?.holderCount, payload?.holder_count, payload?.holders, payload?.holders?.count, payload?.metrics?.holderCount)),
    first_liquidity_usd: finiteNumber(firstDefined(payload?.liquidityUsd, payload?.liquidity_usd, payload?.liquidity, payload?.liquidity?.usd, payload?.metrics?.liquidityUsd)),
    first_volume_5m_usd: finiteNumber(firstDefined(payload?.volume5mUsd, payload?.volume_5m_usd, payload?.volume5m, payload?.volume?.m5, payload?.metrics?.volume5mUsd)),
    first_volume_24h_usd: finiteNumber(firstDefined(payload?.volume24hUsd, payload?.volume_24h_usd, payload?.volume24h, payload?.volume?.h24, payload?.metrics?.volume24hUsd)),
    first_fee_claim_present: row.kind === 'fee_claim' || bool(payload?.hasFeeClaim) || Boolean(feeClaim) ? 1 : 0,
    first_fee_claim_sol: finiteNumber(firstDefined(payload?.feeClaimSol, payload?.fee_claim_sol, feeClaim?.distributedSol, feeClaim?.distributed_sol)),
    first_graduated_present: row.kind === 'graduated' || bool(payload?.hasGraduated) || Boolean(graduated) ? 1 : 0,
    first_trending_source: firstDefined(payload?.trendingSource, payload?.trending_source, trending?.source, payload?.provider, payload?.source, row.source, null),
  };
}

function extractCandidateFeatures(candidate) {
  const walletFeatures = extractCandidateWalletFeatures(candidate);
  return {
    first_saved_wallet_hits: finiteInteger(firstDefined(candidate?.savedWalletExposure?.holderCount, candidate?.saved_wallet_holders)),
    first_chart_high_dist: finiteNumber(firstDefined(candidate?.chart?.distanceFromAthPercent, candidate?.chart?.distance_from_ath_percent)),
    ...walletFeatures,
  };
}

function candidateBlockersFromFilter(raw) {
  const filter = safeJson(raw, {});
  return uniq([
    ...arrayFrom(filter?.failureCodes),
    ...arrayFrom(filter?.failure_codes),
    ...arrayFrom(filter?.blockedReasons),
    filter?.primaryFailureCode,
    filter?.primary_failure_code,
    filter?.reason_code,
  ]);
}

function bestCandidateStatus(rows) {
  return rows.reduce((best, row) => {
    const rank = STATUS_RANK.get(String(row.status || '')) ?? -1;
    const bestRank = STATUS_RANK.get(String(best?.status || '')) ?? -1;
    if (!best || rank > bestRank || (rank === bestRank && Number(row.updated_at_ms || 0) > Number(best.updated_at_ms || 0))) {
      return row;
    }
    return best;
  }, null);
}

export function materializeSignalOutcomes(db) {
  const rows = db.prepare(`
    SELECT id, mint, kind, at_ms, source, payload_json
    FROM signal_events
    ORDER BY mint, at_ms, id
  `).all();

  const byMint = new Map();
  for (const row of rows) {
    const payload = safeJson(row.payload_json, {});
    const mcap = marketCapFromPayload(payload);
    if (!row.mint || mcap == null || mcap <= 0) continue;

    let grouped = byMint.get(row.mint);
    if (!grouped) {
      grouped = {
        mint: row.mint,
        events: [],
      };
      byMint.set(row.mint, grouped);
    }
    grouped.events.push({ ...row, payload, mcap });
  }

  return [...byMint.values()].map(grouped => {
    const events = grouped.events.sort((a, b) => (a.at_ms - b.at_ms) || (a.id - b.id));
    const first = events[0];
    const peak = events.reduce((best, event) => {
      if (event.mcap > best.mcap) return event;
      if (event.mcap === best.mcap && event.at_ms < best.at_ms) return event;
      return best;
    }, first);
    const multiple = peak.mcap / first.mcap;
    const timeToPeak = peak.at_ms - first.at_ms;
    const features = extractSignalFeatures(first, first.payload);
    const walletDefaults = walletFeatureDefaults();

    return {
      mint: grouped.mint,
      symbol: features.symbol,
      first_seen_at_ms: finiteInteger(first.at_ms),
      first_seen_kind: first.kind,
      first_mcap_usd: first.mcap,
      first_price_usd: features.first_price_usd,
      first_age_ms: features.first_age_ms,
      first_source_count: features.first_source_count,
      first_sources: features.first_sources,
      first_holders: features.first_holders,
      first_liquidity_usd: features.first_liquidity_usd,
      first_volume_5m_usd: features.first_volume_5m_usd,
      first_volume_24h_usd: features.first_volume_24h_usd,
      first_fee_claim_present: features.first_fee_claim_present,
      first_fee_claim_sol: features.first_fee_claim_sol,
      first_graduated_present: features.first_graduated_present,
      first_trending_source: features.first_trending_source,
      first_saved_wallet_hits: null,
      first_chart_high_dist: null,
      ...walletDefaults,
      ...OHLCV_SIGNAL_DEFAULTS,
      ...GAKE_EXIT_DEFAULTS,
      ...CABAL_BURST_DEFAULTS,
      ...computeCabalBursts(events, grouped.mint, { asOfMs: first.at_ms }),
      max_mcap_usd: peak.mcap,
      max_mcap_at_ms: finiteInteger(peak.at_ms),
      multiple,
      time_to_peak_ms: timeToPeak,
      first_mcap_band: assignMcapBand(first.mcap),
      peak_mcap_band: assignPeakBand(peak.mcap),
      time_to_peak_band: assignTimeBand(timeToPeak),
      runner_label: assignRunnerLabel(multiple),
      signal_count: events.length,
      signal_kinds: uniq(events.map(event => event.kind)),
      has_candidate: 0,
      candidate_status: null,
      screening_blockers: [],
      candidate_blockers: [],
      blocker_source: 'none',
      has_dry_run_position: 0,
      dry_run_pnl_percent: null,
      dry_run_exit_reason: null,
      has_observations: 0,
      observation_count: 0,
      obs_max_mcap_usd: null,
      obs_max_mcap_at_ms: null,
      obs_multiple: null,
      obs_runner_label: null,
      obs_runner_label_differs: 0,
      obs_exceeds_signal_max: 0,
      obs_mcap_5m_usd: null,
      obs_mcap_5m_at_ms: null,
      obs_mcap_15m_usd: null,
      obs_mcap_15m_at_ms: null,
      obs_mcap_30m_usd: null,
      obs_mcap_30m_at_ms: null,
      obs_mcap_60m_usd: null,
      obs_mcap_60m_at_ms: null,
      obs_mcap_2h_usd: null,
      obs_mcap_2h_at_ms: null,
      obs_mcap_6h_usd: null,
      obs_mcap_6h_at_ms: null,
      obs_mcap_24h_usd: null,
      obs_mcap_24h_at_ms: null,
      obs_drawdown_before_peak_percent: null,
    };
  }).sort((a, b) => (a.first_seen_at_ms - b.first_seen_at_ms) || a.mint.localeCompare(b.mint));
}

export function joinScreeningBlockers(outcomes, db, { windowMs = SCREENING_WINDOW_MS } = {}) {
  const stmt = db.prepare(`
    SELECT at_ms, stage, action, reason_code
    FROM screening_events
    WHERE mint = ?
      AND at_ms >= ?
      AND at_ms <= ?
      AND reason_code IS NOT NULL
    ORDER BY ABS(at_ms - ?), at_ms, id
  `);

  for (const outcome of outcomes) {
    const rows = stmt.all(
      outcome.mint,
      outcome.first_seen_at_ms - windowMs,
      outcome.first_seen_at_ms + windowMs,
      outcome.first_seen_at_ms,
    );
    const blockers = rows
      .filter(row => BLOCKER_ACTION_RE.test(String(row.action || '')) || BLOCKER_STAGE_RE.test(String(row.stage || '')))
      .map(row => ({
        reason_code: row.reason_code,
        distance_ms: Math.abs(Number(row.at_ms) - Number(outcome.first_seen_at_ms)),
      }));
    const nearestDistance = blockers.reduce((min, row) => Math.min(min, row.distance_ms), Infinity);
    outcome.screening_blockers = Number.isFinite(nearestDistance)
      ? uniq(blockers.filter(row => row.distance_ms === nearestDistance).map(row => row.reason_code))
      : [];
    if (outcome.screening_blockers.length) outcome.blocker_source = 'screening_events';
  }
  return outcomes;
}

export function joinCandidates(outcomes, db) {
  const rows = db.prepare(`
    SELECT mint, status, created_at_ms, updated_at_ms, candidate_json, filter_result_json
    FROM candidates
    ORDER BY mint, updated_at_ms, id
  `).all();
  const byMint = new Map();
  for (const row of rows) {
    const bucket = byMint.get(row.mint) || [];
    bucket.push(row);
    byMint.set(row.mint, bucket);
  }

  for (const outcome of outcomes) {
    const candidates = byMint.get(outcome.mint) || [];
    if (!candidates.length) continue;
    const best = bestCandidateStatus(candidates);
    const firstCandidate = candidates
      .slice()
      .sort((a, b) => (Number(a.created_at_ms || 0) - Number(b.created_at_ms || 0)) || (Number(a.updated_at_ms || 0) - Number(b.updated_at_ms || 0)))[0];
    const candidateJson = safeJson(firstCandidate?.candidate_json, {});
    const candidateFeatures = extractCandidateFeatures(candidateJson);
    outcome.has_candidate = 1;
    outcome.candidate_status = best?.status || null;
    outcome.first_saved_wallet_hits = candidateFeatures.first_saved_wallet_hits;
    outcome.first_chart_high_dist = candidateFeatures.first_chart_high_dist;
    outcome.candidate_wallet_address_count = candidateFeatures.candidate_wallet_address_count;
    outcome.candidate_tier_a_wallet_count = candidateFeatures.candidate_tier_a_wallet_count;
    outcome.candidate_best_wallet_tier = candidateFeatures.candidate_best_wallet_tier;
    outcome.candidate_smart_degen_present = candidateFeatures.candidate_smart_degen_present;
    outcome.candidate_wallet_quality_bucket = candidateFeatures.candidate_wallet_quality_bucket;
    outcome.candidate_wallet_addresses = candidateFeatures.candidate_wallet_addresses;
    outcome.candidate_wallet_evidence = candidateFeatures.candidate_wallet_evidence;
    outcome.candidate_blockers = uniq(candidates.flatMap(candidate => candidateBlockersFromFilter(candidate.filter_result_json)));
    if (!outcome.screening_blockers.length && outcome.candidate_blockers.length) {
      outcome.blocker_source = 'candidates.filter_result_json';
    }
  }
  return outcomes;
}

export function joinDryRuns(outcomes, db) {
  const rows = db.prepare(`
    SELECT mint, status, opened_at_ms, closed_at_ms, pnl_percent, exit_reason
    FROM dry_run_positions
    ORDER BY mint, opened_at_ms
  `).all();
  const byMint = new Map();
  for (const row of rows) {
    const bucket = byMint.get(row.mint) || [];
    bucket.push(row);
    byMint.set(row.mint, bucket);
  }
  for (const outcome of outcomes) {
    const positions = byMint.get(outcome.mint) || [];
    if (!positions.length) continue;
    const latest = positions.slice().sort((a, b) => Number(b.opened_at_ms || 0) - Number(a.opened_at_ms || 0))[0];
    outcome.has_dry_run_position = 1;
    outcome.dry_run_pnl_percent = finiteNumber(latest.pnl_percent);
    outcome.dry_run_exit_reason = latest.exit_reason || null;
  }
  return outcomes;
}

function horizonColumnName(label) {
  return label.replace(/[^a-zA-Z0-9]/g, '');
}

function firstObservationAtOrAfter(rows, targetMs) {
  return rows.find(row => Number(row.observed_at_ms) >= targetMs) || null;
}

export function joinObservations(outcomes, db) {
  const columns = tableColumns(db, 'token_observations');
  const observationFields = [
    'mint',
    'observed_at_ms',
    'market_cap_usd',
    'ohlcv_open',
    'ohlcv_high',
    'ohlcv_low',
    'ohlcv_close',
    'ohlcv_finalized',
    'saved_wallet_holders',
    'saved_wallet_strong_count',
    'saved_wallet_kol_count',
  ];
  const orderBy = columns.has('id') ? 'mint, observed_at_ms, id' : 'mint, observed_at_ms';
  const rows = db.prepare(`
    SELECT ${selectListForColumns(columns, observationFields)}
    FROM token_observations
    ORDER BY ${orderBy}
  `).all();
  const byMint = new Map();
  for (const row of rows) {
    const bucket = byMint.get(row.mint) || [];
    bucket.push({
      ...row,
      observed_at_ms: finiteInteger(row.observed_at_ms),
      market_cap_usd: finiteNumber(row.market_cap_usd),
      ohlcv_open: finiteNumber(row.ohlcv_open),
      ohlcv_high: finiteNumber(row.ohlcv_high),
      ohlcv_low: finiteNumber(row.ohlcv_low),
      ohlcv_close: finiteNumber(row.ohlcv_close),
      saved_wallet_holders: finiteInteger(row.saved_wallet_holders),
      saved_wallet_strong_count: finiteInteger(row.saved_wallet_strong_count),
      saved_wallet_kol_count: finiteInteger(row.saved_wallet_kol_count),
    });
    byMint.set(row.mint, bucket);
  }

  for (const outcome of outcomes) {
    const observations = (byMint.get(outcome.mint) || [])
      .filter(row => row.observed_at_ms != null)
      .sort((a, b) => a.observed_at_ms - b.observed_at_ms);
    if (!observations.length) continue;

    const firstSeenMs = Number(outcome.first_seen_at_ms);
    Object.assign(
      outcome,
      computeOhlcvSignals(observations, { asOfMs: firstSeenMs }),
      computeGakeExitFlags(observations, { asOfMs: firstSeenMs }),
    );
    const mcapObservations = observations
      .filter(row => row.market_cap_usd != null && row.market_cap_usd > 0)
      .filter(row => !Number.isFinite(firstSeenMs) || row.observed_at_ms >= firstSeenMs);
    outcome.has_observations = 1;
    outcome.observation_count = observations.length;

    if (mcapObservations.length) {
      const peak = mcapObservations.reduce((best, row) => {
        if (row.market_cap_usd > best.market_cap_usd) return row;
        if (row.market_cap_usd === best.market_cap_usd && row.observed_at_ms < best.observed_at_ms) return row;
        return best;
      }, mcapObservations[0]);
      outcome.obs_max_mcap_usd = peak.market_cap_usd;
      outcome.obs_max_mcap_at_ms = peak.observed_at_ms;
      outcome.obs_multiple = outcome.first_mcap_usd > 0 ? peak.market_cap_usd / outcome.first_mcap_usd : null;
      outcome.obs_runner_label = assignRunnerLabel(outcome.obs_multiple);
      outcome.obs_runner_label_differs = outcome.obs_runner_label !== outcome.runner_label ? 1 : 0;
      outcome.obs_exceeds_signal_max = peak.market_cap_usd > Number(outcome.max_mcap_usd || 0) ? 1 : 0;

      let runningHigh = Number(outcome.first_mcap_usd || mcapObservations[0].market_cap_usd);
      let maxDrawdown = 0;
      for (const row of mcapObservations) {
        if (row.observed_at_ms > peak.observed_at_ms) break;
        if (row.market_cap_usd > runningHigh) {
          runningHigh = row.market_cap_usd;
          continue;
        }
        if (runningHigh > 0) {
          maxDrawdown = Math.max(maxDrawdown, (runningHigh - row.market_cap_usd) / runningHigh);
        }
      }
      outcome.obs_drawdown_before_peak_percent = maxDrawdown;
    }

    for (const [label, offsetMs] of OBSERVATION_HORIZONS) {
      const column = horizonColumnName(label);
      const observation = firstObservationAtOrAfter(mcapObservations, Number(outcome.first_seen_at_ms) + offsetMs);
      if (!observation) continue;
      outcome[`obs_mcap_${column}_usd`] = observation.market_cap_usd;
      outcome[`obs_mcap_${column}_at_ms`] = observation.observed_at_ms;
    }
  }
  return outcomes;
}

export function materializeOutcomes(db, { skipObservations = false } = {}) {
  const schema = validateAnalysisSchema(db);
  const outcomes = materializeSignalOutcomes(db);
  if (schema.hasScreeningEvents) joinScreeningBlockers(outcomes, db);
  if (schema.hasCandidates) joinCandidates(outcomes, db);
  if (schema.hasDryRunPositions) joinDryRuns(outcomes, db);
  if (!skipObservations && schema.hasTokenObservations) joinObservations(outcomes, db);
  if (skipObservations) schema.warnings.push('observation join skipped by --skip-observations; observation coverage fields are unset.');
  else if (!schema.hasTokenObservations) schema.warnings.push('token_observations table missing; observation enrichment is unavailable.');
  return { outcomes, warnings: schema.warnings };
}

export function outcomeCounts(outcomes) {
  return {
    total_mints: outcomes.length,
    runners_2x: outcomes.filter(outcome => outcome.multiple >= 2).length,
    runners_3x: outcomes.filter(outcome => outcome.multiple >= 3).length,
    runners_5x: outcomes.filter(outcome => outcome.multiple >= 5).length,
    runners_10x: outcomes.filter(outcome => outcome.multiple >= 10).length,
  };
}

export function distribution(outcomes, field) {
  const counts = new Map();
  for (const outcome of outcomes) {
    const key = outcome[field] || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function crossTab(outcomes, rowField, columnField, { rows, columns } = {}) {
  const rowKeys = rows || uniq(outcomes.map(outcome => outcome[rowField] || 'unknown')).sort();
  const columnKeys = columns || uniq(outcomes.map(outcome => outcome[columnField] || 'unknown')).sort();
  return rowKeys.map(rowKey => {
    const row = { [rowField]: rowKey, total: 0 };
    for (const columnKey of columnKeys) row[columnKey] = 0;
    for (const outcome of outcomes) {
      if ((outcome[rowField] || 'unknown') !== rowKey) continue;
      const columnKey = outcome[columnField] || 'unknown';
      if (!Object.hasOwn(row, columnKey)) row[columnKey] = 0;
      row[columnKey] += 1;
      row.total += 1;
    }
    return row;
  }).filter(row => row.total > 0);
}

export function medianBy(outcomes, groupField, valueField, { groups } = {}) {
  const groupKeys = groups || uniq(outcomes.map(outcome => outcome[groupField] || 'unknown')).sort();
  return groupKeys
    .map(group => ({
      group,
      median: median(outcomes
        .filter(outcome => (outcome[groupField] || 'unknown') === group)
        .map(outcome => outcome[valueField])),
      count: outcomes.filter(outcome => (outcome[groupField] || 'unknown') === group).length,
    }))
    .filter(row => row.count > 0);
}

export function topMissedRunners(outcomes, { limit = 10, threshold = 3 } = {}) {
  return outcomes
    .filter(outcome => outcome.multiple >= threshold && !outcome.has_dry_run_position)
    .slice()
    .sort((a, b) => b.multiple - a.multiple)
    .slice(0, limit)
    .map(outcome => ({
      mint: outcome.mint,
      symbol: outcome.symbol,
      first_mcap_usd: outcome.first_mcap_usd,
      max_mcap_usd: outcome.max_mcap_usd,
      multiple: outcome.multiple,
      first_seen_at_ms: outcome.first_seen_at_ms,
      time_to_peak_ms: outcome.time_to_peak_ms,
      candidate_status: outcome.candidate_status,
      blocker_source: outcome.blocker_source,
      blocker_reasons: outcome.screening_blockers.length ? outcome.screening_blockers : outcome.candidate_blockers,
    }));
}
