import { INSTANCE_ID, SHADOW_MODE } from '../config.js';
import { tradingMode } from '../db/positions.js';

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function boolOrNull(value) {
  if (value == null) return null;
  return value === true || value === 1 || value === '1' || value === 'true';
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function topWalletSummary(exposure = {}) {
  const wallets = exposure?.evidence?.wallets || [];
  return {
    holderCount: integerOrNull(exposure?.holderCount) ?? 0,
    checked: integerOrNull(exposure?.checked) ?? 0,
    strongCount: integerOrNull(exposure?.evidence?.summary?.strongCount) ?? 0,
    kolCount: integerOrNull(exposure?.evidence?.summary?.kolCount) ?? 0,
    tiers: wallets.reduce((acc, wallet) => {
      const tier = wallet?.tier || 'unknown';
      acc[tier] = (acc[tier] || 0) + 1;
      return acc;
    }, {}),
  };
}

export function executionLaneForRuntime(mode = tradingMode()) {
  if (INSTANCE_ID === 'scout') return 'scout_dry_run';
  if (SHADOW_MODE || INSTANCE_ID === 'shadow') return 'shadow_dry_run';
  return mode === 'live' || mode === 'confirm' ? 'primary_live' : 'primary_dry_run';
}

export function normalizedFeatureSnapshot(candidate = {}) {
  const filters = candidate.filters || {};
  const metrics = candidate.metrics || {};
  const holders = candidate.holders || {};
  const trending = candidate.trending || {};
  const signals = candidate.signals || {};
  const savedWallets = topWalletSummary(candidate.savedWalletExposure);
  return {
    mint: candidate.token?.mint || null,
    symbol: candidate.token?.symbol || null,
    name: candidate.token?.name || null,
    route: signals.route || null,
    signalLabel: signals.label || null,
    sourceCount: integerOrNull(signals.sourceCount),
    sources: Array.isArray(signals.sources) ? signals.sources.slice(0, 20) : [],
    tokenAgeMs: integerOrNull(signals.ageMs),
    priceUsd: numberOrNull(metrics.priceUsd),
    marketCapUsd: numberOrNull(metrics.marketCapUsd),
    liquidityUsd: numberOrNull(metrics.liquidityUsd),
    holderCount: integerOrNull(firstDefined(metrics.holderCount, holders.count)),
    topHolderPercent: numberOrNull(firstDefined(holders.maxHolderPercent, holders.top20Percent)),
    top20HolderPercent: numberOrNull(holders.top20Percent),
    feeClaimSol: numberOrNull(candidate.feeClaim?.distributedSol),
    gmgnTotalFeeSol: numberOrNull(metrics.gmgnTotalFeesSol),
    savedWalletHolders: savedWallets.holderCount,
    savedWalletStrongCount: savedWallets.strongCount,
    savedWalletKolCount: savedWallets.kolCount,
    savedWalletTiers: savedWallets.tiers,
    trendingSource: trending.source || null,
    trendingVolumeUsd: numberOrNull(firstDefined(trending.volume, metrics.trendingVolumeUsd)),
    trendingSwaps: integerOrNull(firstDefined(trending.swaps, metrics.trendingSwaps)),
    trendingRugRatio: numberOrNull(trending.rug_ratio),
    trendingBundlerRate: numberOrNull(trending.bundler_rate),
    trendingIsWashTrading: boolOrNull(trending.is_wash_trading),
    marketCapSource: candidate.mcapSample?.source || null,
    marketCapDisagreementPercent: numberOrNull(candidate.mcapSample?.disagreementPercent),
    kolDumpRisk: candidate.kolDumpRisk?.risk || candidate.kolDumpRisk?.level || null,
    filterPassed: Boolean(filters.passed),
    failureCodes: Array.isArray(filters.failureCodes) ? filters.failureCodes : [],
    primaryFailureCode: filters.primaryFailureCode || null,
    failureCount: Array.isArray(filters.failureCodes) ? filters.failureCodes.length : 0,
  };
}

export function riskScoreFromSnapshot(snapshot = {}) {
  let score = 0;
  if (snapshot.filterPassed === false) score += 0.25;
  if (snapshot.trendingIsWashTrading === true) score += 0.3;
  if (Number(snapshot.trendingRugRatio) > 0.5) score += 0.25;
  if (Number(snapshot.trendingBundlerRate) > 0.7) score += 0.2;
  if (Number(snapshot.savedWalletHolders || 0) > 0) score -= 0.15;
  if (Number(snapshot.gmgnTotalFeeSol || 0) > 10) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

export function tierFromSnapshot(snapshot = {}, action = 'filtered') {
  if (action === 'dry_run_entry' || action === 'buy_selected') return 'A';
  if (snapshot.filterPassed || Number(snapshot.savedWalletHolders || 0) > 0) return 'A';
  const risk = riskScoreFromSnapshot(snapshot);
  if (risk >= 0.55 || Number(snapshot.failureCount || 0) >= 3) return 'C';
  return 'B';
}

export function snapshotColumnValues(snapshot = {}) {
  return {
    price_usd: numberOrNull(snapshot.priceUsd),
    market_cap_usd: numberOrNull(snapshot.marketCapUsd),
    liquidity_usd: numberOrNull(snapshot.liquidityUsd),
    holder_count: integerOrNull(snapshot.holderCount),
    top_holder_percent: numberOrNull(snapshot.topHolderPercent),
    top20_holder_percent: numberOrNull(snapshot.top20HolderPercent),
    fee_claim_sol: numberOrNull(snapshot.feeClaimSol),
    gmgn_total_fee_sol: numberOrNull(snapshot.gmgnTotalFeeSol),
    saved_wallet_holders: integerOrNull(snapshot.savedWalletHolders),
    saved_wallet_strong_count: integerOrNull(snapshot.savedWalletStrongCount),
    saved_wallet_kol_count: integerOrNull(snapshot.savedWalletKolCount),
    trending_source: snapshot.trendingSource || null,
    trending_volume_usd: numberOrNull(snapshot.trendingVolumeUsd),
    trending_swaps: integerOrNull(snapshot.trendingSwaps),
    trending_rug_ratio: numberOrNull(snapshot.trendingRugRatio),
    trending_bundler_rate: numberOrNull(snapshot.trendingBundlerRate),
    trending_is_wash_trading: snapshot.trendingIsWashTrading == null ? null : (snapshot.trendingIsWashTrading ? 1 : 0),
  };
}

export function deltaFromSnapshots(baseline = {}, current = {}) {
  const fields = [
    'priceUsd',
    'marketCapUsd',
    'liquidityUsd',
    'holderCount',
    'topHolderPercent',
    'top20HolderPercent',
    'feeClaimSol',
    'gmgnTotalFeeSol',
    'savedWalletHolders',
    'trendingVolumeUsd',
    'trendingSwaps',
    'trendingRugRatio',
    'trendingBundlerRate',
  ];
  const out = {};
  for (const field of fields) {
    const from = numberOrNull(baseline[field]);
    const to = numberOrNull(current[field]);
    if (from == null || to == null) continue;
    out[field] = {
      from,
      to,
      abs: to - from,
      pct: from === 0 ? null : ((to - from) / Math.abs(from)) * 100,
    };
  }
  return out;
}
