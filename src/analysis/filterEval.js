const DEFAULT_THRESHOLD = 3;

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function valueFor(outcome, field) {
  return field.split('.').reduce((current, key) => current?.[key], outcome);
}

function compare(value, op, expected) {
  const actualNumber = finiteNumber(value);
  const expectedNumber = finiteNumber(expected);

  switch (op) {
    case 'exists':
      return value != null && value !== '';
    case 'missing':
      return value == null || value === '';
    case 'eq':
      return value === expected;
    case 'neq':
      return value !== expected;
    case 'gt':
      return actualNumber != null && expectedNumber != null && actualNumber > expectedNumber;
    case 'gte':
      return actualNumber != null && expectedNumber != null && actualNumber >= expectedNumber;
    case 'lt':
      return actualNumber != null && expectedNumber != null && actualNumber < expectedNumber;
    case 'lte':
      return actualNumber != null && expectedNumber != null && actualNumber <= expectedNumber;
    case 'between':
      return actualNumber != null
        && finiteNumber(expected?.min) != null
        && finiteNumber(expected?.max) != null
        && actualNumber >= Number(expected.min)
        && actualNumber < Number(expected.max);
    case 'in':
      return Array.isArray(expected) && expected.includes(value);
    case 'contains':
      return Array.isArray(value) && value.includes(expected);
    case 'not_contains':
      return !Array.isArray(value) || !value.includes(expected);
    case 'staircase_warning_absent':
      return value === false;
    case 'three_candle_dip_confirmed_present':
      return value === true;
    case 'ath_distance_in_range':
      return actualNumber != null
        && finiteNumber(expected?.min_pct) != null
        && finiteNumber(expected?.max_pct) != null
        && actualNumber >= Number(expected.min_pct)
        && actualNumber <= Number(expected.max_pct);
    case 'gake_exit_below_threshold':
      return value == null || (actualNumber != null && expectedNumber != null && actualNumber < expectedNumber);
    case 'cabal_burst_absent':
      return value === false;
    default:
      throw new Error(`Unsupported recipe predicate op: ${op}`);
  }
}

function matchesPredicate(predicate, outcome) {
  return compare(valueFor(outcome, predicate.field), predicate.op, predicate.value);
}

function scoreRecipe(recipe, outcome) {
  const terms = recipe.score?.terms || [];
  return terms.reduce((score, term) => (
    matchesPredicate(term, outcome) ? score + Number(term.weight || 1) : score
  ), 0);
}

function recipeAdmits(recipe, outcome) {
  const predicates = recipe.predicates || [];
  const gatesPass = predicates.every(predicate => matchesPredicate(predicate, outcome));
  if (!gatesPass) return false;
  if (!recipe.score) return true;
  return scoreRecipe(recipe, outcome) >= Number(recipe.score.min || 0);
}

