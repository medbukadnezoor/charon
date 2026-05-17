import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.SIGNAL_SERVER_URL = 'http://127.0.0.1:43456';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-screening-events-'));
process.env.DB_PATH = path.join(tempDir, 'charon-screening-events.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { upsertCandidate } = await import('../src/db/candidates.js');
const { logScreeningEvent } = await import('../src/db/screeningEvents.js');
const { setActiveStrategy, updateStrategyConfig } = await import('../src/db/settings.js');
const { normalizeJupiterTrendingRow } = await import('../src/enrichment/jupiter.js');
const { normalizeGmgnTrendingRow } = await import('../src/enrichment/gmgn.js');
const { normalizeAxiomTrendingEntry } = await import('../src/signals/axiomSource.js');
const {
  buildCandidateSignals,
  filterCandidate,
  logCandidateFilterOutcome,
} = await import('../src/pipeline/candidateBuilder.js');
const {
  fetchServerSignals,
  setCandidateHandler,
} = await import('../src/signals/serverClient.js');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('initDb creates screening event ledger schema and indexes', () => {
  initDb();

  const columns = db.prepare('PRAGMA table_info(screening_events)').all().map(row => row.name);
  for (const column of [
    'id',
    'at_ms',
    'mint',
    'strategy_id',
    'stage',
    'action',
    'reason_code',
    'reason_text',
    'signal_key',
    'candidate_id',
    'batch_id',
    'execution_mode',
    'source_count',
    'sources_json',
    'route',
    'age_ms',
    'age_threshold_ms',
    'has_fee_claim',
    'fee_claim_sol',
    'market_cap_usd',
    'holder_count',
    'max_holder_percent',
    'saved_wallet_holders',
    'gmgn_total_fee_sol',
    'graduated_volume_usd',
    'trending_source',
    'trending_volume_usd',
    'trending_swaps',
    'trending_rug_ratio',
    'trending_bundler_rate',
    'trending_is_wash_trading',
    'provider_fields_json',
    'config_snapshot_json',
  ]) {
    assert.equal(columns.includes(column), true, `missing column ${column}`);
  }

  const indexes = db.prepare('PRAGMA index_list(screening_events)').all().map(row => row.name);
  assert.equal(indexes.includes('idx_screening_events_at'), true);
  assert.equal(indexes.includes('idx_screening_events_mint_at'), true);
  assert.equal(indexes.includes('idx_screening_events_stage_reason'), true);
  assert.equal(indexes.includes('idx_screening_events_candidate'), true);
});

test('logScreeningEvent writes normalized compact rows without raw provider payloads', () => {
  initDb();

  const id = logScreeningEvent({
    atMs: 123456,
    stage: 'early_signal_gate',
    action: 'skipped',
    reasonCode: 'token_age_above_max',
    reasonText: 'token age exceeded strategy max',
    mint: 'Mint111111111111111111111111111111111111111',
    strategy: {
      id: 'sniper',
      token_age_max_ms: 600000,
      min_source_count: 2,
      require_fee_claim: true,
    },
    signal: {
      sourceCount: '3',
      sources: ['fee_claim', 'jupiter_trending'],
      ageMs: '900001',
      feeClaim: { distributedSol: '1.25' },
      trending: {
        source: 'jupiter',
        volume: '45000.5',
        swaps: '37',
        rug_ratio: null,
        bundler_rate: '0.12',
        is_wash_trading: false,
        risk_field_availability: { rug_ratio: 'unsupported', bundler_rate: 'present' },
      },
    },
    providerFields: {
      risk: 'compact',
      rawPayload: { nested: true },
      prompt: 'do not store',
      apiKey: 'do not store',
    },
    configSnapshot: {
      token_age_max_ms: 600000,
      trending_source: 'jupiter',
      irrelevant_large_field: 'ignored',
    },
  });

  const row = db.prepare('SELECT * FROM screening_events WHERE id = ?').get(id);
  assert.equal(row.at_ms, 123456);
  assert.equal(row.mint, 'Mint111111111111111111111111111111111111111');
  assert.equal(row.strategy_id, 'sniper');
  assert.equal(row.source_count, 3);
  assert.equal(row.age_ms, 900001);
  assert.equal(row.age_threshold_ms, 600000);
  assert.equal(row.has_fee_claim, 1);
  assert.equal(row.fee_claim_sol, 1.25);
  assert.equal(row.trending_source, 'jupiter');
  assert.equal(row.trending_volume_usd, 45000.5);
  assert.equal(row.trending_swaps, 37);
  assert.equal(row.trending_bundler_rate, 0.12);
  assert.equal(row.trending_is_wash_trading, 0);
  assert.deepEqual(JSON.parse(row.sources_json), ['fee_claim', 'jupiter_trending']);

  const providerFields = JSON.parse(row.provider_fields_json);
  assert.equal(providerFields.risk, 'compact');
  assert.deepEqual(providerFields.risk_field_availability, { rug_ratio: 'unsupported', bundler_rate: 'present' });
  assert.equal(providerFields.rawPayload, undefined);
  assert.equal(providerFields.prompt, undefined);
  assert.equal(providerFields.apiKey, undefined);

  const configSnapshot = JSON.parse(row.config_snapshot_json);
  assert.equal(configSnapshot.token_age_max_ms, 600000);
  assert.equal(configSnapshot.trending_source, 'jupiter');
  assert.equal(configSnapshot.irrelevant_large_field, undefined);
});

test('early gate skip events use stable reason codes and compact fields', () => {
  initDb();

  const strategy = {
    id: 'sniper',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 600000,
  };
  const base = {
    stage: 'early_signal_gate',
    action: 'skipped',
    strategy,
    configSnapshot: strategy,
    sources: ['jupiter_trending'],
    sourceCount: 1,
    hasFeeClaim: false,
    route: 'single_source',
  };

  const sourceCountId = logScreeningEvent({
    ...base,
    mint: 'SourceCount1111111111111111111111111111111',
    reasonCode: 'source_count_below_min',
    ageMs: 45000,
    ageThresholdMs: strategy.token_age_max_ms,
  });
  const feeId = logScreeningEvent({
    ...base,
    mint: 'FeeMissing111111111111111111111111111111111',
    reasonCode: 'fee_claim_missing_required',
    sourceCount: 2,
    sources: ['jupiter_trending', 'graduated'],
    route: 'graduated_trending',
    ageMs: 90000,
    ageThresholdMs: strategy.token_age_max_ms,
  });
  const ageId = logScreeningEvent({
    ...base,
    mint: 'AgeAbove1111111111111111111111111111111111',
    reasonCode: 'token_age_above_max',
    sourceCount: 2,
    sources: ['fee_claim', 'jupiter_trending'],
    hasFeeClaim: true,
    route: 'fee_trending',
    ageMs: 900001,
    ageThresholdMs: strategy.token_age_max_ms,
  });

  const rows = db.prepare(`
    SELECT reason_code, source_count, sources_json, route, age_ms, age_threshold_ms, has_fee_claim
    FROM screening_events
    WHERE id IN (?, ?, ?)
    ORDER BY id
  `).all(sourceCountId, feeId, ageId);

  assert.deepEqual(rows.map(row => row.reason_code), [
    'source_count_below_min',
    'fee_claim_missing_required',
    'token_age_above_max',
  ]);
  assert.equal(rows[0].source_count, 1);
  assert.deepEqual(JSON.parse(rows[0].sources_json), ['jupiter_trending']);
  assert.equal(rows[0].has_fee_claim, 0);
  assert.equal(rows[1].route, 'graduated_trending');
  assert.equal(rows[1].source_count, 2);
  assert.equal(rows[2].age_ms, 900001);
  assert.equal(rows[2].age_threshold_ms, 600000);
  assert.equal(rows[2].has_fee_claim, 1);
});

test('fetchServerSignals writes early gate screening events before candidate creation', async () => {
  initDb();

  setSniperStrategy({
    entry_mode: 'immediate',
    min_source_count: 2,
    require_fee_claim: true,
    token_age_max_ms: 600000,
    min_fee_claim_sol: 0,
    min_mcap_usd: 0,
    max_mcap_usd: 0,
    min_gmgn_total_fee_sol: 0,
    min_graduated_volume_usd: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0,
    trending_max_bundler_rate: 0,
  });

  let triggered = 0;
  setCandidateHandler(async () => {
    triggered++;
  });

  const signals = [
    {
      mint: 'RuntimeSource11111111111111111111111111111',
      sources: ['server_trending'],
      sourceCount: 1,
      ageMs: 120000,
      name: 'Source Gate',
      symbol: 'SRC',
    },
    {
      mint: 'RuntimeFee111111111111111111111111111111111',
      sources: ['server_trending', 'graduated'],
      sourceCount: 2,
      ageMs: 120000,
      name: 'Fee Gate',
      symbol: 'FEE',
    },
    {
      mint: 'RuntimeAge111111111111111111111111111111111',
      sources: ['server_trending', 'fee_claim'],
      sourceCount: 2,
      ageMs: 900001,
      name: 'Age Gate',
      symbol: 'AGE',
      feeClaim: {
        distributedSol: 1.5,
        shareholders: [],
        signature: 'age-sig',
      },
    },
  ];

  const server = createServer((req, res) => {
    assert.equal(req.url.startsWith('/api/signals'), true);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ signals }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(43456, '127.0.0.1', resolve);
  });

  try {
    await fetchServerSignals();
  } finally {
    setCandidateHandler(null);
    await new Promise(resolve => server.close(resolve));
  }

  assert.equal(triggered, 0);

  const rows = db.prepare(`
    SELECT mint, stage, action, reason_code, source_count, sources_json, route,
      age_ms, age_threshold_ms, has_fee_claim, provider_fields_json, config_snapshot_json
    FROM screening_events
    WHERE mint LIKE 'Runtime%'
    ORDER BY id
  `).all();

  assert.deepEqual(rows.map(row => row.reason_code), [
    'source_count_below_min',
    'fee_claim_missing_required',
    'token_age_above_max',
  ]);
  assert.equal(rows.every(row => row.stage === 'early_signal_gate'), true);
  assert.equal(rows.every(row => row.action === 'skipped'), true);
  assert.equal(rows[0].source_count, 1);
  assert.equal(rows[0].route, 'single_source');
  assert.equal(rows[1].source_count, 2);
  assert.equal(rows[1].route, 'dual_source');
  assert.equal(rows[2].age_ms, 900001);
  assert.equal(rows[2].age_threshold_ms, 600000);
  assert.equal(rows[2].has_fee_claim, 1);
  assert.deepEqual(JSON.parse(rows[2].sources_json), ['server_trending', 'fee_claim']);

  for (const row of rows) {
    const providerFields = JSON.parse(row.provider_fields_json);
    assert.equal(providerFields.rawPayload, undefined);
    assert.equal(providerFields.prompt, undefined);
    assert.equal(providerFields.header, undefined);
    assert.equal(providerFields.token, undefined);

    const configSnapshot = JSON.parse(row.config_snapshot_json);
    assert.equal(configSnapshot.min_source_count, 2);
    assert.equal(configSnapshot.require_fee_claim, true);
    assert.equal(configSnapshot.token_age_max_ms, 600000);
  }
});

