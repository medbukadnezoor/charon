import crypto from 'node:crypto';
import { INSTANCE_ID } from '../config.js';
import { extractScoutFeatureSnapshot, summarizeScoutFeatures } from '../scout/features.js';
import { scoreFeatureSnapshot } from '../scout/weights.js';
import { now, json, safeJson } from '../utils.js';
import { activeStrategy, boolSetting, numSetting } from './settings.js';
import { db } from './connection.js';
import { activeScoutPolicyVersion } from './scoutPolicy.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function band(value, bands, fallback = 'unknown') {
  const parsed = finiteNumber(value);
  if (parsed === null) return fallback;
  for (const item of bands) {
    if (parsed >= item.min && parsed < item.max) return item.label;
  }
  return bands.at(-1)?.label || fallback;
}

function materialBands(fields = {}) {
  return {
    route: fields.observation_path || 'unknown',
    source_count: finiteNumber(fields.source_count) ?? 0,
    saved_wallet_holders: finiteNumber(fields.saved_wallet_holders) ?? 0,
    mcap_band: band(fields.mcap_usd, [
      { label: '<10k', min: 0, max: 10_000 },
      { label: '10k-25k', min: 10_000, max: 25_000 },
      { label: '25k-50k', min: 25_000, max: 50_000 },
      { label: '50k-100k', min: 50_000, max: 100_000 },
      { label: '100k+', min: 100_000, max: Infinity },
    ]),
    liquidity_band: band(fields.liquidity_usd, [
      { label: '<8k', min: 0, max: 8_000 },
      { label: '8k-25k', min: 8_000, max: 25_000 },
      { label: '25k-75k', min: 25_000, max: 75_000 },
      { label: '75k+', min: 75_000, max: Infinity },
    ]),
    ath_band: band(fields.ath_distance_pct, [
      { label: 'near_high', min: -10, max: Infinity },
      { label: 'pulled_back', min: -45, max: -10 },
      { label: 'deep_pullback', min: -1000, max: -45 },
    ]),
    filter_passed: Boolean(fields.filter_passed),
    filter_failure_count: finiteNumber(fields.filter_failure_count) ?? 0,
  };
}

function materialChange(previousSnapshot, currentSnapshot) {
  if (!previousSnapshot?.fields) return { changed: true, reasons: ['first_seen_for_mint'] };
  const previous = materialBands(previousSnapshot.fields);
  const current = materialBands(currentSnapshot.fields);
  const reasons = [];
  if (current.source_count > previous.source_count) reasons.push('source_count_improved');
  if (current.saved_wallet_holders > previous.saved_wallet_holders) reasons.push('saved_wallet_evidence_improved');
  if (current.route !== previous.route) reasons.push('route_changed');
  if (current.mcap_band !== previous.mcap_band) reasons.push('mcap_band_changed');
  if (current.liquidity_band !== previous.liquidity_band) reasons.push('liquidity_band_changed');
  if (current.ath_band !== previous.ath_band) reasons.push('ath_pullback_band_changed');
  if (!previous.filter_passed && current.filter_passed) reasons.push('filter_state_improved');
  if (current.filter_failure_count < previous.filter_failure_count) reasons.push('filter_blockers_improved');
  return { changed: reasons.length > 0, reasons, previous, current };
}

function learnedWeights(policyVersionId, minConfidence) {
  const rows = db.prepare(`
    SELECT feature_key, weight, confidence
    FROM scout_policy_weights
    WHERE policy_version_id = ?
      AND feature_key NOT LIKE 'llm:%'
  `).all(policyVersionId);
  return new Map(rows
    .filter(row => Number(row.confidence || 0) >= minConfidence)
    .map(row => [row.feature_key, row]));
}

function preLlmScore(candidateRow, { asOfMs = now(), minConfidence = 0.2 } = {}) {
  const policyVersion = activeScoutPolicyVersion();
  const snapshot = extractScoutFeatureSnapshot(candidateRow.candidate, {
    asOfMs,
    llmDecision: null,
    decisionPath: candidateRow.candidate?.signals?.route || null,
  });
  snapshot.fields.filter_passed = Boolean(candidateRow.candidate?.filters?.passed);
  snapshot.fields.filter_failure_count = Array.isArray(candidateRow.candidate?.filters?.failures)
    ? candidateRow.candidate.filters.failures.length
    : (candidateRow.candidate?.filters?.passed ? 0 : 1);
  snapshot.feature_keys = [...new Set((snapshot.feature_keys || []).filter(key => !String(key).startsWith('llm:')))];
  const scored = scoreFeatureSnapshot(snapshot, learnedWeights(policyVersion.id, minConfidence));
  return { policyVersion, snapshot, ...scored };
}

