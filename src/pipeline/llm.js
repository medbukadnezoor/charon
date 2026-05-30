import axios from 'axios';
import { LLM_MAX_COMPLETION_TOKENS, LLM_MODEL, LLM_REASONING_EFFORT, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { logUsageEvent, normalizeUsageTokens } from '../db/usage.js';
import { analyzeHolders } from '../enrichment/holder-intelligence.js';
import { llmConfigured, postChatCompletion, primaryLlmProvider } from '../llm/providers.js';
import { buildLearnedPolicyContext } from '../db/scoutPolicy.js';
import {
  buildTieredEnvelope,
  classifyTier,
  compactNumber,
  computeOverlapQuality,
  enforcePayloadBudget,
  jsonSizeBytes,
  overlapEnvelope,
} from './llm-intelligence.js';

export {
  buildTieredEnvelope,
  classifyTier,
  computeOverlapQuality,
  enforcePayloadBudget,
};

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    risk_profile: ['conservative', 'standard', 'runner'].includes(String(parsed?.risk_profile || '').toLowerCase())
      ? String(parsed.risk_profile).toLowerCase()
      : null,
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

function llmProviderName() {
  return primaryLlmProvider()?.label || primaryLlmProvider({ includeUnavailable: true })?.label || 'openai-compatible';
}

function errorClass(err) {
  if (err?.errorClass) return err.errorClass;
  if (err?.code === 'ECONNABORTED' || /timeout/i.test(String(err?.message || ''))) return 'timeout';
  if (err?.response?.status) return `http_${err.response.status}`;
  return err?.name || 'error';
}

function safeLogUsageEvent(event) {
  try {
    return logUsageEvent(event);
  } catch (err) {
    console.log(`[llm] usage ledger write failed: ${err.message}`);
    return null;
  }
}

function llmSemanticError(errorClassName, message, responseBytes = 0, cause = null) {
  const err = new Error(message);
  err.name = 'LlmSemanticError';
  err.errorClass = errorClassName;
  err.responseBytes = responseBytes;
  if (cause) err.cause = cause;
  return err;
}

function validateDecisionSchema(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw llmSemanticError('invalid_decision_schema', 'LLM response is not a decision object.');
  }
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!['BUY', 'WATCH', 'PASS'].includes(verdict)) {
    throw llmSemanticError('invalid_decision_schema', 'LLM response has invalid or missing verdict.');
  }
  const confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw llmSemanticError('invalid_decision_schema', 'LLM response has invalid or missing confidence.');
  }
  if (verdict === 'BUY' && parsed.selected_candidate_id == null && !parsed.selected_mint) {
    throw llmSemanticError('invalid_decision_schema', 'BUY decision is missing selected candidate identity.');
  }
  return parsed;
}

function validateBatchDecisionResponse({ response }) {
  const content = String(response?.data?.choices?.[0]?.message?.content || '');
  const responseBytes = Buffer.byteLength(content, 'utf8');
  if (responseBytes === 0) {
    throw llmSemanticError('empty_content', 'LLM response content was empty.', responseBytes);
  }
  try {
    return validateDecisionSchema(strictJsonFromText(content));
  } catch (err) {
    if (err?.errorClass) {
      err.responseBytes = responseBytes;
      throw err;
    }
    throw llmSemanticError('parse_error', 'LLM response was not valid strict JSON.', responseBytes, err);
  }
}

