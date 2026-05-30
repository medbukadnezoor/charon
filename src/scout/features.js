function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const parsed = finiteNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function bandNumber(value, bands, fallback = 'unknown') {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  for (const band of bands) {
    if (parsed >= band.min && parsed < band.max) return band.label;
  }
  return bands.at(-1)?.label || fallback;
}

function boolBand(value) {
  return Number(value || 0) > 0 ? 'present' : 'absent';
}

function cleanKey(value) {
  return String(value ?? 'unknown').replace(/\s+/g, '_').slice(0, 80);
}

function sourceList(candidate) {
  const signals = candidate?.signals || {};
  const raw = [
    ...(Array.isArray(signals.sources) ? signals.sources : []),
    signals.route,
    candidate?.trending?.source,
    candidate?.graduation ? 'graduation' : null,
    candidate?.feeClaim ? 'fee_claim' : null,
  ];
  return [...new Set(raw.filter(Boolean).map(value => String(value).toLowerCase()))].sort();
}

function walletTags(candidate) {
  const wallets = candidate?.savedWalletExposure?.evidence?.wallets || [];
  const tags = [];
  for (const wallet of wallets) {
    if (wallet.tier) tags.push(`tier:${wallet.tier}`);
    for (const tag of wallet.tags || []) tags.push(`tag:${tag}`);
    if (wallet.owner_label) tags.push(`owner:${wallet.owner_label}`);
  }
  return [...new Set(tags.map(cleanKey))].sort().slice(0, 12);
}

export function extractScoutFeatureSnapshot(candidate, {
  asOfMs = Date.now(),
  observations = [],
  llmDecision = null,
  decisionPath = null,
} = {}) {
  const futureObservation = observations.find(row => Number(row?.observed_at_ms) > asOfMs);
  if (futureObservation) {
    throw new Error(`future observation rejected for scout feature snapshot: ${futureObservation.observed_at_ms} > ${asOfMs}`);
  }

  const mcap = firstNumber(
    candidate?.mcapSample?.marketCapUsd,
    candidate?.metrics?.marketCapUsd,
    candidate?.metrics?.graduatedMarketCapUsd,
  );
  const liquidity = firstNumber(candidate?.metrics?.liquidityUsd, candidate?.trending?.liquidityUsd);
  const athDistance = firstNumber(
    candidate?.chart?.distanceFromAthPercent,
    candidate?.chart?.belowRangeHighPercent,
  );
  const recoveryFromLow = firstNumber(candidate?.chart?.aboveLowPercent);
  const top20 = firstNumber(candidate?.holders?.top20Percent, candidate?.filters?.top20HolderPercent);
  const maxHolder = firstNumber(candidate?.holders?.maxHolderPercent, candidate?.filters?.maxHolderPercent);
  const savedWallets = firstNumber(candidate?.savedWalletExposure?.holderCount, candidate?.filters?.savedWalletHolders) || 0;
  const sourceCount = firstNumber(candidate?.signals?.sourceCount, sourceList(candidate).length) || 0;
  const feeClaimSol = firstNumber(candidate?.feeClaim?.claimSol, candidate?.feeClaim?.sol, candidate?.filters?.feeClaimSol) || 0;
  const verdict = String(llmDecision?.verdict || candidate?.llmDecision?.verdict || 'none').toUpperCase();
  const confidence = firstNumber(llmDecision?.confidence, candidate?.llmDecision?.confidence) || 0;
  const sources = sourceList(candidate);
  const tags = walletTags(candidate);

  const fields = {
    as_of_ms: asOfMs,
    mint: candidate?.token?.mint || null,
    mcap_usd: mcap,
    liquidity_usd: liquidity,
    ath_distance_pct: athDistance,
    recovery_from_low_pct: recoveryFromLow,
    source_count: sourceCount,
    sources,
    fee_claim_sol: feeClaimSol,
    top20_holder_percent: top20,
    max_holder_percent: maxHolder,
    saved_wallet_holders: savedWallets,
    wallet_tags: tags,
    llm_verdict: verdict,
    llm_confidence: confidence,
    observation_path: decisionPath || candidate?.signals?.route || 'unknown',
  };

  const featureKeys = [
    `mcap:${bandNumber(mcap, [
      { label: '<10k', min: 0, max: 10_000 },
      { label: '10k-25k', min: 10_000, max: 25_000 },
      { label: '25k-50k', min: 25_000, max: 50_000 },
      { label: '50k-100k', min: 50_000, max: 100_000 },
      { label: '100k+', min: 100_000, max: Infinity },
    ])}`,
    `liquidity:${bandNumber(liquidity, [
      { label: '<8k', min: 0, max: 8_000 },
      { label: '8k-25k', min: 8_000, max: 25_000 },
      { label: '25k-75k', min: 25_000, max: 75_000 },
      { label: '75k+', min: 75_000, max: Infinity },
    ])}`,
    `ath_distance:${bandNumber(athDistance, [
      { label: 'near_high', min: -10, max: Infinity },
      { label: 'pulled_back', min: -45, max: -10 },
      { label: 'deep_pullback', min: -1000, max: -45 },
    ])}`,
    `source_count:${sourceCount >= 3 ? '3+' : sourceCount}`,
    `fee_claim:${boolBand(feeClaimSol)}`,
    `top20:${bandNumber(top20, [
      { label: '<45', min: 0, max: 45 },
      { label: '45-70', min: 45, max: 70 },
      { label: '70+', min: 70, max: Infinity },
    ])}`,
    `saved_wallets:${savedWallets >= 3 ? '3+' : savedWallets}`,
    `llm:${verdict}:${bandNumber(confidence, [
      { label: '<60', min: 0, max: 60 },
      { label: '60-79', min: 60, max: 80 },
      { label: '80+', min: 80, max: Infinity },
    ])}`,
    `path:${cleanKey(fields.observation_path)}`,
    ...sources.slice(0, 6).map(source => `source:${cleanKey(source)}`),
    ...tags.map(tag => `wallet:${tag}`),
  ];

  return {
    fields,
    feature_keys: [...new Set(featureKeys)],
  };
}

export function summarizeScoutFeatures(snapshot) {
  const fields = snapshot?.fields || {};
  return {
    mcap_usd: fields.mcap_usd,
    liquidity_usd: fields.liquidity_usd,
    ath_distance_pct: fields.ath_distance_pct,
    saved_wallet_holders: fields.saved_wallet_holders,
    source_count: fields.source_count,
    wallet_tags: fields.wallet_tags || [],
    llm_verdict: fields.llm_verdict,
    llm_confidence: fields.llm_confidence,
  };
}
