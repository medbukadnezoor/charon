export function decayedWeight(previousWeight, elapsedMs, halfLifeMs) {
  if (!Number.isFinite(previousWeight)) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return previousWeight;
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) return previousWeight;
  return previousWeight * Math.pow(0.5, elapsedMs / halfLifeMs);
}

export function updateFeatureWeight({
  currentWeight = 0,
  currentConfidence = 0,
  currentSamples = 0,
  reward,
  rewardWeight = 1,
  elapsedMs = 0,
  halfLifeMs,
}) {
  const base = decayedWeight(Number(currentWeight) || 0, elapsedMs, halfLifeMs);
  const sampleWeight = Math.max(0, Number(rewardWeight) || 0);
  const samples = Math.max(0, Number(currentSamples) || 0);
  const learningRate = sampleWeight / Math.max(4, samples + sampleWeight);
  const nextWeight = base + learningRate * ((Number(reward) || 0) - base);
  const nextSamples = samples + sampleWeight;
  return {
    weight: nextWeight,
    confidence: Math.min(1, Math.max(Number(currentConfidence) || 0, Math.sqrt(nextSamples) / 10)),
    sample_count: nextSamples,
  };
}

export function scoreFeatureSnapshot(snapshot, weights = new Map()) {
  const keys = snapshot?.feature_keys || [];
  if (!keys.length) return { score: 0, matched: [] };
  const matched = [];
  let sum = 0;
  for (const key of keys) {
    const row = weights instanceof Map ? weights.get(key) : weights[key];
    if (!row) continue;
    const weight = Number(row.weight) || 0;
    const confidence = Number(row.confidence) || 0;
    const contribution = weight * Math.max(0.1, confidence);
    sum += contribution;
    matched.push({ feature_key: key, weight, confidence, contribution });
  }
  return {
    score: sum / Math.sqrt(keys.length),
    matched: matched.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)).slice(0, 12),
  };
}