function median(values) {
  const sorted = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function evaluateRecipe(recipe, outcomes, { threshold = DEFAULT_THRESHOLD } = {}) {
  const confusion = {
    recipe_name: recipe.name,
    threshold,
    tp: [],
    fp: [],
    fn: [],
    tn: [],
  };

  for (const outcome of outcomes) {
    const isRunner = Number(outcome.multiple) >= threshold;
    const admitted = recipeAdmits(recipe, outcome);
    if (admitted && isRunner) confusion.tp.push(outcome);
    else if (admitted) confusion.fp.push(outcome);
    else if (isRunner) confusion.fn.push(outcome);
    else confusion.tn.push(outcome);
  }

  return confusion;
}

export function summarizeConfusion(confusion) {
  return {
    recipe_name: confusion.recipe_name,
    threshold: confusion.threshold,
    tp: confusion.tp.length,
    fp: confusion.fp.length,
    fn: confusion.fn.length,
    tn: confusion.tn.length,
  };
}

export function reportMetrics(confusion) {
  const tp = confusion.tp.length;
  const fp = confusion.fp.length;
  const fn = confusion.fn.length;
  const tn = confusion.tn.length;
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  const f1 = precision != null && recall != null && precision + recall
    ? (2 * precision * recall) / (precision + recall)
    : null;
  const falsePositiveRate = fp + tn ? fp / (fp + tn) : null;

  return {
    ...summarizeConfusion(confusion),
    guide_source: confusion.guide_source || '',
    precision,
    recall,
    f1,
    false_positive_rate: falsePositiveRate,
    median_time_to_peak_ms: median(confusion.tp.map(outcome => outcome.time_to_peak_ms)),
  };
}

const BROAD_FILTERS = [
  { field: 'first_source_count', op: 'gte', value: 2 },
  { field: 'first_mcap_usd', op: 'lt', value: 500_000 },
  { field: 'first_age_ms', op: 'lt', value: 60 * 60_000 },
];

const DUAL_SOURCE_FILTERS = [
  { field: 'first_source_count', op: 'gte', value: 2 },
  { field: 'first_trending_source', op: 'exists' },
  { field: 'first_mcap_usd', op: 'lt', value: 500_000 },
  { field: 'first_age_ms', op: 'lt', value: 60 * 60_000 },
];

const GUIDE_EARLY_FILTERS = [
  { field: 'first_source_count', op: 'gte', value: 2 },
  { field: 'first_mcap_usd', op: 'gte', value: 3_000 },
  { field: 'first_mcap_usd', op: 'lt', value: 500_000 },
  { field: 'first_age_ms', op: 'lt', value: 60 * 60_000 },
];

const ANTI_BUNDLE_SAFETY_FILTERS = [
  { field: 'screening_blockers', op: 'not_contains', value: 'trending_wash_trading' },
  { field: 'screening_blockers', op: 'not_contains', value: 'trending_max_bundler_rate' },
  { field: 'screening_blockers', op: 'not_contains', value: 'trending_max_rug_ratio' },
  { field: 'candidate_blockers', op: 'not_contains', value: 'trending_wash_trading' },
  { field: 'candidate_blockers', op: 'not_contains', value: 'trending_max_bundler_rate' },
  { field: 'candidate_blockers', op: 'not_contains', value: 'trending_max_rug_ratio' },
];

const MCAP_BANDS = [
  ['lt_5k', 0, 5_000],
  ['5k_10k', 5_000, 10_000],
  ['10k_25k', 10_000, 25_000],
  ['25k_50k', 25_000, 50_000],
  ['50k_100k', 50_000, 100_000],
  ['100k_250k', 100_000, 250_000],
  ['250k_500k', 250_000, 500_000],
];

export const BUILT_IN_RECIPES = [
  {
    name: 'broad_recall',
    predicates: [...BROAD_FILTERS],
  },
  ...MCAP_BANDS.map(([name, min, max]) => ({
    name: `mcap_band_discovery_${name}`,
    predicates: [
      ...BROAD_FILTERS,
      { field: 'first_mcap_usd', op: 'between', value: { min, max } },
    ],
  })),
  ...[
    ['age_lt_5m', 5 * 60_000],
    ['age_lt_15m', 15 * 60_000],
    ['age_lt_60m', 60 * 60_000],
  ].map(([name, maxAgeMs]) => ({
    name: `early_movement_${name}`,
    predicates: [
      { field: 'first_source_count', op: 'gte', value: 2 },
      { field: 'first_mcap_usd', op: 'lt', value: 500_000 },
      { field: 'first_age_ms', op: 'lt', value: maxAgeMs },
    ],
  })),
  {
    name: 'saved_wallet_feature_hard',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'first_saved_wallet_hits', op: 'gte', value: 1 },
    ],
  },
  {
    name: 'saved_wallet_hard_gate',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'first_saved_wallet_hits', op: 'gte', value: 1 },
    ],
  },
  {
    name: 'broad_recall_plus_tier_a_wallet',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'candidate_tier_a_wallet_count', op: 'gte', value: 1 },
    ],
  },
  {
    name: 'broad_recall_plus_smart_degen',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'candidate_smart_degen_present', op: 'eq', value: 1 },
    ],
  },
  {
    name: 'broad_recall_plus_recurring_runner_wallet',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'candidate_has_recurring_runner_wallet', op: 'eq', value: 1 },
    ],
  },
  {
    name: 'dual_source_plus_tier_a_wallet',
    predicates: [
      ...DUAL_SOURCE_FILTERS,
      { field: 'candidate_tier_a_wallet_count', op: 'gte', value: 1 },
    ],
  },
  {
    name: 'dual_source_plus_wallet_quality_high',
    predicates: [
      ...DUAL_SOURCE_FILTERS,
      { field: 'candidate_wallet_quality_bucket', op: 'in', value: ['tier_a', 'tier_b'] },
    ],
  },
  {
    name: 'saved_wallet_feature_soft_score',
    predicates: [],
    score: {
      min: 3,
      terms: [
        { field: 'first_source_count', op: 'gte', value: 2, weight: 1 },
        { field: 'first_mcap_usd', op: 'lt', value: 500_000, weight: 1 },
        { field: 'first_age_ms', op: 'lt', value: 60 * 60_000, weight: 1 },
        { field: 'first_saved_wallet_hits', op: 'gte', value: 1, weight: 2 },
      ],
    },
  },
  {
    name: 'fee_graduated_fee_claim',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'first_fee_claim_present', op: 'eq', value: 1 },
    ],
  },
  {
    name: 'fee_graduated_graduated',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'first_graduated_present', op: 'eq', value: 1 },
    ],
  },
  {
    name: 'fee_graduated_both',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'first_fee_claim_present', op: 'eq', value: 1 },
      { field: 'first_graduated_present', op: 'eq', value: 1 },
    ],
  },
  {
    name: 'guide_early_runner_no_fee_risk_screen',
    guide_source: 'ponyin',
    predicates: [
      ...GUIDE_EARLY_FILTERS,
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
  },
  {
    name: 'guide_fee_confirmed_microcap',
    guide_source: 'ponyin',
    predicates: [
      { field: 'first_source_count', op: 'gte', value: 2 },
      { field: 'first_mcap_usd', op: 'gte', value: 100_000 },
      { field: 'first_mcap_usd', op: 'lt', value: 500_000 },
      { field: 'first_age_ms', op: 'lt', value: 60 * 60_000 },
      { field: 'first_fee_claim_present', op: 'eq', value: 1 },
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
  },
  {
    name: 'guide_wallet_confirmed_no_fee',
    guide_source: 'sambelikan',
    predicates: [
      ...GUIDE_EARLY_FILTERS,
      { field: 'first_fee_claim_present', op: 'eq', value: 0 },
      { field: 'candidate_wallet_quality_bucket', op: 'in', value: ['tier_a', 'tier_b'] },
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
  },
  {
    name: 'guide_anti_bundle_strict',
    guide_source: 'sambelikan',
    predicates: [
      ...GUIDE_EARLY_FILTERS,
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
    score: {
      min: 4,
      terms: [
        { field: 'first_source_count', op: 'gte', value: 2, weight: 1 },
        { field: 'first_trending_source', op: 'exists', weight: 1 },
        { field: 'first_holders', op: 'gte', value: 75, weight: 1 },
        { field: 'first_saved_wallet_hits', op: 'gte', value: 1, weight: 1 },
        { field: 'candidate_wallet_quality_bucket', op: 'in', value: ['tier_a', 'tier_b'], weight: 1 },
      ],
    },
  },
  {
    name: 'guide_dip_reentry_50_70_from_ath',
    guide_source: 'sambelikan',
    predicates: [
      { field: 'first_source_count', op: 'gte', value: 1 },
      { field: 'first_mcap_usd', op: 'gte', value: 100_000 },
      { field: 'first_mcap_usd', op: 'lt', value: 1_000_000 },
      { field: 'first_chart_high_dist', op: 'between', value: { min: -70, max: -50 } },
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
  },
  {
    name: 'guide_staircase_warning_avoided',
    guide_source: 'sambelikan',
    predicates: [
      ...BROAD_FILTERS,
      { field: 'staircase_warning', op: 'staircase_warning_absent' },
    ],
  },
  {
    name: 'guide_dip_with_active_gake',
    guide_source: 'sambelikan',
    predicates: [
      { field: 'first_source_count', op: 'gte', value: 1 },
      { field: 'first_mcap_usd', op: 'gte', value: 100_000 },
      { field: 'first_mcap_usd', op: 'lt', value: 1_000_000 },
      { field: 'ath_distance_pct', op: 'ath_distance_in_range', value: { min_pct: -70, max_pct: -50 } },
      { field: 'gake_exit_pct', op: 'gake_exit_below_threshold', value: 30 },
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
  },
  {
    name: 'guide_anti_cabal_strict',
    guide_source: 'ponyin',
    predicates: [
      ...BROAD_FILTERS,
      ...DUAL_SOURCE_FILTERS,
      { field: 'cabal_burst_detected', op: 'cabal_burst_absent' },
      { field: 'single_source_spam', op: 'eq', value: false },
      ...ANTI_BUNDLE_SAFETY_FILTERS,
    ],
  },
];

export function evaluateBuiltInRecipes(outcomes, { thresholds = [2, 3, 5] } = {}) {
  return BUILT_IN_RECIPES.flatMap(recipe => thresholds.map(threshold => {
    const confusion = evaluateRecipe(recipe, outcomes, { threshold });
    confusion.guide_source = recipe.guide_source || '';
    return reportMetrics(confusion);
  }));
}