test('candidate signal snapshot keeps compact server signal metadata', () => {
  const signals = buildCandidateSignals({
    fee: { mint: 'Meta1111111111111111111111111111111111111' },
    graduatedCoin: { coinMint: 'Meta1111111111111111111111111111111111111' },
    trendingToken: null,
    signature: 'sig111',
    strat: { id: 'sniper' },
    signalRoute: 'fee_graduated',
    signalMeta: {
      ageMs: 123456,
      sourceCount: 2,
      sources: ['fee_claim', 'graduated'],
      hasFeeClaim: true,
      seenAtMs: 987654321,
      rawPayload: { shouldNotPersist: true },
    },
  });

  assert.equal(signals.route, 'fee_graduated');
  assert.equal(signals.label, 'fees + graduated');
  assert.equal(signals.ageMs, 123456);
  assert.equal(signals.sourceCount, 2);
  assert.deepEqual(signals.sources, ['fee_claim', 'graduated']);
  assert.equal(signals.hasFeeClaim, true);
  assert.equal(signals.seenAtMs, 987654321);
  assert.equal(signals.rawPayload, undefined);
});

function setSniperStrategy(config) {
  updateStrategyConfig('sniper', config);
  setActiveStrategy('sniper');
}

function syntheticCandidate(overrides = {}) {
  const base = {
    token: {
      mint: 'Candidate11111111111111111111111111111111',
      name: 'Candidate',
      symbol: 'CAND',
    },
    metrics: {
      marketCapUsd: 100000,
      holderCount: 100,
      gmgnTotalFeesSol: 12,
      graduatedVolumeUsd: 50000,
      trendingVolumeUsd: 40000,
      trendingSwaps: 60,
    },
    signals: {
      route: 'fee_graduated_trending',
      label: 'fees + graduated + trending',
      hasFeeClaim: true,
      sourceCount: 3,
      sources: ['fee_claim', 'graduated', 'jupiter_trending'],
      ageMs: 120000,
      strategy: 'sniper',
    },
    holders: {
      maxHolderPercent: 12,
      top20Percent: 35,
    },
    savedWalletExposure: {
      holderCount: 2,
      checked: 20,
    },
    feeClaim: {
      distributedSol: 2,
    },
    gmgn: {},
    graduation: {
      volume: 50000,
    },
    trending: {
      source: 'jupiter',
      volume: 40000,
      swaps: 60,
      rug_ratio: 0.1,
      bundler_rate: 0.1,
      is_wash_trading: false,
    },
    chart: {
      distanceFromAthPercent: -50,
    },
  };

  return {
    ...base,
    ...overrides,
    token: { ...base.token, ...(overrides.token || {}) },
    metrics: { ...base.metrics, ...(overrides.metrics || {}) },
    signals: { ...base.signals, ...(overrides.signals || {}) },
    holders: { ...base.holders, ...(overrides.holders || {}) },
    savedWalletExposure: { ...base.savedWalletExposure, ...(overrides.savedWalletExposure || {}) },
    trending: overrides.trending === null ? null : { ...base.trending, ...(overrides.trending || {}) },
    chart: { ...base.chart, ...(overrides.chart || {}) },
  };
}