function logFailedProviderAttempts(attempts, {
  triggerCandidateId,
  candidateCount,
  requestBytes,
} = {}) {
  for (const attempt of attempts || []) {
    if (attempt.status !== 'error') continue;
    safeLogUsageEvent({
      status: attempt.errorClass === 'timeout' ? 'timeout' : 'error',
      provider: attempt.providerLabel || attempt.provider || llmProviderName(),
      model: attempt.model || primaryLlmProvider()?.model || primaryLlmProvider({ includeUnavailable: true })?.model || LLM_MODEL,
      triggerCandidateId,
      candidateCount,
      requestBytes,
      responseBytes: attempt.responseBytes || 0,
      latencyMs: attempt.latencyMs || 0,
      errorClass: attempt.errorClass || 'error',
    });
  }
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

function compactHolder(holder = {}) {
  return [
    holder.rank ?? null,
    holder.address,
    holder.amount ?? null,
    holder.percent ?? null,
    Array.isArray(holder.tags) ? holder.tags.map(String) : [],
  ];
}

function fallbackConcentrationRisk(maxPct, top20Pct) {
  const maxHolder = Number(maxPct);
  const top20 = Number(top20Pct);
  if ((Number.isFinite(maxHolder) && maxHolder > 25) || (Number.isFinite(top20) && top20 > 80)) return 'critical';
  if ((Number.isFinite(maxHolder) && maxHolder > 15) || (Number.isFinite(top20) && top20 > 60)) return 'high';
  if ((Number.isFinite(maxHolder) && maxHolder > 5) || (Number.isFinite(top20) && top20 > 40)) return 'medium';
  return 'low';
}

function sumHolderPercents(holderRows, limit) {
  const rows = [...holderRows]
    .sort((a, b) => (Number(a.rank) || 999999) - (Number(b.rank) || 999999))
    .slice(0, limit);
  if (!rows.length) return null;
  return compactNumber(rows.reduce((sum, holder) => {
    const percent = Number(holder.percent);
    return sum + (Number.isFinite(percent) ? percent : 0);
  }, 0), 4);
}

function compactHoldersForLlm(holders = {}, exposure = {}) {
  const holderRows = Array.isArray(holders.holders) ? holders.holders : [];
  const percents = holderRows
    .map(holder => Number(holder.percent))
    .filter(Number.isFinite);
  const top20Percent = compactNumber(holders.top20Percent ?? sumHolderPercents(holderRows, 20), 4);
  const maxHolderPercent = compactNumber(
    holders.maxHolderPercent ?? (percents.length ? Math.max(...percents) : null),
    4,
  );
  const overlapWallets = exposure?.evidence?.wallets || [];
  const overlapQualityScore = computeOverlapQuality(overlapWallets);
  return {
    summary: {
      count: holders.count ?? holderRows.length,
      top5Percent: sumHolderPercents(holderRows, 5),
      top10Percent: sumHolderPercents(holderRows, 10),
      top20Percent,
      maxHolderPercent,
      largeHolderCount: percents.filter(value => value > 2).length,
      concentrationRisk: fallbackConcentrationRisk(maxHolderPercent, top20Percent),
      smartWalletOverlap: exposure?.holderCount ?? 0,
      overlapQualityScore,
    },
    sampleHolders: holderRows.slice(0, 3).map(compactHolder),
  };
}

function compactChartWindow(window = {}) {
  return {
    label: window.label,
    available: window.available,
    purpose: window.purpose,
    candles: window.candles,
    current: compactNumber(window.current, 12),
    high: compactNumber(window.high, 12),
    low: compactNumber(window.low, 12),
    changePercent: compactNumber(window.changePercent, 4),
    belowHighPercent: compactNumber(window.belowHighPercent, 4),
    aboveLowPercent: compactNumber(window.aboveLowPercent, 4),
  };
}

const TIER_ORDER = { A: 0, B: 1, C: 2, universe: 3 };

function compactWalletExposureForLlm(exposure = {}) {
  // Always preserve the scalar fields the LLM and filters rely on
  const base = {
    holderCount: exposure.holderCount ?? 0,
    checked: exposure.checked ?? 0,
    wallets: Array.isArray(exposure.wallets) ? exposure.wallets : [],
  };

  const evidence = exposure.evidence;
  if (!evidence) return base;

  // Top 5 matched wallets sorted by tier then gmgn winrate descending
  const topWallets = Array.isArray(evidence.wallets)
    ? [...evidence.wallets]
        .sort((a, b) => {
          const tierDiff = (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99);
          if (tierDiff !== 0) return tierDiff;
          return (b.gmgn?.wr ?? 0) - (a.gmgn?.wr ?? 0);
        })
        .slice(0, 5)
    : [];

  return {
    ...base,
    evidenceSummary: evidence.summary ?? null,
    topMatchedWallets: topWallets,
  };
}

function boundedNumSetting(key, fallback, min, max) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const value = raw == null ? fallback : Number(raw);
  if (Number.isFinite(value) && value >= min && value <= max) return value;
  console.log(`[llm] invalid numeric setting ${key}=${raw}; using ${fallback}`);
  return fallback;
}

