const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TIER_RANK = { A: 0, B: 1, C: 2, universe: 3 };
const TIER_LABELS = ['A', 'B', 'C', 'universe', 'unknown'];
const QUALITY_BUCKETS = ['no_wallet_evidence', 'tier_a', 'tier_b', 'tier_c', 'universe_only'];
const RUNNER_THRESHOLDS = [2, 3, 5];
const RECURRENCE_THRESHOLDS = [2, 3, 5];

function emptyWalletRecurrenceFeatures() {
  return {
    candidate_recurring_runner_wallet_count_2x: 0,
    candidate_recurring_runner_wallet_count_3x: 0,
    candidate_recurring_runner_wallet_count_5x: 0,
    candidate_best_wallet_runner_recurrence: 0,
    candidate_has_recurring_runner_wallet: 0,
  };
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  const numeric = values.map(Number).filter(Number.isFinite);
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
}

function median(values) {
  const numeric = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numeric.length) return null;
  const mid = Math.floor(numeric.length / 2);
  return numeric.length % 2 ? numeric[mid] : (numeric[mid - 1] + numeric[mid]) / 2;
}

function percent(part, total) {
  return total ? part / total : null;
}

function arrayFrom(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

function stringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item || '').trim()).filter(Boolean);
}

function uniq(values) {
  return [...new Set(values.filter(value => value != null && value !== '').map(String))];
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isPublicWalletAddress(value) {
  return typeof value === 'string' && ADDRESS_RE.test(value.trim());
}

export function normalizeWalletTier(value) {
  const tier = String(value || '').trim();
  if (tier === 'A' || /^tier[_ -]?a$/i.test(tier) || /^priority$/i.test(tier)) return 'A';
  if (tier === 'B' || /^tier[_ -]?b$/i.test(tier)) return 'B';
  if (tier === 'C' || /^tier[_ -]?c$/i.test(tier)) return 'C';
  if (/^(universe|watch|unknown|none)$/i.test(tier)) return 'universe';
  return 'unknown';
}

function bestTier(tiers) {
  return tiers
    .map(normalizeWalletTier)
    .filter(tier => tier !== 'unknown')
    .sort((a, b) => (TIER_RANK[a] ?? 99) - (TIER_RANK[b] ?? 99))[0] || null;
}

function bestObservedTier(tiers) {
  return bestTier(tiers) || 'unknown';
}

function walletTags(wallet) {
  if (!isPlainObject(wallet)) return [];
  return uniq([
    ...stringArray(wallet.tags),
    ...stringArray(wallet.provider_tags),
    ...stringArray(wallet.providerTags),
    ...stringArray(wallet.gmgn_tags),
    ...stringArray(wallet.gmgnTags),
    ...stringArray(wallet.labels),
    wallet.tag,
    wallet.label,
    wallet.ownerManualLabel,
    wallet.owner_manual_label,
    wallet.owner,
    wallet.ownerLabel,
    wallet.primaryTag,
  ]);
}

function hasSmartDegenSignal(wallet) {
  const haystack = [
    isPlainObject(wallet) ? wallet?.tag : null,
    isPlainObject(wallet) ? wallet?.primaryTag : null,
    ...walletTags(wallet),
  ].filter(Boolean).join(' ');
  return /smart[_ -]?(degen|money)/i.test(haystack);
}

function walletAddressFromObject(wallet) {
  if (!isPlainObject(wallet)) return null;
  for (const key of ['address', 'walletAddress', 'wallet_address', 'publicKey', 'public_key', 'ownerAddress', 'owner_address']) {
    const value = wallet[key];
    if (isPublicWalletAddress(value)) return value.trim();
  }
  return null;
}

function candidateWalletContainers(candidate = {}) {
  const containers = [];
  const exposure = candidate.savedWalletExposure
    || candidate.saved_wallet_exposure
    || candidate.savedWallets
    || candidate.saved_wallets
    || null;

  if (isPlainObject(exposure)) {
    containers.push(exposure.matchedWallets, exposure.matched_wallets, exposure.walletMatches, exposure.wallet_matches);
    if (isPlainObject(exposure.evidence)) {
      containers.push(exposure.evidence.wallets, exposure.evidence.matchedWallets, exposure.evidence.matched_wallets);
    }
  }

  for (const key of ['matchedWallets', 'matched_wallets', 'walletMatches', 'wallet_matches', 'candidateWallets', 'candidate_wallets']) {
    containers.push(candidate[key]);
  }

  return containers.flatMap(arrayFrom).filter(item => item != null);
}

function compactWallet(wallet) {
  if (typeof wallet === 'string') {
    return isPublicWalletAddress(wallet) ? { address: wallet.trim(), tier: 'unknown', tags: [] } : null;
  }
  const address = walletAddressFromObject(wallet);
  if (!address) return null;
  const tier = normalizeWalletTier(wallet.tier ?? wallet.walletTier ?? wallet.wallet_tier);
  const tags = walletTags(wallet);
  return {
    address,
    tier,
    tags: tags.slice(0, 5),
    smart_degen: hasSmartDegenSignal(wallet) ? 1 : 0,
  };
}

function qualityBucket({ count, best_wallet_tier }) {
  if (!count) return 'no_wallet_evidence';
  if (best_wallet_tier === 'A') return 'tier_a';
  if (best_wallet_tier === 'B') return 'tier_b';
  if (best_wallet_tier === 'C') return 'tier_c';
  return 'universe_only';
}

export function extractCandidateWalletFeatures(candidate = {}) {
  const byAddress = new Map();
  for (const rawWallet of candidateWalletContainers(candidate)) {
    const wallet = compactWallet(rawWallet);
    if (!wallet) continue;
    const existing = byAddress.get(wallet.address);
    if (!existing) {
      byAddress.set(wallet.address, wallet);
      continue;
    }
    const tier = bestTier([existing.tier, wallet.tier]) || 'unknown';
    byAddress.set(wallet.address, {
      address: wallet.address,
      tier,
      tags: uniq([...(existing.tags || []), ...(wallet.tags || [])]).slice(0, 5),
      smart_degen: existing.smart_degen || wallet.smart_degen ? 1 : 0,
    });
  }

  const wallets = [...byAddress.values()].sort((a, b) => {
    const tierDiff = (TIER_RANK[a.tier] ?? 99) - (TIER_RANK[b.tier] ?? 99);
    if (tierDiff !== 0) return tierDiff;
    return a.address.localeCompare(b.address);
  });
  const tiers = wallets.map(wallet => wallet.tier);
  const best_wallet_tier = bestTier(tiers);
  const count = wallets.length;

  return {
    candidate_wallet_address_count: count,
    candidate_tier_a_wallet_count: wallets.filter(wallet => wallet.tier === 'A').length,
    candidate_best_wallet_tier: best_wallet_tier,
    candidate_smart_degen_present: wallets.some(wallet => wallet.smart_degen) ? 1 : 0,
    candidate_wallet_quality_bucket: qualityBucket({ count, best_wallet_tier }),
    candidate_wallet_addresses: wallets.map(wallet => wallet.address),
    candidate_wallet_evidence: wallets.map(wallet => ({
      address: wallet.address,
      tier: wallet.tier,
      smart_degen: wallet.smart_degen,
      tags: wallet.tags,
    })),
  };
}

function emptyWalletFeatures() {
  return {
    candidate_wallet_address_count: 0,
    candidate_tier_a_wallet_count: 0,
    candidate_best_wallet_tier: null,
    candidate_smart_degen_present: 0,
    candidate_wallet_quality_bucket: 'no_wallet_evidence',
    candidate_wallet_addresses: [],
    candidate_wallet_evidence: [],
    ...emptyWalletRecurrenceFeatures(),
  };
}

export function walletFeatureDefaults() {
  return emptyWalletFeatures();
}

function groupStats(outcomes, threshold, label, rows) {
  const covered = rows.filter(outcome => Number(outcome.candidate_wallet_address_count || 0) > 0);
  const tierA = rows.filter(outcome => Number(outcome.candidate_tier_a_wallet_count || 0) > 0);
  const smartDegen = rows.filter(outcome => Number(outcome.candidate_smart_degen_present || 0) > 0);
  return {
    threshold,
    group: label,
    outcomes: rows.length,
    with_candidate_wallet_evidence: covered.length,
    wallet_evidence_rate: percent(covered.length, rows.length),
    avg_candidate_wallet_address_count: mean(rows.map(outcome => finiteNumber(outcome.candidate_wallet_address_count) ?? 0)),
    median_candidate_wallet_address_count: median(rows.map(outcome => finiteNumber(outcome.candidate_wallet_address_count) ?? 0)),
    avg_candidate_tier_a_wallet_count: mean(rows.map(outcome => finiteNumber(outcome.candidate_tier_a_wallet_count) ?? 0)),
    median_candidate_tier_a_wallet_count: median(rows.map(outcome => finiteNumber(outcome.candidate_tier_a_wallet_count) ?? 0)),
    tier_a_present_count: tierA.length,
    tier_a_present_rate: percent(tierA.length, rows.length),
    smart_degen_present_count: smartDegen.length,
    smart_degen_present_rate: percent(smartDegen.length, rows.length),
  };
}

function countBy(values, allowed) {
  const counts = Object.fromEntries(allowed.map(value => [value, 0]));
  for (const value of values) {
    const key = allowed.includes(value) ? value : 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function summarizeWalletPredictiveness(outcomes, { thresholds = RUNNER_THRESHOLDS } = {}) {
  const total = outcomes.length;
  const withEvidence = outcomes.filter(outcome => Number(outcome.candidate_wallet_address_count || 0) > 0);
  const coverage = {
    total_outcomes: total,
    outcomes_with_candidate_wallet_evidence: withEvidence.length,
    all_outcome_coverage: percent(withEvidence.length, total),
    runners_2x_with_candidate_wallet_evidence: outcomes.filter(outcome => Number(outcome.multiple) >= 2 && Number(outcome.candidate_wallet_address_count || 0) > 0).length,
    runners_2x_total: outcomes.filter(outcome => Number(outcome.multiple) >= 2).length,
    runners_3x_with_candidate_wallet_evidence: outcomes.filter(outcome => Number(outcome.multiple) >= 3 && Number(outcome.candidate_wallet_address_count || 0) > 0).length,
    runners_3x_total: outcomes.filter(outcome => Number(outcome.multiple) >= 3).length,
    runners_5x_with_candidate_wallet_evidence: outcomes.filter(outcome => Number(outcome.multiple) >= 5 && Number(outcome.candidate_wallet_address_count || 0) > 0).length,
    runners_5x_total: outcomes.filter(outcome => Number(outcome.multiple) >= 5).length,
  };
  coverage.runners_2x_coverage = percent(coverage.runners_2x_with_candidate_wallet_evidence, coverage.runners_2x_total);
  coverage.runners_3x_coverage = percent(coverage.runners_3x_with_candidate_wallet_evidence, coverage.runners_3x_total);
  coverage.runners_5x_coverage = percent(coverage.runners_5x_with_candidate_wallet_evidence, coverage.runners_5x_total);

  const thresholdComparison = thresholds.flatMap(threshold => {
    const runners = outcomes.filter(outcome => Number(outcome.multiple) >= threshold);
    const nonRunners = outcomes.filter(outcome => Number(outcome.multiple) < threshold);
    return [
      groupStats(outcomes, threshold, 'runner', runners),
      groupStats(outcomes, threshold, 'non_runner', nonRunners),
    ];
  });

  const qualityByRunnerLabel = [];
  const labels = uniq(outcomes.map(outcome => outcome.runner_label || 'unknown')).sort();
  for (const label of labels) {
    const rows = outcomes.filter(outcome => (outcome.runner_label || 'unknown') === label);
    qualityByRunnerLabel.push({
      runner_label: label,
      total: rows.length,
      ...countBy(rows.map(outcome => outcome.candidate_wallet_quality_bucket || 'no_wallet_evidence'), QUALITY_BUCKETS),
    });
  }

  const bestTierByRunnerLabel = [];
  for (const label of labels) {
    const rows = outcomes.filter(outcome => (outcome.runner_label || 'unknown') === label);
    bestTierByRunnerLabel.push({
      runner_label: label,
      total: rows.length,
      ...countBy(rows.map(outcome => outcome.candidate_best_wallet_tier || 'unknown'), TIER_LABELS),
    });
  }

  return {
    coverage,
    threshold_comparison: thresholdComparison,
    quality_by_runner_label: qualityByRunnerLabel,
    best_tier_by_runner_label: bestTierByRunnerLabel,
    limitations: [
      'Candidate wallet evidence is candidate-only; tokens that never reached candidates cannot expose full wallet addresses here.',
      'signal_events and screening_events contain saved-wallet counts only, not full wallet addresses.',
    ],
  };
}

function evidenceByAddress(outcome) {
  const evidence = new Map();
  for (const raw of arrayFrom(outcome?.candidate_wallet_evidence)) {
    if (!isPlainObject(raw)) continue;
    const address = walletAddressFromObject(raw);
    if (!address) continue;
    const existing = evidence.get(address);
    const tier = normalizeWalletTier(raw.tier ?? raw.walletTier ?? raw.wallet_tier);
    const tags = walletTags(raw);
    evidence.set(address, {
      tier: bestObservedTier([existing?.tier, tier]),
      tags: uniq([...(existing?.tags || []), ...tags]),
      smart_degen: existing?.smart_degen || hasSmartDegenSignal(raw) || raw.smart_degen === 1 ? 1 : 0,
    });
  }
  return evidence;
}

function outcomeWalletEntries(outcome) {
  const addresses = arrayFrom(outcome?.candidate_wallet_addresses)
    .map(value => String(value || '').trim())
    .filter(isPublicWalletAddress);
  const evidence = evidenceByAddress(outcome);
  for (const address of evidence.keys()) addresses.push(address);

  return uniq(addresses).map(address => {
    const detail = evidence.get(address) || {};
    return {
      address,
      tier: normalizeWalletTier(detail.tier),
      tags: stringArray(detail.tags),
      smart_degen: detail.smart_degen ? 1 : 0,
    };
  });
}

function compactMintSample(mints, limit) {
  return mints
    .slice()
    .sort((a, b) => Number(b.multiple || 0) - Number(a.multiple || 0) || String(a.mint).localeCompare(String(b.mint)))
    .slice(0, limit);
}

export function buildWalletRecurrenceIndex(outcomes, {
  runnerThreshold = 2,
  thresholds = RECURRENCE_THRESHOLDS,
  topLimit = 25,
  mintSampleLimit = 10,
} = {}) {
  const byAddress = new Map();

  for (const outcome of outcomes || []) {
    const mint = String(outcome?.mint || '').trim();
    if (!mint) continue;
    const multiple = finiteNumber(outcome?.multiple) ?? 0;
    const entries = outcomeWalletEntries(outcome);
    if (!entries.length) continue;

    for (const wallet of entries) {
      if (!byAddress.has(wallet.address)) {
        byAddress.set(wallet.address, {
          wallet_address: wallet.address,
          mintMap: new Map(),
          tiers: [],
          tags: [],
          smart_degen_mints: new Set(),
        });
      }
      const row = byAddress.get(wallet.address);
      row.tiers.push(wallet.tier);
      row.tags.push(...wallet.tags);
      if (wallet.smart_degen) row.smart_degen_mints.add(mint);

      const existing = row.mintMap.get(mint);
      row.mintMap.set(mint, {
        mint,
        multiple: Math.max(Number(existing?.multiple || 0), multiple),
        runner_label: outcome?.runner_label || existing?.runner_label || null,
      });
    }
  }

  const walletRows = [...byAddress.values()].map(row => {
    const mintRows = [...row.mintMap.values()];
    const runnerMints = mintRows.filter(mint => Number(mint.multiple || 0) >= runnerThreshold);
    const thresholdCounts = Object.fromEntries(thresholds.map(threshold => [
      `runner_${threshold}x_mint_count`,
      mintRows.filter(mint => Number(mint.multiple || 0) >= threshold).length,
    ]));
    const observedTiers = uniq(row.tiers.map(normalizeWalletTier)).sort((a, b) => (TIER_RANK[a] ?? 99) - (TIER_RANK[b] ?? 99));
    const observedTags = uniq(row.tags).sort((a, b) => a.localeCompare(b));

    return {
      wallet_address: row.wallet_address,
      distinct_mint_count: mintRows.length,
      runner_mint_count: runnerMints.length,
      non_runner_mint_count: mintRows.length - runnerMints.length,
      ...thresholdCounts,
      max_multiple: mintRows.length ? Math.max(...mintRows.map(mint => Number(mint.multiple || 0))) : null,
      best_observed_tier: bestObservedTier(observedTiers),
      observed_tiers: observedTiers,
      observed_tags: observedTags,
      smart_degen_mint_count: row.smart_degen_mints.size,
      runner_mints: runnerMints.map(mint => mint.mint).sort(),
      runner_mints_sample: compactMintSample(runnerMints, mintSampleLimit),
      all_mints_sample: compactMintSample(mintRows, mintSampleLimit),
    };
  }).sort((a, b) => (
    Number(b.runner_mint_count || 0) - Number(a.runner_mint_count || 0)
    || Number(b.runner_5x_mint_count || 0) - Number(a.runner_5x_mint_count || 0)
    || Number(b.runner_3x_mint_count || 0) - Number(a.runner_3x_mint_count || 0)
    || Number(b.max_multiple || 0) - Number(a.max_multiple || 0)
    || String(a.wallet_address).localeCompare(String(b.wallet_address))
  ));

  const thresholdSummaries = thresholds.map(minRunnerMints => {
    const recurring = walletRows.filter(wallet => Number(wallet.runner_mint_count || 0) >= minRunnerMints);
    const coveredRunnerMints = new Set(recurring.flatMap(wallet => wallet.runner_mints || []));
    return {
      min_runner_mints: minRunnerMints,
      recurring_wallet_count: recurring.length,
      distinct_runner_mints_covered: coveredRunnerMints.size,
      total_runner_mint_links: recurring.reduce((sum, wallet) => sum + Number(wallet.runner_mint_count || 0), 0),
      max_runner_mint_count: recurring.length ? Math.max(...recurring.map(wallet => Number(wallet.runner_mint_count || 0))) : 0,
      wallets_with_3x_runner_mints: recurring.filter(wallet => Number(wallet.runner_3x_mint_count || 0) > 0).length,
      wallets_with_5x_runner_mints: recurring.filter(wallet => Number(wallet.runner_5x_mint_count || 0) > 0).length,
    };
  });

  return {
    runner_threshold: runnerThreshold,
    total_wallets: walletRows.length,
    recurring_runner_wallets: walletRows.filter(wallet => Number(wallet.runner_mint_count || 0) >= 2).length,
    top_recurring_wallets: walletRows.filter(wallet => Number(wallet.runner_mint_count || 0) > 0).slice(0, topLimit),
    wallet_rows: walletRows,
    threshold_summaries: thresholdSummaries,
    limitations: [
      'Wallet recurrence is based on candidate-stage public wallet evidence only.',
      'Repeated evidence for the same wallet within one mint is deduplicated and counts once.',
      'Recurrence does not prove the wallet bought before shadow first sighting; it is a prioritization signal only.',
    ],
  };
}

export function deriveWalletRecurrenceFeatures(outcome, recurrenceIndex, {
  thresholds = RECURRENCE_THRESHOLDS,
} = {}) {
  const walletRows = new Map((recurrenceIndex?.wallet_rows || []).map(row => [row.wallet_address, row]));
  const entries = outcomeWalletEntries(outcome);
  const counts = Object.fromEntries(thresholds.map(threshold => [
    `candidate_recurring_runner_wallet_count_${threshold}x`,
    0,
  ]));
  let bestRecurrence = 0;

  for (const wallet of entries) {
    const row = walletRows.get(wallet.address);
    if (!row) continue;
    const runnerMintCount = Number(row.runner_mint_count || 0);
    bestRecurrence = Math.max(bestRecurrence, runnerMintCount);
    for (const threshold of thresholds) {
      if (runnerMintCount >= threshold) counts[`candidate_recurring_runner_wallet_count_${threshold}x`] += 1;
    }
  }

  return {
    ...emptyWalletRecurrenceFeatures(),
    ...counts,
    candidate_best_wallet_runner_recurrence: bestRecurrence,
    candidate_has_recurring_runner_wallet: bestRecurrence >= 2 ? 1 : 0,
  };
}

export function attachWalletRecurrenceFeatures(outcomes, recurrenceIndex, options = {}) {
  for (const outcome of outcomes || []) {
    Object.assign(outcome, deriveWalletRecurrenceFeatures(outcome, recurrenceIndex, options));
  }
  return outcomes;
}
