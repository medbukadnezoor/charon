import assert from 'node:assert/strict';
import test from 'node:test';

import {
  joinObservations,
  joinScreeningBlockers,
  materializeOutcomes,
} from '../src/analysis/runnerOutcomes.js';

class FakeDb {
  constructor({
    signalEvents = [],
    screeningEvents = [],
    candidates = [],
    tokenObservations = null,
    tokenObservationColumns = null,
  } = {}) {
    this.tables = new Map([
      ['signal_events', signalEvents],
      ['screening_events', screeningEvents],
      ['candidates', candidates],
    ]);
    this.columns = new Map([
      ['signal_events', ['id', 'mint', 'kind', 'at_ms', 'source', 'payload_json']],
      ['screening_events', ['id', 'mint', 'at_ms', 'stage', 'action', 'reason_code']],
      ['candidates', ['id', 'mint', 'status', 'created_at_ms', 'updated_at_ms', 'candidate_json', 'filter_result_json']],
    ]);
    if (tokenObservations) {
      this.tables.set('token_observations', tokenObservations);
      this.columns.set('token_observations', tokenObservationColumns || ['id', 'mint', 'observed_at_ms', 'market_cap_usd']);
    }
  }

  prepare(sql) {
    if (/sqlite_master/.test(sql)) {
      return {
        get: tableName => (this.tables.has(tableName) ? { name: tableName } : undefined),
      };
    }

    const pragmaMatch = sql.match(/PRAGMA table_info\(([^)]+)\)/);
    if (pragmaMatch) {
      return {
        all: () => (this.columns.get(pragmaMatch[1]) || []).map(name => ({ name })),
      };
    }

    if (/FROM signal_events/.test(sql)) {
      return {
        all: () => [...this.tables.get('signal_events')]
          .sort((a, b) => a.mint.localeCompare(b.mint) || (a.at_ms - b.at_ms) || (a.id - b.id)),
      };
    }

    if (/FROM screening_events/.test(sql)) {
      return {
        all: (mint, startMs, endMs, firstSeenMs) => [...this.tables.get('screening_events')]
          .filter(row => row.mint === mint)
          .filter(row => row.at_ms >= startMs && row.at_ms <= endMs)
          .filter(row => row.reason_code != null)
          .sort((a, b) => (
            Math.abs(a.at_ms - firstSeenMs) - Math.abs(b.at_ms - firstSeenMs)
          ) || (a.at_ms - b.at_ms) || (a.id - b.id)),
      };
    }

    if (/FROM candidates/.test(sql)) {
      return {
        all: () => [...this.tables.get('candidates')]
          .sort((a, b) => a.mint.localeCompare(b.mint) || (a.updated_at_ms - b.updated_at_ms) || (a.id - b.id)),
      };
    }

    if (/FROM token_observations/.test(sql)) {
      return {
        all: () => [...this.tables.get('token_observations')]
          .sort((a, b) => a.mint.localeCompare(b.mint) || (a.observed_at_ms - b.observed_at_ms) || (a.id - b.id)),
      };
    }

    throw new Error(`Unexpected SQL in test fake: ${sql}`);
  }
}

test('joinScreeningBlockers chooses nearest blockers around first sighting', () => {
  const db = new FakeDb({
    screeningEvents: [
      { id: 1, at_ms: 900, mint: 'MintA', stage: 'early_signal_gate', action: 'skipped', reason_code: 'before_nearest' },
      { id: 2, at_ms: 1250, mint: 'MintA', stage: 'early_signal_gate', action: 'skipped', reason_code: 'after_farther' },
      { id: 3, at_ms: 950, mint: 'MintA', stage: 'candidate_eval', action: 'accepted', reason_code: 'not_a_blocker' },
    ],
  });

  const outcomes = [{
    mint: 'MintA',
    first_seen_at_ms: 1000,
    screening_blockers: [],
    candidate_blockers: [],
    blocker_source: 'none',
  }];

  joinScreeningBlockers(outcomes, db, { windowMs: 300 });
  assert.deepEqual(outcomes[0].screening_blockers, ['before_nearest']);
  assert.equal(outcomes[0].blocker_source, 'screening_events');
});