function boolSettingDefault(key, fallback) {
  const raw = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value;
  const value = raw == null ? null : String(raw).toLowerCase();
  if (value != null && !['true', '1', 'yes', 'false', '0', 'no', 'off'].includes(value)) {
    console.log(`[llm] invalid boolean setting ${key}=${raw}; using ${fallback}`);
  }
  return boolSetting(key, fallback);
}

export async function compactCandidateForLlm(row, rpcCache = new Map()) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  const intelligenceEnabled = boolSettingDefault('llm_intelligence_enabled', true);
  const maxConclusions = boundedNumSetting('llm_max_conclusions_per_candidate', 8, 1, 50);
  const rpcEnabled = boolSettingDefault('llm_rpc_enrichment_enabled', true);
  const compacted = {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: compactNumber(c.chart?.currentNative, 12),
      rangeHighNative: compactNumber(c.chart?.rangeHighNative, 12),
      distanceFromAthPercent: compactNumber(c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent, 4),
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: compactNumber(athWindow.current, 12),
        high: compactNumber(athWindow.high, 12),
        low: compactNumber(athWindow.low, 12),
        distanceFromHighPercent: compactNumber(athWindow.belowHighPercent, 4),
        aboveLowPercent: compactNumber(athWindow.aboveLowPercent, 4),
      } : null,
      windows: Array.isArray(c.chart?.windows) ? c.chart.windows.map(compactChartWindow) : [],
    },
    savedWalletExposure: compactWalletExposureForLlm(c.savedWalletExposure),
    kolDumpRisk: c.kolDumpRisk,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
    data_quality: c.dataQuality || 'full',
    missing_fields: c.missingFields?.length > 0 ? c.missingFields : undefined,
    alternate_quality_score: c.alternateQualityScore ?? undefined,
  };
  if (intelligenceEnabled) {
    const analysis = await analyzeHolders(c.holders, {
      mint: c.token?.mint,
      rpcEnabled,
      rpcCache,
      maxConclusions,
    });
    compacted.holderIntelligence = buildTieredEnvelope(analysis, c.savedWalletExposure);
    compacted._llmAudit = {
      conclusionCount: compacted.holderIntelligence.conclusions.length,
      criticalCount: compacted.holderIntelligence.conclusions.filter(conclusion => conclusion.tier === 'critical').length,
      rpcEnrichmentUsed: Boolean(analysis.rpcEnrichmentUsed),
    };
  } else {
    compacted.holderIntelligence = {
      ...compactHoldersForLlm(c.holders, c.savedWalletExposure),
      conclusions: [],
      smartWalletEvidence: overlapEnvelope(c.savedWalletExposure, computeOverlapQuality(c.savedWalletExposure?.evidence?.wallets || [])),
      dataIncomplete: false,
    };
    compacted._llmAudit = { conclusionCount: 0, criticalCount: 0, rpcEnrichmentUsed: false };
  }
  return compacted;
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!rows.length) {
    return {
      verdict: 'PASS',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      selected_row: null,
      reason: 'No eligible candidates available for LLM review.',
      risks: ['empty_candidate_batch'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { fallback: 'empty_candidate_batch' },
    };
  }

  if (!llmConfigured()) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or no configured LLM provider has a usable key.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  const rpcCache = new Map();
  const candidates = await Promise.all(rows.map(row => compactCandidateForLlm(row, rpcCache)));
  const candidateAudits = candidates.map(candidate => candidate._llmAudit || {});
  for (const candidate of candidates) delete candidate._llmAudit;
  const auditBase = {
    rpc_enrichment_used: candidateAudits.some(audit => audit.rpcEnrichmentUsed),
  };

  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Use kolDumpRisk as a soft risk signal, not a hard filter. If a KOL/renowned wallet is already profitable on this token, treat dump risk as elevated; if they are underwater, they are more likely to hold.',
    'Use holderIntelligence.summary for scalar holder metrics: top5Percent, top10Percent, top20Percent, maxHolderPercent, largeHolderCount, concentrationRisk, smartWalletOverlap, and overlapQualityScore.',
    'Use holderIntelligence.conclusions for pattern-specific risk. Each conclusion has signal, severity, confidence, explanation, optional evidence, and sometimes metrics.',
    'Critical-severity conclusions are strong risk signals; explicitly reference and address them in the decision reason.',
    'Use concentrationRisk and scalar metrics for baseline holder assessment; use conclusions for specific risks, weighting conflicting conclusions by confidence.',
    'Evidence arrays contain shortened wallet addresses in first4...last3 format, with higher-severity conclusions carrying more evidence detail.',
    'Confidence is your conviction from 0 to 100, not probability.',
    "When a candidate has data_quality 'partial', one or more data fields are missing (see missing_fields).",
    'Missing fee_claim means no on-chain fee distribution was observed at screening time.',
    'This does NOT disqualify the candidate — early-stage runners often lack fee data.',
    'For partial-data candidates, weight saved wallet exposure, source count, and holder distribution more heavily.',
    'Apply slightly higher confidence bar (add ~5-10 to your confidence threshold) for partial-data candidates.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    learned_policy_context: buildLearnedPolicyContext(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      risk_profile: 'conservative|standard|runner for BUY decisions; conservative hard-exits at +80%, standard/runner may arm trailing and breakeven at +100%',
      suggested_tp_percent: 'optional positive diagnostic number; live sniper execution will clamp below policy floors',
      suggested_sl_percent: 'optional negative diagnostic number; live sniper execution will clamp weak stops below policy floors',
    },
    trigger_candidate_id: triggerCandidateId,
    candidates,
  };
  if (boolSettingDefault('llm_payload_debug_log', false)) {
    console.log(`[llm] intelligence payload before budget: ${jsonSizeBytes(user)} bytes`);
    for (const candidate of user.candidates) {
      console.log(`[llm] holderIntelligence candidate=${candidate.candidate_id}: ${JSON.stringify(candidate.holderIntelligence || null)}`);
    }
  }
  const budgetKb = boundedNumSetting('llm_payload_budget_kb', 40, 1, 200);
  const budgetBytes = Math.floor(budgetKb * 1024);
  const budgetResult = enforcePayloadBudget(user, budgetBytes);
  const finalCandidates = budgetResult.payload?.candidates || [];
  const audit = {
    ...auditBase,
    conclusion_count: finalCandidates.reduce((sum, candidate) => (
      sum + (candidate.holderIntelligence?.conclusions?.length || 0)
    ), 0),
    critical_count: finalCandidates.reduce((sum, candidate) => (
      sum + (candidate.holderIntelligence?.conclusions || []).filter(conclusion => conclusion.tier === 'critical').length
    ), 0),
    payload_size_bytes: budgetResult.payloadSizeBytes,
    trim_stages: budgetResult.trimStages,
    candidate_count: finalCandidates.length,
  };
  if (boolSettingDefault('llm_payload_debug_log', false) && budgetResult.trimStages.length) {
    console.log(`[llm] payload trim stages=${budgetResult.trimStages.join(',')} removed=${budgetResult.candidatesRemoved} size=${budgetResult.payloadSizeBytes}`);
  }
  if (budgetResult.skipped) {
    console.log(`[llm] payload ${budgetResult.payloadSizeBytes} bytes exceeds ${budgetBytes} byte budget after all trims, skipping`);
    safeLogUsageEvent({
      status: 'budget_skipped',
      provider: llmProviderName(),
      model: LLM_MODEL,
      triggerCandidateId,
      candidateCount: finalCandidates.length,
      requestBytes: budgetResult.payloadSizeBytes,
      responseBytes: 0,
      latencyMs: 0,
      errorClass: 'payload_budget_exceeded',
    });
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      selected_row: null,
      reason: `LLM skipped: payload ${budgetResult.payloadSizeBytes} bytes exceeds ${budgetBytes} byte budget after trims.`,
      risks: ['llm_payload_budget_exceeded'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { fallback: 'llm_payload_budget_exceeded', payloadSizeBytes: budgetResult.payloadSizeBytes, budgetBytes },
      audit,
      learned_policy_context: user.learned_policy_context,
    };
  }
  const timeoutMs = numSetting('llm_timeout_ms', LLM_TIMEOUT_MS);
  const requestBody = {
    model: LLM_MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(budgetResult.payload) },
    ],
  };
  if (LLM_REASONING_EFFORT) requestBody.reasoning_effort = LLM_REASONING_EFFORT;
  if (LLM_MAX_COMPLETION_TOKENS > 0) requestBody.max_completion_tokens = LLM_MAX_COMPLETION_TOKENS;
  const requestBytes = jsonSizeBytes(requestBody);
  const requestStartedAt = now();
  let res = null;
  let responseBytes = 0;
  let providerUsage = null;

  try {
    const completion = await postChatCompletion(requestBody, {
      timeout: timeoutMs,
      axiosClient: axios,
      validateResponse: validateBatchDecisionResponse,
    });
    logFailedProviderAttempts(completion.attempts, {
      triggerCandidateId,
      candidateCount: finalCandidates.length,
      requestBytes,
    });
    res = completion.response;
    const content = res.data?.choices?.[0]?.message?.content || '';
    responseBytes = Buffer.byteLength(content, 'utf8');
    providerUsage = res.data?.usage || null;
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    safeLogUsageEvent({
      status: 'success',
      provider: completion.provider.label,
      model: completion.provider.model,
      triggerCandidateId,
      candidateCount: finalCandidates.length,
      requestBytes,
      responseBytes,
      latencyMs: now() - requestStartedAt,
      usage: providerUsage,
    });
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
      audit,
      learned_policy_context: user.learned_policy_context,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    if (err.attempts?.length) {
      logFailedProviderAttempts(err.attempts, {
        triggerCandidateId,
        candidateCount: finalCandidates.length,
        requestBytes,
      });
      responseBytes = err.responseBytes || 0;
    }
    const usageTokens = normalizeUsageTokens({
      usage: providerUsage,
      requestBytes,
      responseBytes,
    });
    if (!err.attempts?.length) {
      safeLogUsageEvent({
        status: errorClass(err) === 'timeout' ? 'timeout' : 'error',
        provider: llmProviderName(),
        model: primaryLlmProvider()?.model || primaryLlmProvider({ includeUnavailable: true })?.model || LLM_MODEL,
        triggerCandidateId,
        candidateCount: finalCandidates.length,
        requestBytes,
        responseBytes,
        latencyMs: now() - requestStartedAt,
        ...usageTokens,
        errorClass: errorClass(err),
      });
    }
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: {
        error: err.message,
        attempts: (err.attempts || []).map(attempt => ({
          provider: attempt.provider,
          status: attempt.status,
          errorClass: attempt.errorClass,
          responseBytes: attempt.responseBytes || 0,
          latencyMs: attempt.latencyMs || 0,
        })),
      },
      audit,
      learned_policy_context: user.learned_policy_context,
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}

