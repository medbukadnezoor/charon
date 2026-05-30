import assert from 'node:assert/strict';
import test from 'node:test';

import { computeOhlcvSignals, computeStrictEntryShadowPolicy } from '../src/analysis/ohlcvSignals.js';

function candle(id, open, high, low, close, extra = {}) {
  return {
    observed_at_ms: id * 1000,
    ohlcv_open: open,
    ohlcv_high: high,
    ohlcv_low: low,
    ohlcv_close: close,
    ohlcv_finalized: 1,
    ...extra,
  };
}

test('computeOhlcvSignals uses high for ATH and respects as-of cutoff', () => {
  const rows = [
    candle(1, 100, 110, 99, 105),
    candle(2, 105, 150, 104, 120),
    candle(3, 120, 121, 70, 72),
    candle(4, 72, 80, 60, 62),
    candle(5, 62, 70, 58, 60),
    candle(6, 60, 74, 59, 66),
    candle(7, 66, 500, 65, 400),
  ];

  const signals = computeOhlcvSignals(rows, { asOfMs: 6000 });

  assert.equal(signals.ohlcv_coverage_status, 'sparse');
  assert.equal(signals.ath_high, 150);
  assert.equal(Math.round(signals.ath_distance_pct), -56);
  assert.equal(signals.in_fib_618_zone, true);
  assert.equal(signals.three_candle_dip_confirmed, true);
});

test('computeOhlcvSignals excludes untimestamped rows when as-of cutoff is provided', () => {
  const signals = computeOhlcvSignals([
    candle(1, 100, 110, 99, 105),
    candle(2, 105, 150, 104, 120),
    candle(3, 120, 121, 70, 72),
    candle(4, 72, 80, 60, 62),
    candle(5, 62, 70, 58, 60),
    candle(6, 60, 74, 59, 66),
    {
      ohlcv_open: 66,
      ohlcv_high: 999,
      ohlcv_low: 65,
      ohlcv_close: 990,
      ohlcv_finalized: 1,
    },
  ], { asOfMs: 6000 });

  assert.equal(signals.ath_high, 150);
  assert.equal(Math.round(signals.ath_distance_pct), -56);
  assert.equal(signals.in_fib_618_zone, true);
});

test('computeOhlcvSignals detects trailing staircase warning without future rows', () => {
  const rows = [
    candle(1, 100, 103, 100, 102),
    candle(2, 102, 105, 102, 104),
    candle(3, 104, 107, 104, 106),
    candle(4, 106, 109, 106, 108),
    candle(5, 108, 111, 108, 110),
    candle(6, 110, 113, 110, 112),
  ];

  const signals = computeOhlcvSignals(rows, {
    asOfMs: 6000,
    pullbackThresholdPct: 20,
    staircaseWarningThreshold: 5,
  });

  assert.equal(signals.staircase_without_pullback_n, 6);
  assert.equal(signals.staircase_warning, true);
});

test('computeOhlcvSignals reports unsupported when finalized OHLCV is absent', () => {
  const signals = computeOhlcvSignals([
    candle(1, 1, 2, 1, 2, { ohlcv_finalized: 0 }),
    { observed_at_ms: 2000, market_cap_usd: 1000 },
  ]);

  assert.equal(signals.ohlcv_coverage_status, 'unsupported');
  assert.equal(signals.ath_high, null);
  assert.equal(signals.staircase_warning, null);
});

test('computeStrictEntryShadowPolicy flags weak live-entry confirmation without blocking original signal', () => {
  const policy = computeStrictEntryShadowPolicy({
    confirm: true,
    score: 50,
    candle_count: 14,
    rsi: null,
    vwap_position: 'below',
    volume_trend: 'increasing',
    candle_structure: 'mixed',
    candle_source: 'pair_ohlcv',
  }, {
    mcapDisagreementPercent: 140.5,
  });

  assert.equal(policy.pass, false);
  assert.deepEqual(policy.reasons, [
    'strict_score_low',
    'strict_insufficient_candles',
    'strict_rsi_unavailable',
    'strict_mcap_disagreement',
  ]);
  assert.equal(policy.observed.originalConfirm, true);
  assert.equal(policy.observed.mcapDisagreementPercent, 140.5);
});

test('computeStrictEntryShadowPolicy reports every strict fail reason deterministically', () => {
  const policy = computeStrictEntryShadowPolicy({
    confirm: false,
    reject_reason: 'score_low',
    score: 42,
    candle_count: 3,
    rsi: 74.5,
    vwap_position: 'above',
    volume_trend: 'fading',
    candle_structure: 'rejection',
    candle_source: 'gmgn_kline',
  }, {
    minScore: 60,
    minCandles: 15,
    maxRsi: 70,
    mcapDisagreementPercent: 101,
    maxMcapDisagreementPercent: 100,
  });

  assert.equal(policy.pass, false);
  assert.deepEqual(policy.reasons, [
    'strict_score_low',
    'strict_insufficient_candles',
    'strict_rsi_overbought',
    'strict_mcap_disagreement',
  ]);
  assert.equal(policy.observed.originalConfirm, false);
  assert.equal(policy.observed.originalRejectReason, 'score_low');
  assert.equal(policy.observed.rsi, 74.5);
});

test('computeStrictEntryShadowPolicy passes full candle coverage with bounded RSI and mcap agreement', () => {
  const policy = computeStrictEntryShadowPolicy({
    confirm: true,
    score: 65,
    candle_count: 15,
    rsi: 56,
    vwap_position: 'at',
    volume_trend: 'mixed',
    candle_structure: 'mixed',
    candle_source: 'pair_ohlcv',
  }, {
    mcapDisagreementPercent: 21.4,
  });

  assert.equal(policy.pass, true);
  assert.deepEqual(policy.reasons, []);
});
