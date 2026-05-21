import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILT_IN_RECIPES,
  evaluateBuiltInRecipes,
  evaluateRecipe,
  reportMetrics,
  summarizeConfusion,
} from '../src/analysis/filterEval.js';

const outcomes = [
  {
    mint: 'RunnerCaught',
    multiple: 4,
    time_to_peak_ms: 10 * 60_000,
    first_source_count: 2,
    first_mcap_usd: 100_000,
    first_age_ms: 20 * 60_000,
    first_saved_wallet_hits: 1,
    first_fee_claim_present: 1,
    first_graduated_present: 0,
    first_trending_source: 'dual_source',
    first_holders: 120,
    first_chart_high_dist: -55,
    screening_blockers: [],
    candidate_blockers: [],
    candidate_tier_a_wallet_count: 1,
    candidate_smart_degen_present: 1,
    candidate_wallet_quality_bucket: 'tier_a',
    candidate_has_recurring_runner_wallet: 1,
    staircase_warning: false,
    three_candle_dip_confirmed: true,
    ath_distance_pct: -56,
    gake_exit_pct: 10,
    cabal_burst_detected: false,
    single_source_spam: false,
  },
  {
    mint: 'RunnerMissed',
    multiple: 6,
    time_to_peak_ms: 30 * 60_000,
    first_source_count: 1,
    first_mcap_usd: 100_000,
    first_age_ms: 20 * 60_000,
    first_saved_wallet_hits: 0,
    first_fee_claim_present: 0,
    first_graduated_present: 1,
    first_trending_source: null,
    first_holders: 20,
    first_chart_high_dist: null,
    screening_blockers: [],
    candidate_blockers: [],
    candidate_tier_a_wallet_count: 0,
    candidate_smart_degen_present: 0,
    candidate_wallet_quality_bucket: 'no_wallet_evidence',
    candidate_has_recurring_runner_wallet: 0,
    staircase_warning: true,
    three_candle_dip_confirmed: false,
    ath_distance_pct: -20,
    gake_exit_pct: 60,
    cabal_burst_detected: true,
    single_source_spam: false,
  },
  {
    mint: 'FalsePositive',
    multiple: 1.4,
    time_to_peak_ms: 5 * 60_000,
    first_source_count: 3,
    first_mcap_usd: 80_000,
    first_age_ms: 10 * 60_000,
    first_saved_wallet_hits: 0,
    first_fee_claim_present: 0,
    first_graduated_present: 0,
    first_trending_source: 'dual_source',
    first_holders: 100,
    first_chart_high_dist: null,
    screening_blockers: [],
    candidate_blockers: [],
    candidate_tier_a_wallet_count: 0,
    candidate_smart_degen_present: 0,
    candidate_wallet_quality_bucket: 'tier_b',
    candidate_has_recurring_runner_wallet: 0,
    staircase_warning: false,
    three_candle_dip_confirmed: false,
    ath_distance_pct: -55,
    gake_exit_pct: null,
    cabal_burst_detected: false,
    single_source_spam: false,
  },
  {
    mint: 'TrueNegative',
    multiple: 1.2,
    time_to_peak_ms: 40 * 60_000,
    first_source_count: 1,
    first_mcap_usd: 700_000,
    first_age_ms: 90 * 60_000,
    first_saved_wallet_hits: 0,
    first_fee_claim_present: 0,
    first_graduated_present: 0,
    first_trending_source: null,
    first_holders: 0,
    first_chart_high_dist: null,
    screening_blockers: [],
    candidate_blockers: [],
    candidate_tier_a_wallet_count: 0,
    candidate_smart_degen_present: 0,
    candidate_wallet_quality_bucket: 'no_wallet_evidence',
    candidate_has_recurring_runner_wallet: 0,
    staircase_warning: null,
    three_candle_dip_confirmed: null,
    ath_distance_pct: null,
    gake_exit_pct: null,
    cabal_burst_detected: null,
    single_source_spam: null,
  },
];

