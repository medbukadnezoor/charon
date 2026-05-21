import { now, firstPositiveNumber, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchKolDumpRisk, fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { logScreeningEvent } from '../db/screeningEvents.js';
import { sampleMarketCap } from '../enrichment/mcapSampler.js';
import { isMintBlacklisted } from '../db/blacklist.js';

const CANDIDATE_FILTER_CONFIG_KEYS = [
  'min_fee_claim_sol',
  'require_fee_claim',
  'min_mcap_usd',
  'max_mcap_usd',
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

function candidateFilterConfigSnapshot(strat) {
  const snapshot = {};
  for (const key of CANDIDATE_FILTER_CONFIG_KEYS) {
    if (strat[key] !== undefined) snapshot[key] = strat[key];
  }
  return snapshot;
}

function candidateFilterProviderFields(candidate) {
  const filters = candidate.filters || {};
  return {
    filterPassed: Boolean(filters.passed),
    failureCodes: filters.failureCodes || [],
    primaryFailureCode: filters.primaryFailureCode || null,
    failureCount: filters.failureCodes?.length || 0,
    filter: {
      passed: Boolean(filters.passed),
      failureCodes: filters.failureCodes || [],
      primaryFailureCode: filters.primaryFailureCode || null,
      failureCount: filters.failureCodes?.length || 0,
    },
    candidate: {
      mint: candidate.token?.mint,
      route: candidate.signals?.route,
      signalLabel: candidate.signals?.label,
      ageMs: candidate.signals?.ageMs ?? null,
      sourceCount: candidate.signals?.sourceCount ?? null,
      hasFeeClaim: candidate.signals?.hasFeeClaim ?? Boolean(candidate.feeClaim),
      metrics: {
        marketCapUsd: candidate.metrics?.marketCapUsd ?? null,
        marketCapSource: candidate.mcapSample?.source ?? null,
        marketCapDisagreementPercent: candidate.mcapSample?.disagreementPercent ?? null,
        holderCount: candidate.metrics?.holderCount ?? null,
        gmgnTotalFeesSol: candidate.metrics?.gmgnTotalFeesSol ?? null,
        graduatedVolumeUsd: candidate.metrics?.graduatedVolumeUsd ?? null,
        trendingVolumeUsd: candidate.metrics?.trendingVolumeUsd ?? null,
        trendingSwaps: candidate.metrics?.trendingSwaps ?? null,
      },
      holders: {
        maxHolderPercent: candidate.holders?.maxHolderPercent ?? null,
        top20Percent: candidate.holders?.top20Percent ?? null,
      },
      savedWalletExposure: {
        holderCount: candidate.savedWalletExposure?.holderCount ?? null,
        checked: candidate.savedWalletExposure?.checked ?? null,
      },
      trending: candidate.trending ? {
        source: candidate.trending.source ?? null,
        rug_ratio: candidate.trending.rug_ratio ?? null,
        bundler_rate: candidate.trending.bundler_rate ?? null,
        is_wash_trading: candidate.trending.is_wash_trading ?? null,
        risk_field_availability: candidate.trending.risk_field_availability ?? null,
      } : null,
    },
  };
}

export function logCandidateFilterOutcome(candidate, strat) {
  const filters = candidate.filters || {};
  const action = filters.passed ? 'passed' : 'filtered';
  const reasonCode = filters.passed
    ? 'candidate_filter_passed'
    : filters.primaryFailureCode || 'candidate_filter_failed';

  try {
    return logScreeningEvent({
      stage: 'candidate_filter',
      action,
      reasonCode,
      reasonText: filters.failures?.join('; ') || null,
      mint: candidate.token?.mint,
      strategy: strat,
      signal: candidate.signals,
      candidate,
      configSnapshot: candidateFilterConfigSnapshot(strat),
      providerFields: candidateFilterProviderFields(candidate),
    });
  } catch (err) {
    console.log(`[candidate] screening event log failed for ${reasonCode}: ${err.message}`);
    return null;
  }
}

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

function computeAlternateQualityScore(candidate) {
  let score = 0;
  // Saved wallet holders — strongest signal when fee claim absent
  const swHolders = candidate.savedWalletExposure?.holderCount || 0;
  score += Math.min(swHolders * 15, 45);
  // Signal source count — multiple sources = higher confidence
  const sources = candidate.signals?.sourceCount || 1;
  score += Math.min((sources - 1) * 10, 30);
  // Has graduated — on-chain maturity signal
  if (candidate.graduation) score += 15;
  // Has trending data — market activity signal
  if (candidate.trending) score += 10;
  // GMGN fees available — alternate fee signal
  if ((candidate.metrics?.gmgnTotalFeesSol || 0) > 0) score += 10;
  return score;
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const failureCodes = [];
  const addFailure = (code, message) => {
    failureCodes.push(code);
    failures.push(message);
  };
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = candidate.trending?.rug_ratio == null ? null : Number(candidate.trending.rug_ratio);
  const bundlerRate = candidate.trending?.bundler_rate == null ? null : Number(candidate.trending.bundler_rate);
  const mint = candidate.token?.mint;

  if (isMintBlacklisted(mint)) {
    addFailure('mint_blacklisted', 'mint is exact-blacklisted');
  }

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      addFailure('min_fee_claim_sol', `fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    const altEnabled = strat.fee_claim_alt_gate_enabled ?? false;
    if (!altEnabled) {
      addFailure('fee_claim_missing_required', 'fee claim: missing (required by strategy)');
    } else {
      // Secondary path: alternate quality gate when fee claim is absent
      const altScore = computeAlternateQualityScore(candidate);
      const altThreshold = strat.fee_claim_alt_threshold ?? 40;
      if (altScore < altThreshold) {
        addFailure('fee_claim_missing_alt_score', `fee claim missing, alt score ${altScore} < threshold ${altThreshold}`);
      } else {
        // Tighter alternate thresholds
        const altMinSw = strat.fee_claim_alt_min_saved_wallet_holders ?? 2;
        const altMaxHolder = strat.fee_claim_alt_max_top20_holder_percent ?? 40;
        const altMinSources = strat.fee_claim_alt_min_source_count ?? 2;
        const swHolders = candidate.savedWalletExposure?.holderCount || 0;
        const sourceCount = candidate.signals?.sourceCount || 1;
        const top20Pct = candidate.holders?.top20Percent || candidate.holders?.maxHolderPercent || 0;
        if (swHolders < altMinSw) {
          addFailure('fee_claim_alt_min_saved_wallets', `alt gate: saved_wallet_holders ${swHolders} < ${altMinSw}`);
        }
        if (top20Pct > altMaxHolder) {
          addFailure('fee_claim_alt_max_holder_pct', `alt gate: top20_holder_pct ${top20Pct} > ${altMaxHolder}`);
        }
        if (sourceCount < altMinSources) {
          addFailure('fee_claim_alt_min_sources', `alt gate: source_count ${sourceCount} < ${altMinSources}`);
        }
        // Mark as secondary path for LLM awareness
        candidate.dataQuality = 'partial';
        candidate.missingFields = ['fee_claim'];
        candidate.alternateQualityScore = altScore;
      }
    }
  }

  // Market cap checks
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    addFailure('min_mcap_usd', `market cap min: ${mcap} < ${strat.min_mcap_usd}`);
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    addFailure('max_mcap_usd', `market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    addFailure('min_gmgn_total_fee_sol', `GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    addFailure('min_graduated_volume_usd', `graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count
  if (strat.min_holders > 0 && holderCount < strat.min_holders) {
    addFailure('min_holders', `holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    addFailure('max_top20_holder_percent', `max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    addFailure('min_saved_wallet_holders', `saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy)
  if (strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      addFailure('max_ath_distance_pct', `ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
      addFailure('trending_min_volume_usd', `trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      addFailure('trending_min_swaps', `trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      addFailure('trending_max_rug_ratio', `trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      addFailure('trending_max_bundler_rate', `trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      addFailure('trending_wash_trading', 'trending wash trading');
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    failureCodes,
    primaryFailureCode: failureCodes[0] || null,
    strategy: strat.id,
  };
}

export function compactSignalMeta(signalMeta = null) {
  if (!signalMeta || typeof signalMeta !== 'object') return {};
  const compact = {
    ageMs: signalMeta.ageMs ?? null,
    sourceCount: signalMeta.sourceCount ?? null,
    sources: Array.isArray(signalMeta.sources) ? signalMeta.sources.map(source => String(source)).slice(0, 20) : [],
    seenAtMs: signalMeta.seenAtMs ?? null,
  };
  if (signalMeta.hasFeeClaim != null) compact.hasFeeClaim = Boolean(signalMeta.hasFeeClaim);
  return compact;
}

export function buildCandidateSignals({ fee = null, graduatedCoin = null, trendingToken = null, signature = null, strat, signalRoute, signalMeta = null }) {
  return {
    route: signalRoute,
    label: signalLabel({
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken),
    }),
    hasFeeClaim: Boolean(fee),
    hasGraduated: Boolean(graduatedCoin),
    hasTrending: Boolean(trendingToken),
    triggerSignature: signature,
    strategy: strat.id,
    ...compactSignalMeta(signalMeta),
  };
}

export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, route, signalMeta = null }) {
  const strat = activeStrategy();
  const mcapSample = await sampleMarketCap({
    mint,
    context: 'candidate_build',
    trendingToken,
    fallbackMarketCapUsd: firstPositiveNumber(graduatedCoin?.marketCap, graduatedCoin?.usd_market_cap),
    fallbackPriceUsd: trendingToken?.price,
    useCache: true,
    thresholds: {
      minMarketCapUsd: strat.min_mcap_usd,
      maxMarketCapUsd: strat.max_mcap_usd,
    },
  });
  const gmgn = mcapSample.gmgn;
  const jupiterAsset = mcapSample.jupiterAsset;
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  const kolDumpRisk = await fetchKolDumpRisk(mint, savedWalletExposure);
  const twitterNarrative = await fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn);
  const priceUsd = mcapSample.priceUsd;
  const marketCapUsd = mcapSample.marketCapUsd;
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    trendingToken ? 'trending' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? 0),
    },
    signals: buildCandidateSignals({ fee, graduatedCoin, trendingToken, signature, strat, signalRoute, signalMeta }),
    graduation: graduatedCoin,
    trending: trendingToken,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    kolDumpRisk,
    twitterNarrative,
    mcapSample,
    createdAtMs: now(),
  };
  candidate.dataQuality = candidate.dataQuality || 'full';
  candidate.missingFields = candidate.missingFields || [];
  candidate.alternateQualityScore = candidate.alternateQualityScore || null;
  candidate.filters = filterCandidate(candidate);
  candidate.screeningEventId = logCandidateFilterOutcome(candidate, strat);
  return candidate;
}