test('materializeOutcomes falls back to candidate blockers only without screening blockers', () => {
  const db = new FakeDb({
    signalEvents: [
      {
        id: 1,
        mint: 'MintB',
        kind: 'jupiter_trending',
        at_ms: 1000,
        source: 'jupiter',
        payload_json: JSON.stringify({ symbol: 'MB', marketCapUsd: 10_000 }),
      },
      {
        id: 2,
        mint: 'MintB',
        kind: 'fee_claim',
        at_ms: 2000,
        source: 'fee_claim',
        payload_json: JSON.stringify({ symbol: 'MB', marketCapUsd: 35_000 }),
      },
    ],
    candidates: [{
      id: 1,
      mint: 'MintB',
      status: 'filtered',
      created_at_ms: 1100,
      updated_at_ms: 1200,
      candidate_json: JSON.stringify({
        savedWalletExposure: {
          holderCount: 4,
          matchedWallets: [{
            address: '11111111111111111111111111111111',
            tier: 'A',
            tags: ['smart_degen'],
          }],
        },
      }),
      filter_result_json: JSON.stringify({ failureCodes: ['candidate_only_blocker'] }),
    }],
  });

  const { outcomes } = materializeOutcomes(db);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].multiple, 3.5);
  assert.equal(outcomes[0].first_saved_wallet_hits, 4);
  assert.equal(outcomes[0].candidate_wallet_address_count, 1);
  assert.equal(outcomes[0].candidate_tier_a_wallet_count, 1);
  assert.equal(outcomes[0].candidate_best_wallet_tier, 'A');
  assert.equal(outcomes[0].candidate_smart_degen_present, 1);
  assert.deepEqual(outcomes[0].screening_blockers, []);
  assert.deepEqual(outcomes[0].candidate_blockers, ['candidate_only_blocker']);
  assert.equal(outcomes[0].blocker_source, 'candidates.filter_result_json');
});

test('materializeOutcomes keeps screening blockers primary over candidate fallback', () => {
  const db = new FakeDb({
    signalEvents: [{
      id: 1,
      mint: 'MintC',
      kind: 'jupiter_trending',
      at_ms: 1000,
      source: 'jupiter',
      payload_json: JSON.stringify({ symbol: 'MC', marketCapUsd: 20_000 }),
    }],
    screeningEvents: [{
      id: 1,
      at_ms: 990,
      mint: 'MintC',
      stage: 'early_signal_gate',
      action: 'skipped',
      reason_code: 'screening_primary',
    }],
    candidates: [{
      id: 1,
      mint: 'MintC',
      status: 'filtered',
      created_at_ms: 1100,
      updated_at_ms: 1200,
      candidate_json: '{}',
      filter_result_json: JSON.stringify({ failureCodes: ['candidate_fallback'] }),
    }],
  });

  const { outcomes } = materializeOutcomes(db);
  assert.equal(outcomes.length, 1);
  assert.deepEqual(outcomes[0].screening_blockers, ['screening_primary']);
  assert.deepEqual(outcomes[0].candidate_blockers, ['candidate_fallback']);
  assert.equal(outcomes[0].blocker_source, 'screening_events');
});

test('joinObservations enriches outcomes without changing signal labels', () => {
  const db = new FakeDb({
    tokenObservations: [
      { id: 1, mint: 'MintObs', observed_at_ms: 1000, market_cap_usd: 10_000 },
      { id: 2, mint: 'MintObs', observed_at_ms: 1000 + 5 * 60_000, market_cap_usd: 15_000 },
      { id: 5, mint: 'MintObs', observed_at_ms: 1000 + 10 * 60_000, market_cap_usd: 12_000 },
      { id: 3, mint: 'MintObs', observed_at_ms: 1000 + 15 * 60_000, market_cap_usd: 45_000 },
      { id: 4, mint: 'MintObs', observed_at_ms: 1000 + 60 * 60_000, market_cap_usd: 30_000 },
    ],
  });
  const outcomes = [{
    mint: 'MintObs',
    first_seen_at_ms: 1000,
    first_mcap_usd: 10_000,
    max_mcap_usd: 19_000,
    multiple: 1.9,
    runner_label: 'sub-2x',
    has_observations: 0,
    observation_count: 0,
  }];

  joinObservations(outcomes, db);

  assert.equal(outcomes[0].has_observations, 1);
  assert.equal(outcomes[0].observation_count, 5);
  assert.equal(outcomes[0].obs_max_mcap_usd, 45_000);
  assert.equal(outcomes[0].obs_multiple, 4.5);
  assert.equal(outcomes[0].obs_runner_label, '3x-5x');
  assert.equal(outcomes[0].obs_runner_label_differs, 1);
  assert.equal(outcomes[0].obs_exceeds_signal_max, 1);
  assert.equal(Math.round(outcomes[0].obs_drawdown_before_peak_percent * 1000) / 1000, 0.2);
  assert.equal(outcomes[0].runner_label, 'sub-2x');
  assert.equal(outcomes[0].multiple, 1.9);
  assert.equal(outcomes[0].obs_mcap_5m_usd, 15_000);
  assert.equal(outcomes[0].obs_mcap_15m_usd, 45_000);
  assert.equal(outcomes[0].obs_mcap_30m_usd, 30_000);
  assert.equal(outcomes[0].ohlcv_coverage_status, 'unsupported');
  assert.equal(outcomes[0].gake_coverage_status, 'unsupported');
});

