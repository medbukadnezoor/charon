function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolish(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function boolishWithFallback(value, fallback) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function lowerText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.toLowerCase();
  try {
    return JSON.stringify(value).toLowerCase();
  } catch {
    return '';
  }
}

function routeIsDualSource(candidate) {
  const route = String(candidate?.signals?.route || '').toLowerCase();
  if (route === 'dual_source' || route.includes('dual')) return true;
  const sources = candidate?.signals?.sources;
  if (Array.isArray(sources) && new Set(sources.filter(Boolean)).size >= 2) return true;
  return Number(candidate?.signals?.sourceCount || 0) >= 2;
}

function candidateMcap(candidate) {
  return finiteNumber(candidate?.metrics?.marketCapUsd)
    ?? finiteNumber(candidate?.metrics?.graduatedMarketCapUsd)
    ?? finiteNumber(candidate?.mcapSample?.marketCapUsd);
}

function candidatePrice(candidate) {
  return finiteNumber(candidate?.metrics?.priceUsd)
    ?? finiteNumber(candidate?.mcapSample?.priceUsd);
}

function hasCriticalNarrativeRisk(candidate) {
  const text = [
    candidate?.kolDumpRisk,
    candidate?.holderIntelligence,
    candidate?.twitterNarrative,
    candidate?.llmConclusions,
  ].map(lowerText).join(' ');
  return /critical|severe|coordinated|cluster|equal[-\s]?amount|kol dump|dump[-\s]?risk/.test(text);
}

export function watchDipExecutionOverrides(strat = {}) {
  return {
    risk_profile: 'conservative',
    suggested_position_size_sol: finiteNumber(strat.llm_watch_dip_position_size_sol) ?? 0.03,
    suggested_sl_percent: finiteNumber(strat.llm_watch_dip_sl_percent) ?? -60,
    suggested_tp_percent: finiteNumber(strat.llm_watch_dip_tp_percent) ?? 300,
    suggested_trailing_enabled: boolishWithFallback(strat.llm_watch_dip_trailing_enabled, true),
    suggested_trailing_arm_percent: finiteNumber(strat.llm_watch_dip_trailing_arm_percent) ?? 100,
    suggested_trailing_percent: finiteNumber(strat.llm_watch_dip_trailing_percent) ?? 35,
    suggested_breakeven_after_profit_percent: finiteNumber(strat.llm_watch_dip_breakeven_after_profit_percent) ?? 80,
    suggested_breakeven_lock_percent: finiteNumber(strat.llm_watch_dip_breakeven_lock_percent) ?? 20,
  };
}