function budgetState(atMs = now()) {
  const hourlyCap = numSetting('scout_llm_hourly_cap', 120);
  const dailyCap = numSetting('scout_llm_daily_cap', 1200);
  const hourlyUsed = db.prepare(`
    SELECT COUNT(*) AS n
    FROM scout_llm_admissions
    WHERE admitted = 1 AND created_at_ms >= ?
  `).get(atMs - HOUR_MS).n;
  const dailyUsed = db.prepare(`
    SELECT COUNT(*) AS n
    FROM scout_llm_admissions
    WHERE admitted = 1 AND created_at_ms >= ?
  `).get(atMs - DAY_MS).n;
  return {
    hourly_cap: hourlyCap,
    hourly_used: Number(hourlyUsed || 0),
    hourly_remaining: hourlyCap > 0 ? Math.max(0, hourlyCap - Number(hourlyUsed || 0)) : null,
    daily_cap: dailyCap,
    daily_used: Number(dailyUsed || 0),
    daily_remaining: dailyCap > 0 ? Math.max(0, dailyCap - Number(dailyUsed || 0)) : null,
    exhausted: (hourlyCap > 0 && Number(hourlyUsed || 0) >= hourlyCap)
      || (dailyCap > 0 && Number(dailyUsed || 0) >= dailyCap),
  };
}

function deterministicExplore(mint, atMs, rate) {
  const boundedRate = Math.max(0, Math.min(1, Number(rate) || 0));
  if (boundedRate <= 0) return false;
  const bucket = Math.floor(atMs / HOUR_MS);
  const digest = crypto.createHash('sha256').update(`${mint}:${bucket}`).digest();
  const value = digest.readUInt32BE(0) / 0xffffffff;
  return value < boundedRate;
}

export function scoutLlmThrottleActive(strategy = activeStrategy()) {
  return INSTANCE_ID === 'scout'
    && strategy?.id === 'scout'
    && boolSetting('scout_llm_throttle_enabled', INSTANCE_ID === 'scout');
}

export function recordScoutLlmAdmission({
  candidateRow,
  admitted,
  reason,
  preScore,
  featureSnapshot,
  materialChange: materialChangeSummary,
  budgetState: state,
  exploration = false,
  batchId = null,
  atMs = now(),
}) {
  const result = db.prepare(`
    INSERT INTO scout_llm_admissions (
      candidate_id, mint, created_at_ms, admitted, reason, pre_score,
      feature_snapshot_json, material_change_json, budget_state_json, exploration, batch_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateRow.id,
    candidateRow.candidate?.token?.mint,
    atMs,
    admitted ? 1 : 0,
    reason,
    preScore ?? 0,
    json(featureSnapshot || {}),
    json(materialChangeSummary || {}),
    json(state || {}),
    exploration ? 1 : 0,
    batchId,
  );
  return Number(result.lastInsertRowid);
}

export function updateScoutLlmAdmissionBatch(admissionId, batchId) {
  if (!admissionId || !batchId) return false;
  db.prepare('UPDATE scout_llm_admissions SET batch_id = ? WHERE id = ?').run(batchId, admissionId);
  return true;
}

export function decideScoutLlmAdmission(candidateRow, {
  atMs = now(),
  strategy = activeStrategy(),
  record = true,
} = {}) {
  if (!scoutLlmThrottleActive(strategy)) {
    return { active: false, admitted: true, reason: 'scout_llm_throttle_disabled' };
  }
  const scored = preLlmScore(candidateRow, {
    asOfMs: atMs,
    minConfidence: numSetting('scout_llm_min_weight_confidence', 0.2),
  });
  const mint = candidateRow.candidate?.token?.mint;
  const cooldownMs = Math.max(0, numSetting('scout_llm_mint_cooldown_ms', 30 * 60_000));
  const prior = cooldownMs > 0 ? db.prepare(`
    SELECT *
    FROM scout_llm_admissions
    WHERE mint = ? AND admitted = 1 AND created_at_ms >= ?
    ORDER BY created_at_ms DESC
    LIMIT 1
  `).get(mint, atMs - cooldownMs) : null;
  const change = materialChange(safeJson(prior?.feature_snapshot_json, null), scored.snapshot);
  const state = budgetState(atMs);
  const threshold = numSetting('scout_llm_pre_score_threshold', -0.02);
  const reserveThreshold = numSetting('scout_llm_high_score_reserve_threshold', 0.03);
  const exploration = deterministicExplore(mint, atMs, numSetting('scout_exploration_rate', 0.08));

  let admitted = true;
  let reason = 'score_admit';
  if (state.exhausted) {
    admitted = false;
    reason = 'budget_cap_exhausted';
  } else if (prior && !change.changed) {
    admitted = false;
    reason = 'cooldown_skip';
  } else if (scored.score >= reserveThreshold) {
    reason = state.hourly_remaining !== null && state.hourly_remaining <= Math.max(1, Math.ceil(state.hourly_cap * 0.1))
      ? 'high_score_reserve_admit'
      : 'high_score_admit';
  } else if (scored.score >= threshold) {
    reason = prior ? 'material_change_admit' : 'score_admit';
  } else if (exploration) {
    admitted = true;
    reason = 'exploration_admit';
  } else {
    admitted = false;
    reason = 'score_skip';
  }

  const admissionId = record ? recordScoutLlmAdmission({
    candidateRow,
    admitted,
    reason,
    preScore: scored.score,
    featureSnapshot: {
      ...scored.snapshot,
      summary: summarizeScoutFeatures(scored.snapshot),
      matched_weights: scored.matched,
    },
    materialChange: change,
    budgetState: state,
    exploration,
    atMs,
  }) : null;

  return {
    active: true,
    admissionId,
    admitted,
    reason,
    pre_score: scored.score,
    feature_snapshot: scored.snapshot,
    matched_weights: scored.matched,
    material_change: change,
    budget_state: state,
    exploration,
  };
}
