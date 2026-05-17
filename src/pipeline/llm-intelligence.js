const TIER_ORDER = { A: 0, B: 1, C: 2, universe: 3 };
const SEVERITY_SCORE = { critical: 4, high: 3, medium: 2, low: 1 };

export function compactNumber(value, decimals = 6) {
  const num = Number(value);
  if (!Number.isFinite(num)) return value ?? null;
  return Number(num.toFixed(decimals));
}

export function jsonSizeBytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function classifyTier(conclusion = {}) {
  const severity = String(conclusion.severity || 'low').toLowerCase();
  const confidence = Number(conclusion.confidence) || 0;
  if (severity === 'critical') return 'critical';
  if (severity === 'high' && confidence > 70) return 'critical';
  if (severity === 'medium') return 'notable';
  if (severity === 'high' && confidence <= 70) return 'notable';
  return 'routine';
}

function orderedConclusions(conclusions = []) {
  return conclusions
    .map((conclusion, index) => ({ conclusion, index }))
    .sort((a, b) => {
      const severityDiff = (SEVERITY_SCORE[b.conclusion?.severity] ?? 0) - (SEVERITY_SCORE[a.conclusion?.severity] ?? 0);
      if (severityDiff !== 0) return severityDiff;
      const confidenceDiff = (Number(b.conclusion?.confidence) || 0) - (Number(a.conclusion?.confidence) || 0);
      if (confidenceDiff !== 0) return confidenceDiff;
      return a.index - b.index;
    })
    .map(item => item.conclusion);
}

function normalizeTier(tier) {
  const value = String(tier || 'universe');
  if (value === 'A' || value === 'B' || value === 'C') return value;
  return 'universe';
}

export function computeOverlapQuality(matchedWallets = []) {
  const wallets = Array.isArray(matchedWallets) ? matchedWallets : [];
  const counts = { A: 0, B: 0, C: 0, universe: 0 };
  const winrates = [];

  for (const wallet of wallets) {
    const tier = normalizeTier(wallet?.tier);
    counts[tier] += 1;
    const wr = Number(wallet?.gmgn?.wr ?? wallet?.gmgn_winrate);
    if (Number.isFinite(wr)) winrates.push(wr);
  }

  const avgWinrate = winrates.length ? winrates.reduce((sum, value) => sum + value, 0) / winrates.length : null;
  const score = Math.min(100,
    Math.min(counts.A * 30, 90)
      + Math.min(counts.B * 15, 60)
      + Math.min(counts.C * 8, 30)
      + Math.min(counts.universe * 3, 15)
      + (avgWinrate != null && avgWinrate > 0.65 ? 10 : 0));
  return Math.max(0, Math.min(100, score));
}

function tierDistribution(wallets = []) {
  const counts = { A: 0, B: 0, C: 0, universe: 0 };
  for (const wallet of wallets) counts[normalizeTier(wallet?.tier)] += 1;
  return {
    counts,
    text: [`${counts.A}A`, `${counts.B}B`, `${counts.C}C`, `${counts.universe} universe`].join(', '),
  };
}

export function overlapEnvelope(exposure = {}, score = 0) {
  const wallets = Array.isArray(exposure?.evidence?.wallets) ? exposure.evidence.wallets : [];
  const distribution = tierDistribution(wallets);
  const count = exposure?.holderCount ?? wallets.length;
  if (score > 70) {
    const topMatchedWallets = [...wallets]
      .sort((a, b) => {
        const tierDiff = (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99);
        if (tierDiff !== 0) return tierDiff;
        return (Number(b.gmgn?.wr) || 0) - (Number(a.gmgn?.wr) || 0);
      })
      .slice(0, 3)
      .map(wallet => ({
        addr: wallet.addr,
        tier: normalizeTier(wallet.tier),
        gmgnWinrate: wallet.gmgn?.wr ?? null,
      }));
    return { count, tierDistribution: distribution.text, topMatchedWallets };
  }
  if (score >= 30) return { count, tierDistribution: distribution.text };
  return { count, low_quality_overlap: count > 0 };
}