export function evaluateWatchDipEligibility(candidate, decision = {}, strat = {}) {
  if (!boolish(strat.llm_watch_dip_enabled)) return { eligible: false, reason: 'llm_watch_dip_disabled' };
  if (String(decision?.verdict || '').toUpperCase() !== 'WATCH') return { eligible: false, reason: 'decision_not_watch' };
  const confidence = finiteNumber(decision?.confidence) ?? 0;
  const minConfidence = finiteNumber(strat.llm_watch_dip_min_confidence) ?? 55;
  if (confidence < minConfidence) return { eligible: false, reason: 'confidence_below_min' };
  if (!candidate?.filters?.passed) return { eligible: false, reason: 'candidate_filters_failed' };
  if (!routeIsDualSource(candidate)) return { eligible: false, reason: 'route_not_dual_source' };

  const mcap = candidateMcap(candidate);
  const liquidity = finiteNumber(candidate?.metrics?.liquidityUsd);
  const athDistance = finiteNumber(candidate?.chart?.distanceFromAthPercent ?? candidate?.chart?.athDistancePercent);
  const gmgnFees = finiteNumber(candidate?.metrics?.gmgnTotalFeesSol) ?? 0;
  const savedWallets = finiteNumber(candidate?.savedWalletExposure?.holderCount) ?? 0;
  const sourceCount = finiteNumber(candidate?.signals?.sourceCount) ?? 0;
  const maxHolder = finiteNumber(candidate?.holders?.maxHolderPercent);
  const top20 = finiteNumber(candidate?.holders?.top20Percent);
  const rugRatio = finiteNumber(candidate?.trending?.rug_ratio);
  const bundlerRate = finiteNumber(candidate?.trending?.bundler_rate);

  const minMcap = finiteNumber(strat.llm_watch_dip_min_mcap_usd) ?? 12_000;
  const maxMcap = finiteNumber(strat.llm_watch_dip_max_mcap_usd) ?? 45_000;
  const minLiquidity = finiteNumber(strat.llm_watch_dip_min_liquidity_usd) ?? 8_000;
  const maxLiquidity = finiteNumber(strat.llm_watch_dip_max_liquidity_usd) ?? 25_000;
  const maxAthDistance = finiteNumber(strat.llm_watch_dip_max_ath_distance_pct) ?? -40;
  const minGmgnFees = finiteNumber(strat.llm_watch_dip_min_gmgn_fee_sol) ?? 5;
  const minSavedWallets = finiteNumber(strat.llm_watch_dip_min_saved_wallets) ?? 5;
  const minSourceCount = finiteNumber(strat.llm_watch_dip_min_source_count) ?? 2;
  const hardMaxHolder = finiteNumber(strat.llm_watch_dip_hard_max_holder_percent) ?? 45;
  const hardTop20 = finiteNumber(strat.llm_watch_dip_hard_max_top20_percent) ?? 85;
  const coreMaxHolder = finiteNumber(strat.llm_watch_dip_core_max_holder_percent) ?? 35;
  const coreTop20 = finiteNumber(strat.llm_watch_dip_core_max_top20_percent) ?? 75;
  const maxRug = finiteNumber(strat.llm_watch_dip_max_rug_ratio) ?? finiteNumber(strat.trending_max_rug_ratio) ?? 0.3;
  const maxBundler = finiteNumber(strat.llm_watch_dip_max_bundler_rate) ?? finiteNumber(strat.trending_max_bundler_rate) ?? 0.5;

  if (mcap == null || mcap < minMcap || mcap > maxMcap) return { eligible: false, reason: 'mcap_out_of_range', metrics: { mcap } };
  if (liquidity == null || liquidity < minLiquidity || liquidity > maxLiquidity) return { eligible: false, reason: 'liquidity_out_of_range', metrics: { liquidity } };
  if (athDistance == null || athDistance > maxAthDistance) return { eligible: false, reason: 'ath_distance_not_deep_enough', metrics: { athDistance } };
  if (gmgnFees < minGmgnFees && savedWallets < minSavedWallets) return { eligible: false, reason: 'gmgn_fee_or_wallet_signal_weak', metrics: { gmgnFees, savedWallets } };
  if (sourceCount < minSourceCount) return { eligible: false, reason: 'source_count_below_min', metrics: { sourceCount } };
  if (maxHolder != null && maxHolder > hardMaxHolder) return { eligible: false, reason: 'max_holder_hard_reject', metrics: { maxHolder } };
  if (top20 != null && top20 > hardTop20) return { eligible: false, reason: 'top20_hard_reject', metrics: { top20 } };
  if (candidate?.trending && boolish(candidate.trending.is_wash_trading)) return { eligible: false, reason: 'wash_trading_reject' };
  if (rugRatio != null && rugRatio > maxRug) return { eligible: false, reason: 'rug_ratio_reject', metrics: { rugRatio } };
  if (bundlerRate != null && bundlerRate > maxBundler) return { eligible: false, reason: 'bundler_rate_reject', metrics: { bundlerRate } };
  if (hasCriticalNarrativeRisk(candidate)) return { eligible: false, reason: 'critical_narrative_risk' };

  const cohort = (maxHolder == null || maxHolder <= coreMaxHolder) && (top20 == null || top20 <= coreTop20)
    ? 'core'
    : 'experimental';
  return {
    eligible: true,
    reason: cohort === 'core' ? 'llm_watch_dip_core_eligible' : 'llm_watch_dip_experimental_concentration',
    cohort,
    metrics: { confidence, mcap, liquidity, athDistance, gmgnFees, savedWallets, sourceCount, maxHolder, top20 },
  };
}

function candlePrice(row, key) {
  return finiteNumber(row?.[key]);
}

function trailingGreenWithoutPullback(candles, pullbackThresholdPct) {
  let count = 0;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const row = candles[index];
    const open = candlePrice(row, 'o');
    const close = candlePrice(row, 'c');
    const high = candlePrice(row, 'h');
    const low = candlePrice(row, 'l');
    if (open == null || close == null || high == null || low == null || close <= open) break;
    if (high > 0 && ((high - low) / high) * 100 >= pullbackThresholdPct) break;
    count += 1;
  }
  return count;
}

function upperWickDominant(candles) {
  const sample = candles.slice(-3);
  if (sample.length < 3) return false;
  const dominant = sample.filter(row => {
    const high = candlePrice(row, 'h');
    const low = candlePrice(row, 'l');
    const open = candlePrice(row, 'o');
    const close = candlePrice(row, 'c');
    if (high == null || low == null || open == null || close == null || high <= low) return false;
    const upper = high - Math.max(open, close);
    return upper / (high - low) >= 0.5;
  }).length;
  return dominant >= 2;
}

