export const SOURCE_INSTANCES = new Set(['primary', 'shadow', 'scout']);
export const EXECUTION_LANES = new Set(['primary_live', 'primary_dry_run', 'shadow_dry_run', 'scout_dry_run']);
export const DECISION_STAGES = new Set(['candidate_filter', 'llm_decision', 'entry_decision', 'entry_confirmation', 'execution_refresh', 'scout_llm_admission']);
export const DECISION_ACTIONS = new Set([
  'filtered',
  'passed',
  'watch',
  'buy_selected',
  'entry_not_approved',
  'dry_run_entry',
  'confirm_intent_created',
  'live_entry_failed',
  'entry_skipped_max_positions',
  'entry_rejected_fresh_filters',
  'entry_rejected_ohlcv',
  'entry_watch_started',
  'entry_watch_checked',
  'entry_watch_triggered',
  'entry_watch_expired',
  'entry_watch_invalidated',
  'entry_watch_cancelled',
  'llm_watch_dip_not_started',
  'llm_watch_dip_started',
  'llm_watch_dip_checked',
  'llm_watch_dip_triggered',
  'scout_llm_throttle_skipped',
  'no_candidate_selected',
]);
export const OBSERVATION_STATUSES = new Set(['pending', 'leased', 'observed', 'dropped', 'error']);
export const WATCH_TIERS = new Set(['A', 'B', 'C']);
export const WATCH_STATUSES = new Set(['active', 'promoted', 'dropped', 'complete']);
export const PROVIDERS = new Set(['birdeye', 'gmgn', 'jupiter', 'okx', 'charon', 'cache']);
export const PROVIDER_CALL_STATUSES = new Set(['ok', 'error', 'cache_hit', 'skipped', 'stale']);

export function assertOneOf(name, value, allowed) {
  if (!allowed.has(value)) {
    throw new Error(`${name}=${value} is not allowed; expected one of ${[...allowed].join(', ')}`);
  }
  return value;
}

export function validateSourceInstance(value) {
  return assertOneOf('source_instance', value, SOURCE_INSTANCES);
}

export function validateExecutionLane(value) {
  return assertOneOf('execution_lane', value, EXECUTION_LANES);
}

export function validateDecisionStage(value) {
  return assertOneOf('decision_stage', value, DECISION_STAGES);
}

export function validateDecisionAction(value) {
  return assertOneOf('decision_action', value, DECISION_ACTIONS);
}

export function validateWatchTier(value) {
  return assertOneOf('tier', value, WATCH_TIERS);
}

export function validateProvider(value) {
  return assertOneOf('provider', value, PROVIDERS);
}

export function validateProviderCallStatus(value) {
  return assertOneOf('provider_call_status', value, PROVIDER_CALL_STATUSES);
}