test('evaluateRecipe returns TP/FP/FN/TN sets for thresholded runners', () => {
  const recipe = {
    name: 'test_recipe',
    predicates: [
      { field: 'first_source_count', op: 'gte', value: 2 },
      { field: 'first_mcap_usd', op: 'lt', value: 500_000 },
      { field: 'first_age_ms', op: 'lt', value: 60 * 60_000 },
    ],
  };

  const confusion = evaluateRecipe(recipe, outcomes, { threshold: 3 });
  assert.deepEqual(confusion.tp.map(row => row.mint), ['RunnerCaught']);
  assert.deepEqual(confusion.fp.map(row => row.mint), ['FalsePositive']);
  assert.deepEqual(confusion.fn.map(row => row.mint), ['RunnerMissed']);
  assert.deepEqual(confusion.tn.map(row => row.mint), ['TrueNegative']);
  assert.deepEqual(summarizeConfusion(confusion), {
    recipe_name: 'test_recipe',
    threshold: 3,
    tp: 1,
    fp: 1,
    fn: 1,
    tn: 1,
  });
});

test('reportMetrics computes precision recall F1 FPR and median caught TTP', () => {
  const confusion = evaluateRecipe({
    name: 'metrics_recipe',
    predicates: [{ field: 'first_mcap_usd', op: 'lt', value: 500_000 }],
  }, outcomes, { threshold: 3 });

  const metrics = reportMetrics(confusion);
  assert.equal(metrics.tp, 2);
  assert.equal(metrics.fp, 1);
  assert.equal(metrics.fn, 0);
  assert.equal(metrics.tn, 1);
  assert.equal(metrics.precision, 2 / 3);
  assert.equal(metrics.recall, 1);
  assert.equal(Math.round(metrics.f1 * 1000) / 1000, 0.8);
  assert.equal(metrics.false_positive_rate, 0.5);
  assert.equal(metrics.median_time_to_peak_ms, 20 * 60_000);
});

test('score recipes are data-driven and admit by weighted soft features', () => {
  const recipe = {
    name: 'soft_wallet_score',
    predicates: [],
    score: {
      min: 3,
      terms: [
        { field: 'first_source_count', op: 'gte', value: 2, weight: 1 },
        { field: 'first_mcap_usd', op: 'lt', value: 500_000, weight: 1 },
        { field: 'first_saved_wallet_hits', op: 'gte', value: 1, weight: 2 },
      ],
    },
  };

  const confusion = evaluateRecipe(recipe, outcomes, { threshold: 3 });
  assert.deepEqual(confusion.tp.map(row => row.mint), ['RunnerCaught']);
  assert.deepEqual(confusion.fp.map(row => row.mint), []);
});

test('built-in recipe set covers requested lanes at 2x 3x and 5x thresholds', () => {
  const names = new Set(BUILT_IN_RECIPES.map(recipe => recipe.name));
  assert.ok(names.has('broad_recall'));
  assert.ok([...names].some(name => name.startsWith('mcap_band_discovery_')));
  assert.ok(names.has('early_movement_age_lt_5m'));
  assert.ok(names.has('early_movement_age_lt_15m'));
  assert.ok(names.has('early_movement_age_lt_60m'));
  assert.ok(names.has('saved_wallet_feature_hard'));
  assert.ok(names.has('saved_wallet_hard_gate'));
  assert.ok(names.has('broad_recall_plus_tier_a_wallet'));
  assert.ok(names.has('broad_recall_plus_smart_degen'));
  assert.ok(names.has('broad_recall_plus_recurring_runner_wallet'));
  assert.ok(names.has('dual_source_plus_tier_a_wallet'));
  assert.ok(names.has('dual_source_plus_wallet_quality_high'));
  assert.ok(names.has('saved_wallet_feature_soft_score'));
  assert.ok(names.has('fee_graduated_fee_claim'));
  assert.ok(names.has('fee_graduated_graduated'));
  assert.ok(names.has('fee_graduated_both'));
  assert.ok(names.has('guide_early_runner_no_fee_risk_screen'));
  assert.ok(names.has('guide_fee_confirmed_microcap'));
  assert.ok(names.has('guide_wallet_confirmed_no_fee'));
  assert.ok(names.has('guide_anti_bundle_strict'));
  assert.ok(names.has('guide_dip_reentry_50_70_from_ath'));
  assert.ok(names.has('guide_staircase_warning_avoided'));
  assert.ok(names.has('guide_dip_with_active_gake'));
  assert.ok(names.has('guide_anti_cabal_strict'));

  const guideSources = new Map(BUILT_IN_RECIPES
    .filter(recipe => recipe.name.startsWith('guide_'))
    .map(recipe => [recipe.name, recipe.guide_source]));
  assert.deepEqual(Object.fromEntries(guideSources), {
    guide_early_runner_no_fee_risk_screen: 'ponyin',
    guide_fee_confirmed_microcap: 'ponyin',
    guide_wallet_confirmed_no_fee: 'sambelikan',
    guide_anti_bundle_strict: 'sambelikan',
    guide_dip_reentry_50_70_from_ath: 'sambelikan',
    guide_staircase_warning_avoided: 'sambelikan',
    guide_dip_with_active_gake: 'sambelikan',
    guide_anti_cabal_strict: 'ponyin',
  });

  const metrics = evaluateBuiltInRecipes(outcomes);
  assert.equal(metrics.length, BUILT_IN_RECIPES.length * 3);
  assert.deepEqual([...new Set(metrics.map(row => row.threshold))], [2, 3, 5]);
  assert.equal(metrics.find(row => row.recipe_name === 'guide_anti_cabal_strict').guide_source, 'ponyin');
});