test('filterCandidate keeps display failures and adds stable machine codes', () => {
  initDb();

  setSniperStrategy({
    entry_mode: 'immediate',
    min_source_count: 1,
    require_fee_claim: true,
    token_age_max_ms: 3600000,
    min_fee_claim_sol: 5,
    min_mcap_usd: 1000,
    max_mcap_usd: 50,
    min_gmgn_total_fee_sol: 10,
    min_graduated_volume_usd: 1000,
    min_holders: 200,
    max_top20_holder_percent: 20,
    min_saved_wallet_holders: 3,
    max_ath_distance_pct: -40,
    trending_min_volume_usd: 1000,
    trending_min_swaps: 10,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.3,
  });

  const missingFeeCandidate = syntheticCandidate({
    feeClaim: null,
    metrics: {
      marketCapUsd: 100,
      holderCount: 10,
      gmgnTotalFeesSol: 2,
      graduatedVolumeUsd: 100,
      trendingVolumeUsd: 100,
      trendingSwaps: 2,
    },
    holders: {
      maxHolderPercent: 30,
    },
    savedWalletExposure: {
      holderCount: 0,
    },
    trending: {
      volume: 100,
      swaps: 2,
      rug_ratio: 0.9,
      bundler_rate: 0.8,
      is_wash_trading: true,
    },
    chart: {
      distanceFromAthPercent: 0,
    },
  });

  const filters = filterCandidate(missingFeeCandidate);
  assert.equal(filters.passed, false);
  assert.equal(filters.primaryFailureCode, 'fee_claim_missing_required');
  assert.deepEqual(filters.failureCodes, [
    'fee_claim_missing_required',
    'min_mcap_usd',
    'max_mcap_usd',
    'min_gmgn_total_fee_sol',
    'min_graduated_volume_usd',
    'min_holders',
    'max_top20_holder_percent',
    'min_saved_wallet_holders',
    'max_ath_distance_pct',
    'trending_min_volume_usd',
    'trending_min_swaps',
    'trending_max_rug_ratio',
    'trending_max_bundler_rate',
    'trending_wash_trading',
  ]);
  assert.equal(filters.failures[0], 'fee claim: missing (required by strategy)');
  assert.equal(filters.failures.includes('trending wash trading'), true);

  const lowFeeFilters = filterCandidate(syntheticCandidate({
    feeClaim: { distributedSol: 1 },
  }));
  assert.equal(lowFeeFilters.primaryFailureCode, 'min_fee_claim_sol');
  assert.equal(lowFeeFilters.failures[0], 'fee claim: 1 SOL < min 5 SOL');
});