test('joinObservations attaches tier-1 derivable signals with as-of semantics', () => {
  const tokenObservationColumns = [
    'id',
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
  const db = new FakeDb({
    tokenObservationColumns,
    tokenObservations: [
      { id: 1, mint: 'MintTier1', observed_at_ms: 1000, market_cap_usd: 10_000, ohlcv_open: 100, ohlcv_high: 110, ohlcv_low: 99, ohlcv_close: 105, ohlcv_finalized: 1, saved_wallet_holders: 10, saved_wallet_strong_count: 4, saved_wallet_kol_count: 2 },
      { id: 2, mint: 'MintTier1', observed_at_ms: 2000, market_cap_usd: 11_000, ohlcv_open: 105, ohlcv_high: 150, ohlcv_low: 104, ohlcv_close: 120, ohlcv_finalized: 1, saved_wallet_holders: 20, saved_wallet_strong_count: 6, saved_wallet_kol_count: 4 },
      { id: 3, mint: 'MintTier1', observed_at_ms: 3000, market_cap_usd: 12_000, ohlcv_open: 120, ohlcv_high: 121, ohlcv_low: 70, ohlcv_close: 72, ohlcv_finalized: 1, saved_wallet_holders: 8, saved_wallet_strong_count: 2, saved_wallet_kol_count: 1 },
      { id: 4, mint: 'MintTier1', observed_at_ms: 4000, market_cap_usd: 13_000, ohlcv_open: 72, ohlcv_high: 80, ohlcv_low: 60, ohlcv_close: 62, ohlcv_finalized: 1, saved_wallet_holders: 7, saved_wallet_strong_count: 2, saved_wallet_kol_count: 1 },
      { id: 5, mint: 'MintTier1', observed_at_ms: 5000, market_cap_usd: 100_000, ohlcv_open: 62, ohlcv_high: 500, ohlcv_low: 58, ohlcv_close: 400, ohlcv_finalized: 1, saved_wallet_holders: 100, saved_wallet_strong_count: 20, saved_wallet_kol_count: 20 },
    ],
  });
  const outcomes = [{
    mint: 'MintTier1',
    first_seen_at_ms: 4000,
    first_mcap_usd: 10_000,
    max_mcap_usd: 13_000,
    multiple: 1.3,
    runner_label: 'sub-2x',
    has_observations: 0,
    observation_count: 0,
  }];

  joinObservations(outcomes, db);

  assert.equal(outcomes[0].ohlcv_coverage_status, 'sparse');
  assert.equal(outcomes[0].ath_high, 150);
  assert.equal(outcomes[0].gake_coverage_status, 'ok');
  assert.equal(outcomes[0].gake_peak_holders, 20);
  assert.equal(outcomes[0].gake_current_holders, 7);
  assert.equal(outcomes[0].obs_max_mcap_usd, 100_000);
});

test('materializeOutcomes tolerates missing token_observations table', () => {
  const db = new FakeDb({
    signalEvents: [{
      id: 1,
      mint: 'MintNoObs',
      kind: 'jupiter_trending',
      at_ms: 1000,
      source: 'jupiter',
      payload_json: JSON.stringify({ symbol: 'NOOBS', marketCapUsd: 10_000 }),
    }],
  });

  const { outcomes, warnings } = materializeOutcomes(db);

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].has_observations, 0);
  assert.equal(outcomes[0].obs_max_mcap_usd, null);
  assert.equal(outcomes[0].ohlcv_coverage_status, 'unsupported');
  assert.equal(outcomes[0].gake_coverage_status, 'unsupported');
  assert.equal(outcomes[0].cabal_coverage_status, 'unsupported');
  assert.equal(warnings.some(warning => warning.includes('token_observations table missing')), true);
});

test('materializeOutcomes can skip observation join even when table exists', () => {
  const db = new FakeDb({
    signalEvents: [{
      id: 1,
      mint: 'MintSkipObs',
      kind: 'jupiter_trending',
      at_ms: 1000,
      source: 'jupiter',
      payload_json: JSON.stringify({ symbol: 'SKIP', marketCapUsd: 10_000 }),
    }],
    tokenObservations: [{
      id: 1,
      mint: 'MintSkipObs',
      observed_at_ms: 2000,
      market_cap_usd: 100_000,
    }],
  });

  const { outcomes, warnings } = materializeOutcomes(db, { skipObservations: true });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].has_observations, 0);
  assert.equal(outcomes[0].obs_max_mcap_usd, null);
  assert.equal(warnings.some(warning => warning.includes('observation join skipped')), true);
});