/**
 * Build LLM payload for soft cutoff hold/cut/tighten decision.
 * Called when a position reaches its soft_cutoff_ms hold time.
 */
export function buildCutoffLlmPayload(position, { ohlcvCandles = [], cutoffSignals = {}, pnlPercent = 0, holdTimeMin = 0 } = {}) {
  const systemPrompt = [
    'You are Charon, a Solana meme coin position manager.',
    'You are evaluating whether to HOLD, CUT, or TIGHTEN_SL on an open position that has reached its soft time cutoff.',
    'Return strict JSON only.',
    '',
    'HOLD: The token shows continued momentum or consolidation with bullish structure. Worth holding for another recheck window.',
    'CUT: The token shows weakness, declining volume, or bearish structure. Exit at market.',
    'TIGHTEN_SL: The token is neutral/uncertain. Tighten the stop loss to reduce risk while giving it more time.',
    '',
    'Base your decision on the OHLCV indicators, price momentum, volume trend, and candle structure.',
    'A position in profit with declining momentum should be TIGHTEN_SL.',
    'A position in loss with no recovery signals should be CUT.',
    'A position showing fresh buying pressure and bullish structure should be HOLD.',
  ].join('\n');

  const userPayload = {
    task: 'Evaluate this open position at soft cutoff time. Decide: HOLD, CUT, or TIGHTEN_SL.',
    position: {
      mint: position.mint,
      symbol: position.symbol || null,
      entry_mcap: Number(position.entry_mcap),
      current_pnl_percent: Math.round(pnlPercent * 10) / 10,
      hold_time_minutes: holdTimeMin,
      high_water_mcap: Number(position.high_water_mcap),
      sl_percent: Number(position.sl_percent),
      tp_percent: Number(position.tp_percent),
      effective_sl_percent: position.effective_sl_percent != null ? Number(position.effective_sl_percent) : Number(position.sl_percent),
      breakeven_armed: Boolean(position.breakeven_armed),
      cutoff_check_number: Number(position.cutoff_checks || 0) + 1,
    },
    indicators: {
      rsi: cutoffSignals.rsi != null ? Math.round(cutoffSignals.rsi * 10) / 10 : null,
      momentum: cutoffSignals.momentum != null ? Math.round(cutoffSignals.momentum * 1000) / 1000 : null,
      volume_trend: cutoffSignals.volume_trend || 'unknown',
      candle_structure: cutoffSignals.structure || 'unknown',
      distance_from_hwm_pct: cutoffSignals.distance_from_hwm_pct != null ? Math.round(cutoffSignals.distance_from_hwm_pct * 10) / 10 : null,
      recommendation: cutoffSignals.recommendation || 'unknown',
    },
    ohlcv_summary: summarizeOhlcv(ohlcvCandles),
    output_schema: {
      verdict: 'HOLD|CUT|TIGHTEN_SL',
      confidence: '0-100',
      reason: 'short string explaining the decision',
      suggested_new_sl_percent: 'number or null (only for TIGHTEN_SL)',
    },
  };

  return { systemPrompt, userPayload };
}

function summarizeOhlcv(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const valid = candles.filter(c => Number.isFinite(c.c) && Number.isFinite(c.v));
  if (valid.length === 0) return null;
  const first = valid[0];
  const last = valid[valid.length - 1];
  const highs = valid.map(c => c.h).filter(Number.isFinite);
  const lows = valid.map(c => c.l).filter(Number.isFinite);
  const vols = valid.map(c => c.v).filter(Number.isFinite);
  return {
    candle_count: valid.length,
    period_start_price: first.c,
    period_end_price: last.c,
    period_high: Math.max(...highs),
    period_low: Math.min(...lows),
    period_change_pct: first.c > 0 ? Math.round(((last.c - first.c) / first.c) * 1000) / 10 : null,
    avg_volume: vols.length > 0 ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length) : null,
    last_3_candle_trend: valid.slice(-3).map(c => c.c > c.o ? 'green' : c.c < c.o ? 'red' : 'flat'),
  };
}