test('wallet-aware built-in recipes admit and exclude through data predicates', () => {
  const byName = new Map(BUILT_IN_RECIPES.map(recipe => [recipe.name, recipe]));

  assert.deepEqual(
    evaluateRecipe(byName.get('broad_recall_plus_tier_a_wallet'), outcomes, { threshold: 3 }).tp.map(row => row.mint),
    ['RunnerCaught'],
  );
  assert.deepEqual(
    evaluateRecipe(byName.get('broad_recall_plus_tier_a_wallet'), outcomes, { threshold: 3 }).fp.map(row => row.mint),
    [],
  );

  const qualityHigh = evaluateRecipe(byName.get('dual_source_plus_wallet_quality_high'), outcomes, { threshold: 3 });
  assert.deepEqual(qualityHigh.tp.map(row => row.mint), ['RunnerCaught']);
  assert.deepEqual(qualityHigh.fp.map(row => row.mint), ['FalsePositive']);

  const recurring = evaluateRecipe(byName.get('broad_recall_plus_recurring_runner_wallet'), outcomes, { threshold: 3 });
  assert.deepEqual(recurring.tp.map(row => row.mint), ['RunnerCaught']);
  assert.deepEqual(recurring.fp.map(row => row.mint), []);
});

test('guide-derived recipes stay offline and use existing SRA WPA WFR feature columns', () => {
  const byName = new Map(BUILT_IN_RECIPES.map(recipe => [recipe.name, recipe]));
  const guideOutcomes = [
    {
      mint: 'CleanEarlyNoFeeRunner',
      multiple: 4,
      time_to_peak_ms: 20 * 60_000,
      first_source_count: 2,
      first_mcap_usd: 40_000,
      first_age_ms: 12 * 60_000,
      first_fee_claim_present: 0,
      first_trending_source: 'jupiter_trending',
      first_holders: 90,
      first_saved_wallet_hits: 0,
      first_chart_high_dist: null,
      screening_blockers: [],
      candidate_blockers: [],
      candidate_wallet_quality_bucket: 'no_wallet_evidence',
      staircase_warning: false,
      ath_distance_pct: -10,
      gake_exit_pct: null,
      cabal_burst_detected: false,
      single_source_spam: false,
    },
    {
      mint: 'BundledEarlyRunner',
      multiple: 5,
      time_to_peak_ms: 15 * 60_000,
      first_source_count: 2,
      first_mcap_usd: 45_000,
      first_age_ms: 10 * 60_000,
      first_fee_claim_present: 0,
      first_trending_source: 'jupiter_trending',
      first_holders: 110,
      first_saved_wallet_hits: 0,
      first_chart_high_dist: null,
      screening_blockers: ['trending_max_bundler_rate'],
      candidate_blockers: [],
      candidate_wallet_quality_bucket: 'no_wallet_evidence',
      staircase_warning: false,
      ath_distance_pct: -15,
      gake_exit_pct: null,
      cabal_burst_detected: false,
      single_source_spam: false,
    },
    {
      mint: 'WalletNoFeeRunner',
      multiple: 6,
      time_to_peak_ms: 25 * 60_000,
      first_source_count: 2,
      first_mcap_usd: 120_000,
      first_age_ms: 20 * 60_000,
      first_fee_claim_present: 0,
      first_trending_source: 'dual_source',
      first_holders: 150,
      first_saved_wallet_hits: 1,
      first_chart_high_dist: null,
      screening_blockers: [],
      candidate_blockers: [],
      candidate_wallet_quality_bucket: 'tier_b',
      staircase_warning: false,
      ath_distance_pct: -20,
      gake_exit_pct: 5,
      cabal_burst_detected: false,
      single_source_spam: false,
    },
    {
      mint: 'FeeMicrocapRunner',
      multiple: 4,
      time_to_peak_ms: 35 * 60_000,
      first_source_count: 2,
      first_mcap_usd: 180_000,
      first_age_ms: 25 * 60_000,
      first_fee_claim_present: 1,
      first_trending_source: 'dual_source',
      first_holders: 130,
      first_saved_wallet_hits: 0,
      first_chart_high_dist: null,
      screening_blockers: [],
      candidate_blockers: [],
      candidate_wallet_quality_bucket: 'no_wallet_evidence',
      staircase_warning: false,
      ath_distance_pct: -25,
      gake_exit_pct: null,
      cabal_burst_detected: false,
      single_source_spam: false,
    },
    {
      mint: 'DipReentryRunner',
      multiple: 3.5,
      time_to_peak_ms: 8 * 60_000,
      first_source_count: 1,
      first_mcap_usd: 250_000,
      first_age_ms: 3 * 60 * 60_000,
      first_fee_claim_present: 1,
      first_trending_source: null,
      first_holders: 400,
      first_saved_wallet_hits: 0,
      first_chart_high_dist: -60,
      screening_blockers: [],
      candidate_blockers: [],
      candidate_wallet_quality_bucket: 'no_wallet_evidence',
      staircase_warning: false,
      ath_distance_pct: -60,
      gake_exit_pct: 10,
      cabal_burst_detected: false,
      single_source_spam: false,
    },
  ];

  const early = evaluateRecipe(byName.get('guide_early_runner_no_fee_risk_screen'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(early.tp.map(row => row.mint), ['CleanEarlyNoFeeRunner', 'WalletNoFeeRunner', 'FeeMicrocapRunner']);
  assert.ok(!early.tp.some(row => row.mint === 'BundledEarlyRunner'));

  const walletNoFee = evaluateRecipe(byName.get('guide_wallet_confirmed_no_fee'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(walletNoFee.tp.map(row => row.mint), ['WalletNoFeeRunner']);

  const feeMicrocap = evaluateRecipe(byName.get('guide_fee_confirmed_microcap'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(feeMicrocap.tp.map(row => row.mint), ['FeeMicrocapRunner']);

  const strict = evaluateRecipe(byName.get('guide_anti_bundle_strict'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(strict.tp.map(row => row.mint), ['WalletNoFeeRunner']);

  const dip = evaluateRecipe(byName.get('guide_dip_reentry_50_70_from_ath'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(dip.tp.map(row => row.mint), ['DipReentryRunner']);

  const staircase = evaluateRecipe(byName.get('guide_staircase_warning_avoided'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(staircase.tp.map(row => row.mint), [
    'CleanEarlyNoFeeRunner',
    'BundledEarlyRunner',
    'WalletNoFeeRunner',
    'FeeMicrocapRunner',
  ]);

  const activeGake = evaluateRecipe(byName.get('guide_dip_with_active_gake'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(activeGake.tp.map(row => row.mint), ['DipReentryRunner']);

  const antiCabal = evaluateRecipe(byName.get('guide_anti_cabal_strict'), guideOutcomes, { threshold: 3 });
  assert.deepEqual(antiCabal.tp.map(row => row.mint), [
    'CleanEarlyNoFeeRunner',
    'WalletNoFeeRunner',
    'FeeMicrocapRunner',
  ]);
});

test('tier-1 custom predicate ops handle sparse values without throwing', () => {
  const recipe = {
    name: 'tier1_predicates',
    predicates: [
      { field: 'staircase_warning', op: 'staircase_warning_absent' },
      { field: 'three_candle_dip_confirmed', op: 'three_candle_dip_confirmed_present' },
      { field: 'ath_distance_pct', op: 'ath_distance_in_range', value: { min_pct: -70, max_pct: -50 } },
      { field: 'gake_exit_pct', op: 'gake_exit_below_threshold', value: 30 },
      { field: 'cabal_burst_detected', op: 'cabal_burst_absent' },
    ],
  };

  const confusion = evaluateRecipe(recipe, outcomes, { threshold: 3 });
  assert.deepEqual(confusion.tp.map(row => row.mint), ['RunnerCaught']);
  assert.deepEqual(confusion.fp.map(row => row.mint), []);
});
