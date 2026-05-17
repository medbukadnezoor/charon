import { db } from './connection.js';
import { boolSetting, numSetting } from './settings.js';
import { now } from '../utils.js';

const TOKEN_BYTES_RATIO = 4;

export function estimateTokensFromBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.ceil(size / TOKEN_BYTES_RATIO);
}

export function costTrackingEnabled() {
  return boolSetting('llm_cost_tracking_enabled', false);
}

export function calculateEstimatedCost({
  promptTokens = 0,
  completionTokens = 0,
  inputCostPer1m = numSetting('llm_input_cost_per_1m_tokens', 0),
  outputCostPer1m = numSetting('llm_output_cost_per_1m_tokens', 0),
  enabled = costTrackingEnabled(),
} = {}) {
  const inputRate = Number(inputCostPer1m);
  const outputRate = Number(outputCostPer1m);
  const prompt = Number(promptTokens);
  const completion = Number(completionTokens);
  if (!enabled || inputRate <= 0 || outputRate <= 0) return null;
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  return (prompt / 1_000_000) * inputRate + (completion / 1_000_000) * outputRate;
}

export function normalizeUsageTokens({ usage = {}, requestBytes = null, responseBytes = null } = {}) {
  const promptTokens = Number(usage?.prompt_tokens);
  const completionTokens = Number(usage?.completion_tokens);
  const totalTokens = Number(usage?.total_tokens);
  const hasProviderUsage = Number.isFinite(promptTokens)
    || Number.isFinite(completionTokens)
    || Number.isFinite(totalTokens);

  if (hasProviderUsage) {
    const prompt = Number.isFinite(promptTokens) ? promptTokens : null;
    const completion = Number.isFinite(completionTokens) ? completionTokens : null;
    const total = Number.isFinite(totalTokens)
      ? totalTokens
      : (Number.isFinite(prompt) && Number.isFinite(completion) ? prompt + completion : null);
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      tokenEstimateMethod: 'provider_usage',
    };
  }

  const prompt = estimateTokensFromBytes(requestBytes);
  const completion = estimateTokensFromBytes(responseBytes);
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    tokenEstimateMethod: 'estimated_bytes_div_4',
  };
}

export function logUsageEvent({
  status,
  provider = null,
  model = null,
  batchId = null,
  triggerCandidateId = null,
  candidateCount = null,
  requestBytes = null,
  responseBytes = null,
  latencyMs = null,
  usage = null,
  promptTokens = null,
  completionTokens = null,
  totalTokens = null,
  tokenEstimateMethod = null,
  estimatedCostUsd = undefined,
  errorClass = null,
  createdAtMs = now(),
} = {}) {
  const shouldEstimateFromBytes = promptTokens == null
    && completionTokens == null
    && totalTokens == null
    && (requestBytes != null || responseBytes != null);
  const normalized = usage != null || shouldEstimateFromBytes
    ? normalizeUsageTokens({ usage, requestBytes, responseBytes })
    : {
        promptTokens,
        completionTokens,
        totalTokens,
        tokenEstimateMethod,
      };
  const cost = estimatedCostUsd === undefined
    ? calculateEstimatedCost({
        promptTokens: normalized.promptTokens,
        completionTokens: normalized.completionTokens,
      })
    : estimatedCostUsd;

  const result = db.prepare(`
    INSERT INTO llm_usage_events (
      created_at_ms, status, provider, model, batch_id, trigger_candidate_id,
      candidate_count, request_bytes, response_bytes, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, token_estimate_method,
      estimated_cost_usd, error_class
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    createdAtMs,
    String(status),
    provider,
    model,
    batchId,
    triggerCandidateId,
    candidateCount,
    requestBytes,
    responseBytes,
    latencyMs,
    normalized.promptTokens,
    normalized.completionTokens,
    normalized.totalTokens,
    normalized.tokenEstimateMethod,
    cost,
    errorClass,
  );
  return Number(result.lastInsertRowid);
}
