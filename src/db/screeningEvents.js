import { db } from './connection.js';
import { now, json } from '../utils.js';

const BLOCKED_FIELD_RE = /(authorization|body|header|key|payload|private|prompt|raw|request|response|secret|token)/i;
const CONFIG_KEYS = [
  'min_source_count',
  'require_fee_claim',
  'token_age_max_ms',
  'min_mcap_usd',
  'max_mcap_usd',
  'min_fee_claim_sol',
  'min_gmgn_total_fee_sol',
  'min_graduated_volume_usd',
  'min_holders',
  'max_top20_holder_percent',
  'min_saved_wallet_holders',
  'max_ath_distance_pct',
  'trending_source',
  'trending_min_volume_usd',
  'trending_min_swaps',
  'trending_max_rug_ratio',
  'trending_max_bundler_rate',
];

function textOrNull(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function boolIntOrNull(value) {
  if (value == null) return null;
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function compactValue(value, depth = 0) {
  if (value == null || depth > 2) return null;
  if (typeof value === 'boolean' || typeof value === 'number') return Number.isFinite(Number(value)) ? value : null;
  if (typeof value === 'string') return value.length > 160 ? value.slice(0, 160) : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(item => compactValue(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, child] of Object.entries(value).slice(0, 40)) {
      if (BLOCKED_FIELD_RE.test(key)) continue;
      const compact = compactValue(child, depth + 1);
      if (compact != null) out[key] = compact;
    }
    return out;
  }
  return null;
}

function compactObject(value, fallback = {}) {
  const compact = compactValue(value);
  return compact && typeof compact === 'object' && !Array.isArray(compact) ? compact : fallback;
}

function jsonOrValue(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function compactSources(...values) {
  for (const value of values) {
    const parsed = jsonOrValue(value, value);
    if (Array.isArray(value)) return value.slice(0, 20).map(source => String(source));
    if (Array.isArray(parsed)) return parsed.slice(0, 20).map(source => String(source));
    if (parsed != null) return [String(parsed)];
  }
  return [];
}

function pickConfigSnapshot(configSnapshot, strategy) {
  const merged = { ...(strategy || {}), ...(configSnapshot || {}) };
  const snapshot = {};
  for (const key of CONFIG_KEYS) {
    if (merged[key] !== undefined) snapshot[key] = compactValue(merged[key]);
  }
  return snapshot;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

export function logScreeningEvent({
  atMs = null,
  at_ms = null,
  stage,
  action,
  reasonCode = null,
  reason_code = null,
  reasonText = null,
  reason_text = null,
  mint = null,
  strategy = null,
  strategyId = null,
  strategy_id = null,
  signal = null,
  signalKey = null,
  signal_key = null,
  candidate = null,
  candidateId = null,
  candidate_id = null,
  batchId = null,
  batch_id = null,
  executionMode = null,
  execution_mode = null,
  sourceCount = null,
  source_count = null,
  sources = null,
  sources_json = null,
  route = null,
  ageMs = null,
  age_ms = null,
  ageThresholdMs = null,
  age_threshold_ms = null,
  hasFeeClaim = null,
  has_fee_claim = null,
  feeClaimSol = null,
  fee_claim_sol = null,
  marketCapUsd = null,
  market_cap_usd = null,
  holderCount = null,
  holder_count = null,
  maxHolderPercent = null,
  max_holder_percent = null,
  savedWalletHolders = null,
  saved_wallet_holders = null,
  gmgnTotalFeeSol = null,
  gmgn_total_fee_sol = null,
  graduatedVolumeUsd = null,
  graduated_volume_usd = null,
  trendingSource = null,
  trending_source = null,
  trendingVolumeUsd = null,
  trending_volume_usd = null,
  trendingSwaps = null,
  trending_swaps = null,
  trendingRugRatio = null,
  trending_rug_ratio = null,
  trendingBundlerRate = null,
  trending_bundler_rate = null,
  trendingIsWashTrading = null,
  trending_is_wash_trading = null,
  providerFields = null,
  provider_fields_json = null,
  configSnapshot = null,
  config_snapshot_json = null,
} = {}) {
  const eventMint = textOrNull(firstDefined(mint, signal?.mint, candidate?.token?.mint));
  const eventStage = textOrNull(stage);
  const eventAction = textOrNull(action);
  if (!eventMint) throw new Error('logScreeningEvent requires mint');
  if (!eventStage) throw new Error('logScreeningEvent requires stage');
  if (!eventAction) throw new Error('logScreeningEvent requires action');

  const metrics = candidate?.metrics || {};
  const holders = candidate?.holders || {};
  const trending = candidate?.trending || signal?.trending || {};
  const feeClaim = candidate?.feeClaim || signal?.feeClaim || null;
  const normalizedConfigSnapshot = firstDefined(configSnapshot, jsonOrValue(config_snapshot_json, null));
  const selectedSources = compactSources(sources, sources_json, signal?.sources, candidate?.signals?.sources);
  const selectedProviderFields = compactObject({
    ...compactObject(firstDefined(providerFields, jsonOrValue(provider_fields_json, null))),
    risk_field_availability: trending?.risk_field_availability,
    provider: trending?.provider,
    source: trending?.source,
  });
  const selectedConfigSnapshot = pickConfigSnapshot(normalizedConfigSnapshot, strategy);

  const result = db.prepare(`
    INSERT INTO screening_events (
      at_ms, mint, strategy_id, stage, action, reason_code, reason_text,
      signal_key, candidate_id, batch_id, execution_mode, source_count,
      sources_json, route, age_ms, age_threshold_ms, has_fee_claim,
      fee_claim_sol, market_cap_usd, holder_count, max_holder_percent,
      saved_wallet_holders, gmgn_total_fee_sol, graduated_volume_usd,
      trending_source, trending_volume_usd, trending_swaps, trending_rug_ratio,
      trending_bundler_rate, trending_is_wash_trading, provider_fields_json,
      config_snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    integerOrNull(firstDefined(atMs, at_ms)) ?? now(),
    eventMint,
    textOrNull(firstDefined(strategyId, strategy_id, strategy?.id, candidate?.signals?.strategy, candidate?.filters?.strategy)),
    eventStage,
    eventAction,
    textOrNull(firstDefined(reasonCode, reason_code)),
    textOrNull(firstDefined(reasonText, reason_text)),
    textOrNull(firstDefined(signalKey, signal_key, candidate?.signalKey, candidate?.signals?.signalKey)),
    integerOrNull(firstDefined(candidateId, candidate_id)),
    integerOrNull(firstDefined(batchId, batch_id)),
    textOrNull(firstDefined(executionMode, execution_mode, candidate?.executionMode)),
    integerOrNull(firstDefined(sourceCount, source_count, signal?.sourceCount, candidate?.signals?.sourceCount)),
    json(selectedSources),
    textOrNull(firstDefined(route, signal?.route, candidate?.signals?.route)),
    integerOrNull(firstDefined(ageMs, age_ms, signal?.ageMs, candidate?.signals?.ageMs)),
    integerOrNull(firstDefined(ageThresholdMs, age_threshold_ms, strategy?.token_age_max_ms, normalizedConfigSnapshot?.token_age_max_ms)),
    boolIntOrNull(firstDefined(hasFeeClaim, has_fee_claim, signal?.hasFeeClaim, candidate?.signals?.hasFeeClaim, feeClaim ? true : null)),
    numberOrNull(firstDefined(feeClaimSol, fee_claim_sol, feeClaim?.distributedSol)),
    numberOrNull(firstDefined(marketCapUsd, market_cap_usd, metrics.marketCapUsd)),
    integerOrNull(firstDefined(holderCount, holder_count, metrics.holderCount, holders.count)),
    numberOrNull(firstDefined(maxHolderPercent, max_holder_percent, holders.maxHolderPercent, holders.top20Percent)),
    integerOrNull(firstDefined(savedWalletHolders, saved_wallet_holders, candidate?.savedWalletExposure?.holderCount)),
    numberOrNull(firstDefined(gmgnTotalFeeSol, gmgn_total_fee_sol, metrics.gmgnTotalFeesSol)),
    numberOrNull(firstDefined(graduatedVolumeUsd, graduated_volume_usd, metrics.graduatedVolumeUsd)),
    textOrNull(firstDefined(trendingSource, trending_source, trending.source, normalizedConfigSnapshot?.trending_source)),
    numberOrNull(firstDefined(trendingVolumeUsd, trending_volume_usd, trending.volume, metrics.trendingVolumeUsd)),
    integerOrNull(firstDefined(trendingSwaps, trending_swaps, trending.swaps, metrics.trendingSwaps)),
    numberOrNull(firstDefined(trendingRugRatio, trending_rug_ratio, trending.rug_ratio)),
    numberOrNull(firstDefined(trendingBundlerRate, trending_bundler_rate, trending.bundler_rate)),
    boolIntOrNull(firstDefined(trendingIsWashTrading, trending_is_wash_trading, trending.is_wash_trading)),
    json(selectedProviderFields),
    json(selectedConfigSnapshot),
  );
  return Number(result.lastInsertRowid);
}
