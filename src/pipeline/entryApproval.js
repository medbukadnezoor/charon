export function effectiveLlmMinConfidence(strategy, globalFallback = 75) {
  const strategyValue = strategy?.llm_min_confidence;
  if (strategyValue === undefined || strategyValue === null || strategyValue === '') {
    return globalFallback;
  }

  const threshold = Number(strategyValue);
  return Number.isFinite(threshold) ? threshold : globalFallback;
}

export function shouldApproveEntry({ selectedRow, agentEnabled, decision, confidenceThreshold }) {
  return Boolean(
    selectedRow
      && agentEnabled
      && decision?.verdict === 'BUY'
      && Number(decision.confidence) >= confidenceThreshold
  );
}