export function computeWatchDipTrigger(watch, candidate, candles = [], strat = {}) {
  if (!Array.isArray(candles) || candles.length < 5) return { trigger: false, reason: 'insufficient_candles' };
  const currentMcap = candidateMcap(candidate);
  const currentPrice = candidatePrice(candidate);
  const usePrice = currentPrice != null && finiteNumber(watch?.original_price) != null;
  const current = usePrice ? currentPrice : currentMcap;
  const baseline = usePrice ? finiteNumber(watch?.original_price) : finiteNumber(watch?.original_mcap);
  if (current == null || baseline == null || baseline <= 0) return { trigger: false, reason: 'baseline_unavailable' };

  const closes = candles.map(row => candlePrice(row, 'c')).filter(value => value != null);
  const highs = candles.map(row => candlePrice(row, 'h')).filter(value => value != null);
  const lows = candles.map(row => candlePrice(row, 'l')).filter(value => value != null);
  const recentHigh = usePrice ? Math.max(...highs, baseline) : baseline;
  const lowInputs = usePrice
    ? [...lows, finiteNumber(watch?.best_low_price), current]
    : [finiteNumber(watch?.best_low_mcap), current];
  const observedLow = Math.min(...lowInputs.filter(value => value != null));
  const pullbackFromBaseline = ((baseline - observedLow) / baseline) * 100;
  const pullbackFromRecentHigh = ((recentHigh - observedLow) / recentHigh) * 100;
  const pullbackPct = Math.max(pullbackFromBaseline, pullbackFromRecentHigh);
  const recoveryFromLowPct = observedLow > 0 ? ((current - observedLow) / observedLow) * 100 : null;
  const distanceBelowHighPct = recentHigh > 0 ? ((current - recentHigh) / recentHigh) * 100 : null;
  const staircaseCount = trailingGreenWithoutPullback(candles, finiteNumber(strat.llm_watch_dip_staircase_pullback_pct) ?? 8);

  const minPullback = finiteNumber(strat.llm_watch_dip_min_pullback_pct) ?? 12;
  const maxPullback = finiteNumber(strat.llm_watch_dip_max_pullback_pct) ?? 45;
  const minRecovery = finiteNumber(strat.llm_watch_dip_min_recovery_from_low_pct) ?? 8;
  const minCurrentMcap = finiteNumber(strat.llm_watch_dip_trigger_min_mcap_usd) ?? 10_000;
  const maxCurrentMcap = finiteNumber(strat.llm_watch_dip_trigger_max_mcap_usd) ?? 90_000;
  const minBelowHigh = finiteNumber(strat.llm_watch_dip_min_below_high_pct) ?? 10;
  const maxStaircase = finiteNumber(strat.llm_watch_dip_max_staircase_green_candles) ?? 4;

  if (currentMcap == null || currentMcap < minCurrentMcap || currentMcap > maxCurrentMcap) return { trigger: false, reason: 'current_mcap_out_of_range', pullbackPct, recoveryFromLowPct, currentMcap };
  if (pullbackPct < minPullback) return { trigger: false, reason: 'pullback_too_small', pullbackPct, recoveryFromLowPct };
  if (pullbackPct > maxPullback) return { trigger: false, reason: 'pullback_too_deep', pullbackPct, recoveryFromLowPct };
  if (recoveryFromLowPct == null || recoveryFromLowPct < minRecovery) return { trigger: false, reason: 'recovery_from_low_too_small', pullbackPct, recoveryFromLowPct };
  if (distanceBelowHighPct == null || distanceBelowHighPct > -minBelowHigh) return { trigger: false, reason: 'too_close_to_recent_high', pullbackPct, recoveryFromLowPct, distanceBelowHighPct };
  if (staircaseCount >= maxStaircase + 1) return { trigger: false, reason: 'staircase_without_pullback', pullbackPct, recoveryFromLowPct, staircaseCount };
  if (upperWickDominant(candles)) return { trigger: false, reason: 'upper_wick_exhaustion', pullbackPct, recoveryFromLowPct, staircaseCount };

  return {
    trigger: true,
    reason: 'llm_watch_dip_triggered',
    pullbackPct,
    recoveryFromLowPct,
    distanceBelowHighPct,
    staircaseCount,
    currentMcap,
    lastClose: closes.at(-1) ?? null,
  };
}
