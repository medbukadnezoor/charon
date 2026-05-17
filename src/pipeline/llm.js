import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { logUsageEvent, normalizeUsageTokens } from '../db/usage.js';
import { analyzeHolders } from '../enrichment/holder-intelligence.js';
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
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    raw: parsed,
  };
}

function llmProviderName() {
  try {
    return new URL(LLM_BASE_URL).hostname;
  } catch {
    return 'openai-compatible';
  }
}

function errorClass(err) {
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

  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
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
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
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
  const requestBytes = jsonSizeBytes(requestBody);
  const requestStartedAt = now();
  let res = null;
  let responseBytes = 0;
  let providerUsage = null;

  try {
    res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, requestBody, {
      timeout: timeoutMs,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
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
      provider: llmProviderName(),
      model: LLM_MODEL,
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
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    const usageTokens = normalizeUsageTokens({
      usage: providerUsage,
      requestBytes,
      responseBytes,
    });
    safeLogUsageEvent({
      status: errorClass(err) === 'timeout' ? 'timeout' : 'error',
      provider: llmProviderName(),
      model: LLM_MODEL,
      triggerCandidateId,
      candidateCount: finalCandidates.length,
      requestBytes,
      responseBytes,
      latencyMs: now() - requestStartedAt,
      ...usageTokens,
      errorClass: errorClass(err),
    });
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
      audit,
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