export function buildTieredEnvelope(analysisResult = {}, overlapData = {}) {
  const matchedWallets = Array.isArray(overlapData?.evidence?.wallets) ? overlapData.evidence.wallets : [];
  const overlapQualityScore = computeOverlapQuality(matchedWallets);
  const summary = {
    count: analysisResult.summary?.count ?? null,
    top5Percent: compactNumber(analysisResult.summary?.top5Percent, 4),
    top10Percent: compactNumber(analysisResult.summary?.top10Percent, 4),
    top20Percent: compactNumber(analysisResult.summary?.top20Percent, 4),
    maxHolderPercent: compactNumber(analysisResult.summary?.maxHolderPercent, 4),
    largeHolderCount: analysisResult.summary?.largeHolderCount ?? null,
    concentrationRisk: analysisResult.summary?.concentrationRisk ?? null,
    smartWalletOverlap: overlapData?.holderCount ?? 0,
    overlapQualityScore,
  };

  const conclusions = orderedConclusions(Array.isArray(analysisResult.conclusions) ? analysisResult.conclusions : [])
    .map(conclusion => {
      const tier = classifyTier(conclusion);
      const base = {
        signal: String(conclusion?.signal || 'unknown'),
        severity: String(conclusion?.severity || 'low'),
        confidence: Math.max(0, Math.min(100, Number(conclusion?.confidence) || 0)),
        tier,
      };
      const explanation = typeof conclusion?.explanation === 'string' ? conclusion.explanation : '';
      const evidence = Array.isArray(conclusion?.evidence) ? conclusion.evidence.map(String) : [];
      if (tier === 'critical') {
        return {
          ...base,
          explanation,
          evidence: evidence.slice(0, 5),
          metrics: conclusion?.metrics || {},
        };
      }
      if (tier === 'notable') {
        return {
          ...base,
          explanation,
          evidence: evidence.slice(0, 2),
        };
      }
      return {
        signal: base.signal,
        severity: base.severity,
        confidence: base.confidence,
        tier,
        explanation,
      };
    });

  return {
    summary,
    conclusions,
    smartWalletEvidence: overlapEnvelope(overlapData, overlapQualityScore),
    dataIncomplete: Boolean(analysisResult.dataIncomplete),
  };
}

function hasCriticalConclusion(candidate = {}) {
  return (candidate.holderIntelligence?.conclusions || [])
    .some(conclusion => conclusion.tier === 'critical');
}

export function enforcePayloadBudget(payload, budgetBytes) {
  const working = JSON.parse(JSON.stringify(payload));
  const trimStages = [];
  let candidatesRemoved = 0;
  const size = () => jsonSizeBytes(working);

  if (size() <= budgetBytes) {
    return { payload: working, trimStages, candidatesRemoved, skipped: false, payloadSizeBytes: size() };
  }

  for (const candidate of working.candidates || []) {
    if (candidate.chart) candidate.chart.windows = [];
  }
  trimStages.push('a');
  if (size() <= budgetBytes) return { payload: working, trimStages, candidatesRemoved, skipped: false, payloadSizeBytes: size() };

  for (const candidate of working.candidates || []) {
    for (const conclusion of candidate.holderIntelligence?.conclusions || []) {
      if (conclusion.tier === 'routine') {
        delete conclusion.explanation;
        delete conclusion.evidence;
        delete conclusion.metrics;
      }
    }
  }
  trimStages.push('b');
  if (size() <= budgetBytes) return { payload: working, trimStages, candidatesRemoved, skipped: false, payloadSizeBytes: size() };

  for (const candidate of working.candidates || []) {
    for (const conclusion of candidate.holderIntelligence?.conclusions || []) {
      if (conclusion.tier === 'notable') {
        delete conclusion.evidence;
        delete conclusion.metrics;
      }
    }
  }
  trimStages.push('c');
  if (size() <= budgetBytes) return { payload: working, trimStages, candidatesRemoved, skipped: false, payloadSizeBytes: size() };

  trimStages.push('d');
  while ((working.candidates || []).length > 1 && size() > budgetBytes) {
    const removableIndexes = working.candidates
      .map((candidate, index) => ({ candidate, index }))
      .filter(item => !hasCriticalConclusion(item.candidate));
    if (!removableIndexes.length) break;
    let removeIndex = removableIndexes[0].index;
    for (const { candidate, index } of removableIndexes.slice(1)) {
      const current = working.candidates[removeIndex];
      const overlap = candidate.holderIntelligence?.summary?.smartWalletOverlap ?? candidate.savedWalletExposure?.holderCount ?? 0;
      const currentOverlap = current.holderIntelligence?.summary?.smartWalletOverlap ?? current.savedWalletExposure?.holderCount ?? 0;
      const score = candidate.holderIntelligence?.summary?.overlapQualityScore ?? 0;
      const currentScore = current.holderIntelligence?.summary?.overlapQualityScore ?? 0;
      if (overlap < currentOverlap || (overlap === currentOverlap && score < currentScore)) removeIndex = index;
    }
    working.candidates.splice(removeIndex, 1);
    candidatesRemoved += 1;
  }

  const payloadSizeBytes = size();
  if (payloadSizeBytes > budgetBytes) {
    return { payload: working, trimStages, candidatesRemoved, skipped: true, payloadSizeBytes };
  }
  return { payload: working, trimStages, candidatesRemoved, skipped: false, payloadSizeBytes };
}