test('candidate filter outcomes log passed and filtered events with stable codes', () => {
  initDb();

  const passStrategy = {
    id: 'sniper',
    min_source_count: 1,
    require_fee_claim: false,
    token_age_max_ms: 3600000,
    min_fee_claim_sol: 0,
    min_mcap_usd: 1000,
    max_mcap_usd: 200000,
    min_gmgn_total_fee_sol: 0,
    min_graduated_volume_usd: 0,
    min_holders: 10,
    max_top20_holder_percent: 50,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    trending_source: 'jupiter',
    trending_min_volume_usd: 1000,
    trending_min_swaps: 10,
    trending_max_rug_ratio: 0.3,
    trending_max_bundler_rate: 0.5,
  };
  setSniperStrategy(passStrategy);

  const passedCandidate = syntheticCandidate();
  passedCandidate.filters = filterCandidate(passedCandidate);
  logCandidateFilterOutcome(passedCandidate, passStrategy);

  const passedRow = db.prepare(`
    SELECT *
    FROM screening_events
    WHERE stage = 'candidate_filter' AND mint = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(passedCandidate.token.mint);
  assert.equal(passedRow.action, 'passed');
  assert.equal(passedRow.reason_code, 'candidate_filter_passed');
  assert.equal(passedRow.market_cap_usd, 100000);
  assert.equal(passedRow.holder_count, 100);
  assert.equal(passedRow.saved_wallet_holders, 2);
  assert.equal(passedRow.fee_claim_sol, 2);
  assert.equal(passedRow.gmgn_total_fee_sol, 12);
  assert.equal(passedRow.graduated_volume_usd, 50000);
  assert.equal(passedRow.trending_source, 'jupiter');
  assert.equal(passedRow.trending_volume_usd, 40000);
  assert.equal(passedRow.trending_swaps, 60);
  assert.equal(passedRow.trending_rug_ratio, 0.1);
  assert.equal(passedRow.trending_bundler_rate, 0.1);
  assert.equal(passedRow.trending_is_wash_trading, 0);

  const passedProviderFields = JSON.parse(passedRow.provider_fields_json);
  assert.deepEqual(passedProviderFields.failureCodes, []);
  assert.equal(passedProviderFields.primaryFailureCode, undefined);
  assert.equal(passedProviderFields.filterPassed, true);
  assert.equal(passedProviderFields.candidate.mint, passedCandidate.token.mint);

  const strictStrategy = {
    ...passStrategy,
    min_holders: 200,
    trending_max_bundler_rate: 0.05,
  };
  setSniperStrategy(strictStrategy);

  const filteredCandidate = syntheticCandidate({
    token: { mint: 'Filtered1111111111111111111111111111111' },
  });
  filteredCandidate.filters = filterCandidate(filteredCandidate);
  const candidateId = upsertCandidate(filteredCandidate, null);
  logCandidateFilterOutcome(filteredCandidate, strictStrategy);

  const persistedCandidate = db.prepare('SELECT filter_result_json FROM candidates WHERE id = ?').get(candidateId);
  const filterResultJson = JSON.parse(persistedCandidate.filter_result_json);
  assert.deepEqual(filterResultJson.failureCodes, ['min_holders', 'trending_max_bundler_rate']);
  assert.equal(filterResultJson.primaryFailureCode, 'min_holders');
  assert.deepEqual(filterResultJson.failures, [
    'holders: 100 < 200',
    'trending bundler rate: 0.1 > 0.05',
  ]);

  const filteredRow = db.prepare(`
    SELECT *
    FROM screening_events
    WHERE stage = 'candidate_filter' AND mint = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(filteredCandidate.token.mint);
  assert.equal(filteredRow.action, 'filtered');
  assert.equal(filteredRow.reason_code, 'min_holders');
  assert.equal(filteredRow.reason_text, 'holders: 100 < 200; trending bundler rate: 0.1 > 0.05');

  const filteredProviderFields = JSON.parse(filteredRow.provider_fields_json);
  assert.deepEqual(filteredProviderFields.failureCodes, ['min_holders', 'trending_max_bundler_rate']);
  assert.equal(filteredProviderFields.primaryFailureCode, 'min_holders');
  assert.equal(filteredProviderFields.failureCount, 2);

  const configSnapshot = JSON.parse(filteredRow.config_snapshot_json);
  assert.equal(configSnapshot.min_holders, 200);
  assert.equal(configSnapshot.trending_max_bundler_rate, 0.05);
  assert.equal(configSnapshot.max_ath_distance_pct, 0);
});

test('trending risk normalizers distinguish present, missing, and unsupported fields', () => {
  const jupiterWithBot = normalizeJupiterTrendingRow({
    id: 'Jupiter1111111111111111111111111111111111111',
    usdPrice: 1,
    audit: { botHoldersPercentage: 12 },
    stats5m: { buyVolume: 10, sellVolume: 5, numBuys: 2, numSells: 1 },
  }, '5m', 1);
  assert.equal(jupiterWithBot.bundler_rate, 0.12);
  assert.equal(jupiterWithBot.rug_ratio, null);
  assert.equal(jupiterWithBot.is_wash_trading, null);
  assert.deepEqual(jupiterWithBot.risk_field_availability, {
    rug_ratio: 'unsupported',
    bundler_rate: 'present',
    is_wash_trading: 'unsupported',
    source: 'jupiter_toptrending',
  });

  const jupiterMissingBot = normalizeJupiterTrendingRow({
    id: 'Jupiter2222222222222222222222222222222222222',
    stats5m: {},
  }, '5m', 2);
  assert.equal(jupiterMissingBot.bundler_rate, null);
  assert.equal(jupiterMissingBot.risk_field_availability.bundler_rate, 'missing');

  const gmgn = normalizeGmgnTrendingRow({
    address: 'Gmgn111111111111111111111111111111111111111',
    rugRatio: '0',
    bundlerRate: '0.35',
    isWashTrading: 'false',
  }, '5m', 3, ['not_wash_trading']);
  assert.equal(gmgn.rug_ratio, 0);
  assert.equal(gmgn.bundler_rate, 0.35);
  assert.equal(gmgn.is_wash_trading, false);
  assert.equal(gmgn.risk_field_availability.rug_ratio, 'present');
  assert.equal(gmgn.risk_field_availability.bundler_rate, 'present');
  assert.equal(gmgn.risk_field_availability.is_wash_trading, 'present');
  assert.deepEqual(gmgn.risk_field_availability.provider_side_filters, ['not_wash_trading']);

  const axiom = normalizeAxiomTrendingEntry([
    null,
    'Axiom11111111111111111111111111111111111111',
    'Axiom Name',
    'AX',
  ], '1h', 4, 123);
  assert.equal(axiom.rug_ratio, null);
  assert.equal(axiom.bundler_rate, null);
  assert.equal(axiom.is_wash_trading, null);
  assert.equal(axiom.risk_field_availability.rug_ratio, 'unsupported');
  assert.equal(axiom.risk_field_availability.bundler_rate, 'unsupported');
  assert.equal(axiom.risk_field_availability.is_wash_trading, 'unsupported');
});

test('candidate filter events keep missing risk fields distinct from real zero', () => {
  initDb();

  const strategy = {
    id: 'sniper',
    require_fee_claim: false,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    max_ath_distance_pct: 0,
    trending_source: 'jupiter',
    trending_min_volume_usd: 0,
    trending_min_swaps: 0,
    trending_max_rug_ratio: 0.2,
    trending_max_bundler_rate: 0.5,
  };
  setSniperStrategy(strategy);

  const missingRiskCandidate = syntheticCandidate({
    token: { mint: 'MissingRisk111111111111111111111111111111' },
    trending: {
      source: 'jupiter',
      volume: 40000,
      swaps: 60,
      rug_ratio: null,
      bundler_rate: null,
      is_wash_trading: null,
      risk_field_availability: {
        rug_ratio: 'unsupported',
        bundler_rate: 'missing',
        is_wash_trading: 'unsupported',
        source: 'jupiter_toptrending',
      },
    },
  });
  missingRiskCandidate.filters = filterCandidate(missingRiskCandidate);
  assert.equal(missingRiskCandidate.filters.passed, true);
  logCandidateFilterOutcome(missingRiskCandidate, strategy);

  const missingRow = db.prepare(`
    SELECT trending_rug_ratio, trending_bundler_rate, trending_is_wash_trading, provider_fields_json
    FROM screening_events
    WHERE mint = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(missingRiskCandidate.token.mint);
  assert.equal(missingRow.trending_rug_ratio, null);
  assert.equal(missingRow.trending_bundler_rate, null);
  assert.equal(missingRow.trending_is_wash_trading, null);
  assert.deepEqual(JSON.parse(missingRow.provider_fields_json).risk_field_availability, {
    rug_ratio: 'unsupported',
    bundler_rate: 'missing',
    is_wash_trading: 'unsupported',
    source: 'jupiter_toptrending',
  });

  const zeroRiskCandidate = syntheticCandidate({
    token: { mint: 'ZeroRisk111111111111111111111111111111111' },
    trending: {
      source: 'gmgn_market_rank',
      volume: 40000,
      swaps: 60,
      rug_ratio: 0,
      bundler_rate: 0,
      is_wash_trading: false,
      risk_field_availability: {
        rug_ratio: 'present',
        bundler_rate: 'present',
        is_wash_trading: 'present',
        source: 'gmgn_market_rank',
      },
    },
  });
  zeroRiskCandidate.filters = filterCandidate(zeroRiskCandidate);
  assert.equal(zeroRiskCandidate.filters.passed, true);
  logCandidateFilterOutcome(zeroRiskCandidate, strategy);

  const zeroRow = db.prepare(`
    SELECT trending_rug_ratio, trending_bundler_rate, trending_is_wash_trading, provider_fields_json
    FROM screening_events
    WHERE mint = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(zeroRiskCandidate.token.mint);
  assert.equal(zeroRow.trending_rug_ratio, 0);
  assert.equal(zeroRow.trending_bundler_rate, 0);
  assert.equal(zeroRow.trending_is_wash_trading, 0);
  assert.equal(JSON.parse(zeroRow.provider_fields_json).risk_field_availability.bundler_rate, 'present');
});
