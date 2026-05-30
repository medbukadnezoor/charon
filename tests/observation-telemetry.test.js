import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.CHARON_PROVIDER_STUBS = 'true';
process.env.LEDGER_WRITER_ENABLED = 'true';
process.env.TELEMETRY_COLLECTOR_ENABLED = 'true';
process.env.TELEMETRY_OHLCV_INTERVAL = '1m';
process.env.BIRDEYE_API_KEY = 'test-birdeye';
process.env.TELEGRAM_BOT_TOKEN = 'test:telemetry';
process.env.TELEGRAM_CHAT_ID = '0';
process.env.HELIUS_API_KEY = 'test-helius';
process.env.GMGN_ENABLED = 'false';

const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-observation-telemetry-'));
process.env.DB_PATH = path.join(tempDir, 'telemetry.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { claimDueObservationRows, insertProviderCall, queueCandidateObservation, reconcileObservationQueueState, telemetryDoctorSummary } = await import('../src/db/observations.js');
const { runTelemetryCollector } = await import('../src/telemetry/collector.js');
const { fetchBirdeyeEntryCandles, fetchBirdeyeOhlcv, fetchBirdeyePairOhlcv, fetchBirdeyeTokenTxCandle, fetchBirdeyeTokenTxs } = await import('../src/enrichment/birdeye.js');
const { fetchEntryCandles } = await import('../src/enrichment/entryCandles.js');
const { fetchGmgnKline } = await import('../src/enrichment/gmgn.js');
const { validateExecutionLane, validateDecisionAction, validateDecisionStage } = await import('../src/telemetry/laneTags.js');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function fixtureCandidate(overrides = {}) {
  return {
    token: {
      mint: overrides.mint || 'TelemetryMint111111111111111111111111111111',
      symbol: 'TEL',
      name: 'Telemetry',
    },
    signals: {
      route: 'graduated_trending',
      label: 'graduated + trending',
      sourceCount: 2,
      sources: ['graduated', 'trending'],
      strategy: 'degen',
      ageMs: 120000,
    },
    metrics: {
      priceUsd: 0.0001,
      marketCapUsd: 100000,
      liquidityUsd: 25000,
      holderCount: 100,
      gmgnTotalFeesSol: 1,
      trendingVolumeUsd: 50000,
      trendingSwaps: 100,
    },
    holders: {
      count: 100,
      maxHolderPercent: 12,
      top20Percent: 35,
    },
    trending: {
      source: 'jupiter_toptrending',
      volume: 50000,
      swaps: 100,
      rug_ratio: 0.1,
      bundler_rate: 0.2,
      is_wash_trading: false,
    },
    feeClaim: { distributedSol: 0.2 },
    savedWalletExposure: {
      holderCount: 1,
      checked: 20,
      evidence: {
        summary: { strongCount: 1, kolCount: 0 },
        wallets: [{ tier: 'A', tags: ['smart'] }],
      },
    },
    filters: {
      passed: overrides.passed ?? true,
      failureCodes: overrides.failureCodes || [],
      primaryFailureCode: overrides.primaryFailureCode || null,
      strategy: 'degen',
    },
    mcapSample: { source: 'stub', disagreementPercent: 0 },
  };
}

function setDbSetting(key, value) {
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function birdeyeNetworkCallsToday() {
  const atMs = Date.now();
  const date = new Date(atMs);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM provider_call_ledger
    WHERE provider = 'birdeye'
      AND endpoint != 'budget_policy'
      AND status IN ('ok', 'error')
      AND at_ms >= ?
  `).get(dayStart).count;
}

test('lane tag validators reject unknown values', () => {
  assert.equal(validateExecutionLane('shadow_dry_run'), 'shadow_dry_run');
  assert.equal(validateDecisionAction('filtered'), 'filtered');
  assert.throws(() => validateExecutionLane('mixed_lane'), /not allowed/);
  assert.throws(() => validateDecisionAction('maybe'), /not allowed/);
});

test('initDb creates telemetry schema', () => {
  initDb();
  for (const table of [
    'token_observation_queue',
    'token_observations',
    'provider_call_ledger',
    'telemetry_collector_runs',
    'provider_response_cache',
  ]) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    assert.equal(row?.name, table);
  }
});

test('queue writer records one idempotent filter-hit row', () => {
  initDb();
  const candidate = fixtureCandidate();
  const first = queueCandidateObservation({
    candidate,
    candidateId: 42,
    stage: 'candidate_filter',
    action: 'passed',
  });
  const second = queueCandidateObservation({
    candidate,
    candidateId: 42,
    stage: 'candidate_filter',
    action: 'passed',
  });

  assert.equal(first.queued, true);
  assert.equal(second.queued, true);
  const rows = db.prepare('SELECT * FROM token_observation_queue WHERE mint = ?').all(candidate.token.mint);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tier, 'A');
  assert.equal(rows[0].execution_lane, 'primary_dry_run');
  const snapshot = JSON.parse(rows[0].baseline_snapshot_json);
  assert.equal(snapshot.savedWalletHolders, 1);
  assert.equal(snapshot.filterPassed, true);
  assert.equal(snapshot.decisionEvents.length, 1);
});

test('queue writer can delay the first observation for outcome labeling', () => {
  initDb();
  setDbSetting('telemetry_initial_observe_delay_ms', 6 * 60 * 60_000);
  try {
    const atMs = Date.now() + 120_000;
    const candidate = fixtureCandidate({ mint: 'DelayedMint11111111111111111111111111111' });
    queueCandidateObservation({
      candidate,
      candidateId: 43,
      stage: 'candidate_filter',
      action: 'passed',
      atMs,
    });
    const row = db.prepare('SELECT * FROM token_observation_queue WHERE mint = ?').get(candidate.token.mint);
    assert.equal(row.next_observe_at_ms, atMs + 6 * 60 * 60_000);
    const schedule = JSON.parse(row.schedule_json);
    assert.equal(schedule.initialDelayMs, 6 * 60 * 60_000);
    assert.equal(schedule.nextObserveAt, row.next_observe_at_ms);
  } finally {
    setDbSetting('telemetry_initial_observe_delay_ms', 0);
  }
});

test('queue writer merges same-token lifecycle decisions into one active row', () => {
  initDb();
  const candidate = fixtureCandidate({ mint: 'MergedMint111111111111111111111111111111' });
  const first = queueCandidateObservation({
    candidate,
    candidateId: 77,
    stage: 'candidate_filter',
    action: 'passed',
    atMs: Date.now(),
  });
  const second = queueCandidateObservation({
    candidate,
    candidateId: 77,
    stage: 'llm_decision',
    action: 'watch',
    atMs: Date.now() + 1000,
  });
  const third = queueCandidateObservation({
    candidate,
    candidateId: 77,
    stage: 'entry_decision',
    action: 'no_candidate_selected',
    atMs: Date.now() + 2000,
  });

  assert.equal(first.queued, true);
  assert.equal(second.merged, true);
  assert.equal(third.merged, true);
  assert.equal(first.id, second.id);
  assert.equal(first.id, third.id);

  const rows = db.prepare('SELECT * FROM token_observation_queue WHERE mint = ?').all(candidate.token.mint);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision_stage, 'entry_decision');
  assert.equal(rows[0].decision_action, 'no_candidate_selected');
  const snapshot = JSON.parse(rows[0].baseline_snapshot_json);
  assert.deepEqual(snapshot.decisionEvents.map(event => `${event.stage}:${event.action}`), [
    'candidate_filter:passed',
    'llm_decision:watch',
    'entry_decision:no_candidate_selected',
  ]);
});

test('queue reconciliation backfills legacy active rows and merges duplicate groups', () => {
  initDb();
  const atMs = Date.now() + 30_000;
  const candidate = fixtureCandidate({ mint: 'LegacyMergeMint11111111111111111111111111' });
  const first = queueCandidateObservation({
    candidate,
    candidateId: 88,
    stage: 'candidate_filter',
    action: 'passed',
    atMs,
  });
  db.prepare(`
    UPDATE token_observation_queue
    SET baseline_snapshot_json = json_remove(baseline_snapshot_json, '$.decisionEvents', '$.latestDecisionStage', '$.latestDecisionAction')
    WHERE id = ?
  `).run(first.id);
  db.prepare(`
    INSERT INTO token_observation_queue (
      mint, source_instance, execution_lane, decision_stage, decision_action, decision_event_key,
      candidate_id, status, tier, watch_status, eligibility_reason, filter_blocker_count,
      rug_risk_score, next_observe_at_ms, max_observation_until_ms, created_at_ms, updated_at_ms,
      baseline_snapshot_json, schedule_json
    )
    SELECT mint, source_instance, execution_lane, 'llm_decision', 'watch', decision_event_key || ':legacy-dup',
      candidate_id, 'pending', tier, watch_status, eligibility_reason, filter_blocker_count,
      rug_risk_score, next_observe_at_ms, max_observation_until_ms, created_at_ms + 1, updated_at_ms + 1,
      json_remove(baseline_snapshot_json, '$.decisionEvents', '$.latestDecisionStage', '$.latestDecisionAction'), schedule_json
    FROM token_observation_queue
    WHERE id = ?
  `).run(first.id);

  const result = reconcileObservationQueueState({ atMs });
  assert.equal(result.backfilledRows >= 1, true);
  assert.equal(result.mergedRows, 1);

  const activeRows = db.prepare(`
    SELECT * FROM token_observation_queue
    WHERE mint = ? AND status IN ('pending', 'leased') AND watch_status IN ('active', 'promoted')
  `).all(candidate.token.mint);
  assert.equal(activeRows.length, 1);
  const snapshot = JSON.parse(activeRows[0].baseline_snapshot_json);
  assert.deepEqual(snapshot.decisionEvents.map(event => `${event.stage}:${event.action}`), [
    'candidate_filter:passed',
    'llm_decision:watch',
  ]);
});

test('claimDueObservationRows claims only one row per active token group after reconciliation', () => {
  initDb();
  const atMs = Date.now() + 60_000;
  const candidate = fixtureCandidate({ mint: 'ClaimMergeMint111111111111111111111111111' });
  const first = queueCandidateObservation({
    candidate,
    candidateId: 89,
    stage: 'candidate_filter',
    action: 'passed',
    atMs,
  });
  db.prepare(`
    INSERT INTO token_observation_queue (
      mint, source_instance, execution_lane, decision_stage, decision_action, decision_event_key,
      candidate_id, status, tier, watch_status, eligibility_reason, filter_blocker_count,
      rug_risk_score, next_observe_at_ms, max_observation_until_ms, created_at_ms, updated_at_ms,
      baseline_snapshot_json, schedule_json
    )
    SELECT mint, source_instance, execution_lane, 'entry_decision', 'no_candidate_selected', decision_event_key || ':claim-dup',
      candidate_id, 'pending', tier, watch_status, eligibility_reason, filter_blocker_count,
      rug_risk_score, next_observe_at_ms, max_observation_until_ms, created_at_ms + 1, updated_at_ms + 1,
      baseline_snapshot_json, schedule_json
    FROM token_observation_queue
    WHERE id = ?
  `).run(first.id);

  const claimed = claimDueObservationRows({ limit: 10, leaseOwner: 'test-claimer', atMs: atMs + 1 });
  assert.equal(claimed.filter(row => row.mint === candidate.token.mint).length, 1);
  const activeRows = db.prepare(`
    SELECT * FROM token_observation_queue
    WHERE mint = ? AND status IN ('pending', 'leased') AND watch_status IN ('active', 'promoted')
  `).all(candidate.token.mint);
  assert.equal(activeRows.length, 1);
  assert.equal(activeRows[0].status, 'leased');
});

test('collector writes Birdeye observation, provider ledger, cache hit, and doctor summary', async () => {
  initDb();
  const candidate = fixtureCandidate({ mint: 'CollectorMint11111111111111111111111111111' });
  queueCandidateObservation({
    candidate,
    candidateId: 99,
    stage: 'candidate_filter',
    action: 'passed',
  });

  const first = await runTelemetryCollector({ limit: 5 });
  assert.equal(first.claimedCount >= 1, true);
  assert.equal(first.observedCount >= 1, true);
  assert.equal(first.providerOkCount >= 3, true);

  const observation = db.prepare('SELECT * FROM token_observations WHERE mint = ?').get(candidate.token.mint);
  assert.equal(observation.provider_set, 'birdeye_market_holders_ohlcv');
  assert.equal(observation.ohlcv_interval, '1m');
  assert.equal(observation.ohlcv_close, 0.00014);
  const qualityFlags = JSON.parse(observation.quality_flags_json);
  assert.equal(qualityFlags.ohlcvAvailable, true);
  assert.equal(qualityFlags.ohlcvUnavailable, false);

  const ledgerRows = db.prepare('SELECT status, COUNT(*) AS count FROM provider_call_ledger WHERE mint = ? GROUP BY status').all(candidate.token.mint);
  assert.equal(ledgerRows.some(row => row.status === 'ok' && row.count >= 3), true);
  const ohlcvLedger = db.prepare("SELECT cache_key FROM provider_call_ledger WHERE mint = ? AND endpoint = '/defi/v3/ohlcv' ORDER BY id DESC LIMIT 1").get(candidate.token.mint);
  assert.match(ohlcvLedger.cache_key, /interval=1m;mode=count;count_limit=2/);

  const followup = db.prepare("UPDATE token_observation_queue SET status = 'pending', next_observe_at_ms = ? WHERE mint = ?").run(Date.now() - 1, candidate.token.mint);
  assert.equal(followup.changes, 1);
  const second = await runTelemetryCollector({ limit: 5 });
  assert.equal(second.cacheHitCount >= 3, true);

  const doctor = telemetryDoctorSummary({ limit: 10, staleCollectorMs: 60 * 60_000 });
  assert.equal(Array.isArray(doctor.counts), true);
  assert.equal(doctor.provider_counts.some(row => row.status === 'cache_hit'), true);
  assert.equal(doctor.observation_coverage.some(row => row.with_ohlcv >= 1), true);
  assert.equal(doctor.latest_ohlcv_calls.some(row => row.status === 'cache_hit' || row.status === 'ok'), true);
});

test('Birdeye OHLCV normalizer marks 5m candle boundaries from provider payload', async () => {
  const atMs = 1_779_024_600_000;
  const result = await fetchBirdeyeOhlcv('StubMint111111111111111111111111111111111', { atMs, interval: '5m' });
  assert.equal(result.normalized.interval, '5m');
  assert.equal(result.normalized.endMs - result.normalized.startMs, 5 * 60_000);
  assert.equal(result.normalized.finalized, true);
  assert.equal(result.normalized.volume, 12345);
  assert.equal(result.candles.length, 1);
  assert.equal(result.candles[0].c, 0.00014);
});

test('Birdeye pair OHLCV normalizer reads pair candles from provider payload', async () => {
  const atMs = 1_779_024_600_000;
  const result = await fetchBirdeyePairOhlcv('StubPair1111111111111111111111111111111111', { atMs, interval: '1m', count: 15 });
  assert.equal(result.endpoint, '/defi/v3/ohlcv/pair');
  assert.equal(result.normalized.source, 'pair_ohlcv');
  assert.equal(result.normalized.pairAddress, 'StubPair1111111111111111111111111111111111');
  assert.equal(result.candles.length, 1);
});

test('Birdeye token tx helper exposes pair id for entry candle fallback', async () => {
  const atMs = 1_779_024_600_000;
  const result = await fetchBirdeyeTokenTxs('StubMint111111111111111111111111111111111', { atMs, interval: '1m', count: 15 });
  assert.equal(result.pairAddress, 'StubPair1111111111111111111111111111111111');
  assert.equal(result.txs.length, 2);
  assert.equal(result.candles.length, 1);
});

test('entry candles fall back from empty token OHLCV to pair OHLCV', async () => {
  process.env.CHARON_PROVIDER_STUB_EMPTY_TOKEN_OHLCV = 'true';
  const atMs = 1_779_024_600_000;
  let result;
  try {
    result = await fetchBirdeyeEntryCandles('StubMint111111111111111111111111111111111', { atMs, interval: '1m', count: 15, minCandles: 1 });
  } finally {
    process.env.CHARON_PROVIDER_STUB_EMPTY_TOKEN_OHLCV = 'false';
  }
  assert.equal(result.source, 'pair_ohlcv');
  assert.deepEqual(result.fallbackTrace, ['token_ohlcv_empty', 'token_txs_pair_lookup', 'pair_ohlcv']);
  assert.equal(result.tokenOhlcvCount, 0);
  assert.equal(result.tokenTxCount, 2);
  assert.equal(result.candles.length, 1);
});

test('GMGN kline normalizes sparse 1m candles and writes provider ledger', async () => {
  initDb();
  setDbSetting('gmgn_kline_enabled', 'true');
  process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT = '8';
  const mint = 'GmgnKlineMint11111111111111111111111111111';
  const atMs = 1_779_024_600_000;
  try {
    const result = await fetchGmgnKline(mint, { atMs, interval: '1m', count: 15 });
    assert.equal(result.endpoint, '/v1/market/token_kline');
    assert.equal(result.source, 'gmgn_kline');
    assert.equal(result.candles.length, 8);
    assert.equal(result.candles[0].type, '1m');
    assert.equal(result.candles[0].source, 'gmgn_kline');
    assert.equal(result.normalized.source, 'gmgn_kline');

    const ledger = db.prepare("SELECT provider, endpoint, status, native_cost_unit_kind, native_cost_unit_estimate FROM provider_call_ledger WHERE mint = ? AND provider = 'gmgn' ORDER BY id DESC LIMIT 1").get(mint);
    assert.equal(ledger.endpoint, '/v1/market/token_kline');
    assert.equal(ledger.status, 'ok');
    assert.equal(ledger.native_cost_unit_kind, 'gmgn_kline_weight');
    assert.equal(ledger.native_cost_unit_estimate, 2);
  } finally {
    delete process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT;
  }
});

test('entry candles use GMGN fallback when Birdeye returns insufficient candles', async () => {
  initDb();
  setDbSetting('gmgn_kline_enabled', 'true');
  setDbSetting('entry_confirm_ohlcv_provider_order', 'birdeye,gmgn');
  process.env.CHARON_PROVIDER_STUB_EMPTY_OHLCV = 'true';
  process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT = '8';
  const mint = 'GmgnFallbackMint1111111111111111111111111111';
  const atMs = 1_779_024_600_000;
  try {
    const result = await fetchEntryCandles(mint, { atMs, interval: '1m', count: 15, minCandles: 5 });
    assert.equal(result.provider, 'gmgn');
    assert.equal(result.source, 'gmgn_kline');
    assert.equal(result.gmgnKlineCount, 8);
    assert.equal(result.fallbackTrace.some(step => step.startsWith('birdeye:')), true);
    assert.equal(result.fallbackTrace.includes('gmgn_kline'), true);
  } finally {
    process.env.CHARON_PROVIDER_STUB_EMPTY_OHLCV = 'false';
    delete process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT;
  }
});

test('collector falls back to token transactions when token OHLCV is empty', async () => {
  initDb();
  process.env.CHARON_PROVIDER_STUB_EMPTY_OHLCV = 'true';
  const candidate = fixtureCandidate({ mint: 'TxFallbackMint111111111111111111111111111' });
  queueCandidateObservation({
    candidate,
    candidateId: 100,
    stage: 'candidate_filter',
    action: 'passed',
  });

  let result;
  try {
    result = await runTelemetryCollector({ limit: 5 });
  } finally {
    process.env.CHARON_PROVIDER_STUB_EMPTY_OHLCV = 'false';
  }
  assert.equal(result.observedCount >= 1, true);
  assert.equal(result.providerOkCount >= 4, true);

  const observation = db.prepare('SELECT * FROM token_observations WHERE mint = ?').get(candidate.token.mint);
  assert.equal(observation.ohlcv_interval, '1m');
  assert.equal(observation.ohlcv_open, 0.0001);
  assert.equal(observation.ohlcv_close, 0.00015);
  assert.equal(observation.ohlcv_volume, 30);
  const qualityFlags = JSON.parse(observation.quality_flags_json);
  assert.equal(qualityFlags.candleSource, 'token_txs');
  assert.equal(qualityFlags.ohlcvAvailable, true);
  assert.equal(qualityFlags.activeCandle, true);

  const tokenTxsLedger = db.prepare("SELECT cache_key FROM provider_call_ledger WHERE mint = ? AND endpoint = '/defi/v3/token/txs' ORDER BY id DESC LIMIT 1").get(candidate.token.mint);
  assert.match(tokenTxsLedger.cache_key, /interval=1m;tx_type=swap/);
});

test('outcome_ohlcv mode collects only OHLCV and postpones rows after the daily cap', async () => {
  initDb();
  db.prepare("UPDATE token_observation_queue SET status = 'observed', watch_status = 'complete' WHERE status IN ('pending', 'leased')").run();
  const before = birdeyeNetworkCallsToday();
  setDbSetting('telemetry_collector_mode', 'outcome_ohlcv');
  setDbSetting('telemetry_birdeye_endpoints', '');
  setDbSetting('telemetry_birdeye_token_tx_fallback_enabled', 'false');
  setDbSetting('telemetry_birdeye_daily_call_cap', before + 1);
  setDbSetting('telemetry_min_watch_tier', 'A');
  setDbSetting('telemetry_min_observe_age_ms', '0');
  try {
    const first = fixtureCandidate({ mint: 'OutcomeOnlyMint11111111111111111111111111' });
    const second = fixtureCandidate({ mint: 'OutcomeCapMint111111111111111111111111111' });
    queueCandidateObservation({
      candidate: first,
      candidateId: 101,
      stage: 'candidate_filter',
      action: 'passed',
    });
    queueCandidateObservation({
      candidate: second,
      candidateId: 102,
      stage: 'candidate_filter',
      action: 'passed',
    });

    const result = await runTelemetryCollector({ limit: 2 });
    assert.equal(result.providerOkCount, 1);
    assert.equal(result.budgetSkipCount, 1);

    const firstLedger = db.prepare('SELECT endpoint, status FROM provider_call_ledger WHERE mint = ? ORDER BY id').all(first.token.mint);
    assert.deepEqual(firstLedger.map(row => `${row.endpoint}:${row.status}`), ['/defi/v3/ohlcv:ok']);
    const firstObservation = db.prepare('SELECT * FROM token_observations WHERE mint = ?').get(first.token.mint);
    assert.equal(firstObservation.provider_set, 'birdeye_ohlcv');
    assert.equal(firstObservation.ohlcv_interval, '1m');

    const secondLedger = db.prepare('SELECT endpoint, status, skip_reason FROM provider_call_ledger WHERE mint = ? ORDER BY id').all(second.token.mint);
    assert.equal(secondLedger.some(row => row.endpoint === 'budget_policy' && row.status === 'skipped' && row.skip_reason === 'birdeye_daily_call_cap_reached'), true);
    const secondRow = db.prepare('SELECT status, next_observe_at_ms FROM token_observation_queue WHERE mint = ?').get(second.token.mint);
    assert.equal(secondRow.status, 'pending');
    assert.equal(secondRow.next_observe_at_ms > Date.now(), true);
  } finally {
    setDbSetting('telemetry_collector_mode', 'full');
    setDbSetting('telemetry_birdeye_endpoints', '');
    setDbSetting('telemetry_birdeye_token_tx_fallback_enabled', 'true');
    setDbSetting('telemetry_birdeye_daily_call_cap', '0');
    setDbSetting('telemetry_min_watch_tier', 'C');
    setDbSetting('telemetry_min_observe_age_ms', '0');
  }
});

test('scout LLM throttle telemetry stores normalized action and detailed eligibility reason', () => {
  initDb();
  assert.equal(validateDecisionStage('scout_llm_admission'), 'scout_llm_admission');
  assert.equal(validateDecisionAction('scout_llm_throttle_skipped'), 'scout_llm_throttle_skipped');
  const candidate = fixtureCandidate({ mint: 'ScoutThrottleMint1111111111111111111111111' });
  queueCandidateObservation({
    candidate,
    candidateId: 103,
    stage: 'scout_llm_admission',
    action: 'scout_llm_throttle_skipped',
    eligibilityReason: 'scout_llm_throttle:cooldown_skip',
  });
  const row = db.prepare(`
    SELECT decision_stage, decision_action, eligibility_reason
    FROM token_observation_queue
    WHERE mint = ?
  `).get(candidate.token.mint);

  assert.equal(row.decision_stage, 'scout_llm_admission');
  assert.equal(row.decision_action, 'scout_llm_throttle_skipped');
  assert.equal(row.eligibility_reason, 'scout_llm_throttle:cooldown_skip');
});

test('Birdeye token transaction candle normalizer builds current 5m candle', async () => {
  const atMs = 1_779_024_600_000;
  const result = await fetchBirdeyeTokenTxCandle('StubMint111111111111111111111111111111111', { atMs, interval: '5m' });
  assert.equal(result.normalized.interval, '5m');
  assert.equal(result.normalized.source, 'token_txs');
  assert.equal(result.normalized.open, 0.0001);
  assert.equal(result.normalized.close, 0.00015);
  assert.equal(result.normalized.high, 0.00015);
  assert.equal(result.normalized.low, 0.0001);
  assert.equal(result.normalized.volume, 30);
});

test('doctor treats old provider errors as history, not active blockers', () => {
  initDb();
  const atMs = Date.now() + 10 * 60_000;
  insertProviderCall({
    atMs: atMs - 60 * 60_000,
    provider: 'birdeye',
    endpoint: '/defi/v3/token/market-data',
    mint: 'OldErrorMint111111111111111111111111111111',
    status: 'error',
    errorClass: 'http_401',
    errorMessage: 'old failure',
  });
  let doctor = telemetryDoctorSummary({
    atMs,
    limit: 10,
    staleCollectorMs: 24 * 60 * 60_000,
    providerErrorWindowMs: 15 * 60_000,
  });
  assert.equal(doctor.blockers.includes('provider_errors'), false);
  assert.equal(doctor.provider_errors.length, 0);
  assert.equal(doctor.provider_error_history.some(row => row.error_class === 'http_401'), true);

  insertProviderCall({
    atMs: atMs - 1000,
    provider: 'birdeye',
    endpoint: '/defi/v3/token/market-data',
    mint: 'RecentErrorMint111111111111111111111111111',
    status: 'error',
    errorClass: 'http_429',
    errorMessage: 'recent failure',
  });
  db.prepare(`
    INSERT INTO telemetry_collector_runs (
      started_at_ms, finished_at_ms, collector_id, status, provider_error_count, summary_json
    ) VALUES (?, ?, 'test-collector-with-error', 'error', 1, '{}')
  `).run(atMs - 2000, atMs - 500);
  doctor = telemetryDoctorSummary({
    atMs,
    limit: 10,
    staleCollectorMs: 24 * 60 * 60_000,
    providerErrorWindowMs: 15 * 60_000,
  });
  assert.equal(doctor.blockers.includes('provider_errors'), true);
  assert.equal(doctor.provider_errors.some(row => row.error_class === 'http_429'), true);

  db.prepare(`
    INSERT INTO telemetry_collector_runs (
      started_at_ms, collector_id, status, summary_json
    ) VALUES (?, 'test-collector-running', 'running', '{}')
  `).run(atMs + 1);
  doctor = telemetryDoctorSummary({
    atMs: atMs + 2,
    limit: 10,
    staleCollectorMs: 24 * 60 * 60_000,
    providerErrorWindowMs: 15 * 60_000,
  });
  assert.equal(doctor.blockers.includes('provider_errors'), true);
  assert.equal(doctor.latest_run_provider_error_count, 1);

  db.prepare(`
    INSERT INTO telemetry_collector_runs (
      started_at_ms, finished_at_ms, collector_id, status, summary_json
    ) VALUES (?, ?, 'test-collector', 'ok', '{}')
  `).run(atMs, atMs + 1);
  doctor = telemetryDoctorSummary({
    atMs: atMs + 2,
    limit: 10,
    staleCollectorMs: 24 * 60 * 60_000,
    providerErrorWindowMs: 15 * 60_000,
  });
  assert.equal(doctor.blockers.includes('provider_errors'), false);
  assert.equal(doctor.provider_errors.some(row => row.error_class === 'http_429'), true);
  assert.equal(doctor.provider_error_history.some(row => row.error_class === 'http_429'), true);
});

test('doctor treats fresh overdue queue as backlog warning until grace expires', () => {
  initDb();
  db.prepare("UPDATE token_observation_queue SET status = 'observed', watch_status = 'complete'").run();
  const atMs = Date.now() + 20 * 60_000;
  db.prepare(`
    INSERT INTO telemetry_collector_runs (
      started_at_ms, finished_at_ms, collector_id, status, summary_json
    ) VALUES (?, ?, 'overdue-test-collector', 'ok', '{}')
  `).run(atMs - 5000, atMs - 4000);
  const candidate = fixtureCandidate({ mint: 'OverdueMint111111111111111111111111111111' });
  queueCandidateObservation({
    candidate,
    candidateId: 123,
    stage: 'candidate_filter',
    action: 'passed',
    atMs: atMs - 60_000,
  });
  db.prepare("UPDATE token_observation_queue SET next_observe_at_ms = ?, status = 'pending' WHERE mint = ?")
    .run(atMs - 60_000, candidate.token.mint);

  let doctor = telemetryDoctorSummary({
    atMs,
    limit: 10,
    staleCollectorMs: 24 * 60 * 60_000,
    overdueGraceMs: 10 * 60_000,
  });
  assert.equal(doctor.overdue_queue_rows > 0, true);
  assert.equal(doctor.overdue_backlog_warning, true);
  assert.equal(doctor.blockers.includes('overdue_queue_rows'), false);

  doctor = telemetryDoctorSummary({
    atMs: atMs + 11 * 60_000,
    limit: 10,
    staleCollectorMs: 24 * 60 * 60_000,
    overdueGraceMs: 10 * 60_000,
  });
  assert.equal(doctor.overdue_backlog_warning, false);
  assert.equal(doctor.blockers.includes('overdue_queue_rows'), true);

  doctor = telemetryDoctorSummary({
    atMs,
    limit: 10,
    staleCollectorMs: 1000,
    overdueGraceMs: 10 * 60_000,
  });
  assert.equal(doctor.stale_collector, true);
  assert.equal(doctor.overdue_backlog_warning, false);
  assert.equal(doctor.blockers.includes('overdue_queue_rows'), true);
});
