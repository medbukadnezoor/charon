export const RUNNER_EXPANSION_TAG = 'runner_watch_expansion';

const DEFAULTS = {
  enabled: true,
  minMcapUsd: 3_000,
  maxMcapUsd: 60_000,
  minHolders: 75,
  maxHolders: 300,
  minSavedWallets: 0,
  maxSavedWallets: 4,
  minGmgnFeeSol: 0.3,
  maxGmgnFeeSol: 15,
  minSourceCount: 2,
};

const OVERRIDABLE_FAILURE_CODES = new Set([
  'min_mcap_usd',
  'max_mcap_usd',
  'min_gmgn_total_fee_sol',
  'min_saved_wallet_holders',
]);

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteInteger(value) {
  const parsed = finiteNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function boolFromConfig(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function numberFromConfig(value, fallback) {
  const parsed = finiteNumber(value);
  return parsed == null ? fallback : parsed;
}

export function runnerExpansionConfig(strat = {}) {
  return {
    enabled: boolFromConfig(strat.runner_watch_expansion_enabled, DEFAULTS.enabled),
    minMcapUsd: numberFromConfig(strat.runner_watch_expansion_min_mcap_usd, DEFAULTS.minMcapUsd),
    maxMcapUsd: numberFromConfig(strat.runner_watch_expansion_max_mcap_usd, DEFAULTS.maxMcapUsd),
    minHolders: numberFromConfig(strat.runner_watch_expansion_min_holders, DEFAULTS.minHolders),
    maxHolders: numberFromConfig(strat.runner_watch_expansion_max_holders, DEFAULTS.maxHolders),
    minSavedWallets: numberFromConfig(strat.runner_watch_expansion_min_saved_wallets, DEFAULTS.minSavedWallets),
    maxSavedWallets: numberFromConfig(strat.runner_watch_expansion_max_saved_wallets, DEFAULTS.maxSavedWallets),
    minGmgnFeeSol: numberFromConfig(strat.runner_watch_expansion_min_gmgn_fee_sol, DEFAULTS.minGmgnFeeSol),
    maxGmgnFeeSol: numberFromConfig(strat.runner_watch_expansion_max_gmgn_fee_sol, DEFAULTS.maxGmgnFeeSol),
    minSourceCount: numberFromConfig(strat.runner_watch_expansion_min_source_count, DEFAULTS.minSourceCount),
  };
}

function sourceCountFromCandidate(candidate) {
  return finiteInteger(candidate?.signals?.sourceCount)
    ?? (Array.isArray(candidate?.signals?.sources) ? candidate.signals.sources.length : null)
    ?? 1;
}

export function runnerExpansionProfile(candidate, strat = {}) {
  const cfg = runnerExpansionConfig(strat);
  const mcap = finiteNumber(candidate?.metrics?.marketCapUsd ?? candidate?.mcapSample?.marketCapUsd);
  const holders = finiteInteger(candidate?.metrics?.holderCount);
  const savedWallets = finiteInteger(candidate?.savedWalletExposure?.holderCount) ?? 0;
  const gmgnFees = finiteNumber(candidate?.metrics?.gmgnTotalFeesSol) ?? 0;
  const sourceCount = sourceCountFromCandidate(candidate);

  const checks = {
    enabled: cfg.enabled,
    mcap: mcap != null && mcap >= cfg.minMcapUsd && mcap <= cfg.maxMcapUsd,
    holders: holders != null && holders >= cfg.minHolders && holders <= cfg.maxHolders,
    savedWallets: savedWallets >= cfg.minSavedWallets && savedWallets <= cfg.maxSavedWallets,
    gmgnFees: gmgnFees >= cfg.minGmgnFeeSol && gmgnFees <= cfg.maxGmgnFeeSol,
    sourceCount: sourceCount >= cfg.minSourceCount,
  };

  return {
    tag: RUNNER_EXPANSION_TAG,
    eligible: Object.values(checks).every(Boolean),
    checks,
    metrics: {
      marketCapUsd: mcap,
      holderCount: holders,
      savedWalletHolders: savedWallets,
      gmgnTotalFeeSol: gmgnFees,
      sourceCount,
    },
    config: cfg,
  };
}

export function signalLooksRunnerExpansionEligible(signalMeta = {}, signal = {}, strat = {}) {
  const cfg = runnerExpansionConfig(strat);
  if (!cfg.enabled) return false;
  const sourceCount = finiteInteger(signalMeta.sourceCount) ?? finiteInteger(signal.sourceCount) ?? 1;
  const mcap = finiteNumber(signal.marketCapUsd ?? signal.market_cap_usd ?? signal.mcapUsd ?? signal.mcap);
  return sourceCount >= cfg.minSourceCount
    && mcap != null
    && mcap >= cfg.minMcapUsd
    && mcap <= cfg.maxMcapUsd;
}

function tagCandidate(candidate) {
  const tags = new Set([
    ...(Array.isArray(candidate.tags) ? candidate.tags : []),
    RUNNER_EXPANSION_TAG,
  ]);
  candidate.tags = [...tags];
  candidate.signals = {
    ...(candidate.signals || {}),
    tags: [...new Set([
      ...(Array.isArray(candidate.signals?.tags) ? candidate.signals.tags : []),
      RUNNER_EXPANSION_TAG,
    ])],
  };
}

export function applyRunnerExpansion(candidate, filters, strat = {}) {
  const profile = runnerExpansionProfile(candidate, strat);
  const originalFailureCodes = Array.isArray(filters.failureCodes) ? filters.failureCodes : [];
  const overrideable = originalFailureCodes.length > 0
    && originalFailureCodes.every(code => OVERRIDABLE_FAILURE_CODES.has(code));

  if (!profile.eligible) {
    return {
      ...filters,
      runnerExpansion: {
        tag: RUNNER_EXPANSION_TAG,
        applied: false,
        reason: 'profile_not_eligible',
        profile,
      },
    };
  }

  tagCandidate(candidate);
  if (filters.passed) {
    return {
      ...filters,
      runnerExpansion: {
        tag: RUNNER_EXPANSION_TAG,
        applied: false,
        reason: 'normal_filters_passed',
        profile,
      },
    };
  }

  if (!overrideable) {
    return {
      ...filters,
      runnerExpansion: {
        tag: RUNNER_EXPANSION_TAG,
        applied: false,
        reason: 'non_overrideable_failures',
        profile,
      },
    };
  }

  return {
    ...filters,
    passed: true,
    originalPassed: false,
    originalFailureCodes,
    originalFailures: filters.failures || [],
    failures: [],
    failureCodes: [],
    primaryFailureCode: null,
    runnerExpansion: {
      tag: RUNNER_EXPANSION_TAG,
      applied: true,
      reason: 'profile_override',
      originalFailureCodes,
      profile,
    },
  };
}
