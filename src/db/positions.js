import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy } from './settings.js';
import { SHADOW_MODE } from '../config.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function hasOpenPositionForMint(mint) {
  return Boolean(db.prepare(`
    SELECT id FROM dry_run_positions
    WHERE mint = ? AND status IN ('open', 'partial_exit')
    LIMIT 1
  `).get(mint));
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

export function rawTradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function tradingMode() {
  if (SHADOW_MODE) return 'dry_run';
  return rawTradingMode();
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function firstNumeric(...values) {
  for (const value of values) {
    const parsed = numericOrNull(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function boolish(value, fallback = false) {
  if (value === true || value === 1 || value === '1' || value === 'true' || value === 'yes' || value === 'on') return true;
  if (value === false || value === 0 || value === '0' || value === 'false' || value === 'no' || value === 'off') return false;
  return fallback;
}

export function decisionPositionSizeSol(decision = {}, strat = activeStrategy()) {
  const resolved = numericOrNull(decision?.resolved_risk?.position_size_sol);
  if (resolved != null && resolved > 0) return resolved;
  const suggested = numericOrNull(decision?.suggested_position_size_sol);
  if (suggested != null && suggested > 0) return suggested;
  return strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
}

function decisionBool(value, fallback) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function decisionNumber(value, fallback) {
  const parsed = numericOrNull(value);
  return parsed == null ? fallback : parsed;
}

const LIVE_RISK_POLICY = 'live_sniper_floor_v1';
const VALID_LIVE_RISK_PROFILES = new Set(['conservative', 'standard', 'runner']);

function rawRiskValue(decision, key) {
  if (decision?.raw && Object.prototype.hasOwnProperty.call(decision.raw, key)) return decision.raw[key];
  if (decision?.raw) return undefined;
  return decision?.[key];
}

function normalizeRiskProfile(value) {
  const profile = String(value || '').toLowerCase();
  return VALID_LIVE_RISK_PROFILES.has(profile) ? profile : null;
}

function inferRiskProfile(decision, strat) {
  const explicit = normalizeRiskProfile(decision?.risk_profile ?? decision?.raw?.risk_profile);
  if (explicit) return { profile: explicit, source: 'llm_profile' };

  const rawTp = numericOrNull(rawRiskValue(decision, 'suggested_tp_percent'));
  if (rawTp != null) {
    if (rawTp < 120) return { profile: 'conservative', source: 'raw_tp' };
    if (rawTp < 250) return { profile: 'standard', source: 'raw_tp' };
    return { profile: 'runner', source: 'raw_tp' };
  }

  const fallback = normalizeRiskProfile(strat.live_default_risk_profile) || 'runner';
  return { profile: fallback, source: 'strategy_default' };
}

function liveRiskProfiles(strat) {
  return {
    conservative: {
      position_size_sol: 0.03,
      tp_percent: 80,
      sl_percent: -40,
      trailing_enabled: false,
      trailing_arm_percent: null,
      trailing_percent: 0,
      breakeven_after_profit_percent: 0,
      breakeven_lock_percent: 0,
      ...(strat.live_risk_profiles?.conservative || {}),
    },
    standard: {
      position_size_sol: 0.03,
      tp_percent: 160,
      sl_percent: -50,
      trailing_enabled: true,
      trailing_arm_percent: 100,
      trailing_percent: 35,
      breakeven_after_profit_percent: 100,
      breakeven_lock_percent: 20,
      ...(strat.live_risk_profiles?.standard || {}),
    },
    runner: {
      position_size_sol: 0.03,
      tp_percent: 300,
      sl_percent: -60,
      trailing_enabled: true,
      trailing_arm_percent: 100,
      trailing_percent: 35,
      breakeven_after_profit_percent: 100,
      breakeven_lock_percent: 20,
      ...(strat.live_risk_profiles?.runner || {}),
    },
  };
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), max);
}

export function resolveLiveSniperRisk(decision = {}, strat = activeStrategy(), context = {}) {
  const mode = context.tradingMode ?? tradingMode();
  if (mode !== 'live' || strat?.id !== 'sniper' || !boolish(strat.live_risk_policy_enabled, true)) {
    return null;
  }

  // The live sniper lane may keep broad profile defaults in tp_percent/sl_percent
  // while publishing the active live policy through live_min_* fields.
  const policySize = firstNumeric(strat.live_min_position_size_sol, strat.position_size_sol, 0.03) ?? 0.03;
  const policyTp = firstNumeric(strat.live_min_tp_percent, strat.tp_percent, 80) ?? 80;
  const policySl = firstNumeric(strat.live_min_sl_percent, strat.sl_percent, -40) ?? -40;
  const allowEnvelope = boolish(strat.live_risk_allow_policy_envelope, false);
  const minSize = allowEnvelope ? (firstNumeric(strat.live_min_position_size_sol, policySize) ?? policySize) : policySize;
  const maxSize = allowEnvelope ? (firstNumeric(strat.live_max_position_size_sol, policySize) ?? policySize) : policySize;
  const minTp = allowEnvelope ? (firstNumeric(strat.live_min_tp_percent, policyTp) ?? policyTp) : policyTp;
  const maxTp = allowEnvelope ? (firstNumeric(strat.live_max_tp_percent, policyTp) ?? policyTp) : policyTp;
  const maxSlLoss = allowEnvelope ? (firstNumeric(strat.live_max_sl_percent, policySl) ?? policySl) : policySl;
  const leastNegativeSl = allowEnvelope ? (firstNumeric(strat.live_min_sl_percent, policySl) ?? policySl) : policySl;
  const sizeFloor = Math.min(minSize, maxSize);
  const sizeCeiling = Math.max(minSize, maxSize);
  const tpFloor = Math.min(minTp, maxTp);
  const tpCeiling = Math.max(minTp, maxTp);
  const slFloor = Math.min(maxSlLoss, leastNegativeSl);
  const slCeiling = Math.max(maxSlLoss, leastNegativeSl);
  const { profile, source } = inferRiskProfile(decision, strat);
  const profileRisk = liveRiskProfiles(strat)[profile];

  const raw = {
    risk_profile: decision?.risk_profile ?? decision?.raw?.risk_profile ?? null,
    suggested_position_size_sol: rawRiskValue(decision, 'suggested_position_size_sol') ?? null,
    suggested_tp_percent: rawRiskValue(decision, 'suggested_tp_percent') ?? null,
    suggested_sl_percent: rawRiskValue(decision, 'suggested_sl_percent') ?? null,
    suggested_trailing_enabled: rawRiskValue(decision, 'suggested_trailing_enabled') ?? null,
    suggested_trailing_arm_percent: rawRiskValue(decision, 'suggested_trailing_arm_percent') ?? null,
    suggested_trailing_percent: rawRiskValue(decision, 'suggested_trailing_percent') ?? null,
    suggested_breakeven_after_profit_percent: rawRiskValue(decision, 'suggested_breakeven_after_profit_percent') ?? null,
    suggested_breakeven_lock_percent: rawRiskValue(decision, 'suggested_breakeven_lock_percent') ?? null,
  };

  const rawSize = numericOrNull(raw.suggested_position_size_sol);
  const rawTp = numericOrNull(raw.suggested_tp_percent);
  const rawSl = numericOrNull(raw.suggested_sl_percent);
  const profileSize = Number(profileRisk.position_size_sol);
  const profileTp = Number(profileRisk.tp_percent);
  const profileSl = Number(profileRisk.sl_percent);
  const wantedSize = rawSize ?? profileSize;
  const wantedTp = rawTp ?? profileTp;
  const wantedSl = rawSl ?? profileSl;
  const policyTrailingEnabled = boolish(strat.trailing_enabled, false);

  const resolved = {
    policy: LIVE_RISK_POLICY,
    profile,
    profile_source: source,
    position_size_sol: clampNumber(wantedSize, sizeFloor, sizeCeiling),
    tp_percent: clampNumber(wantedTp, tpFloor, tpCeiling),
    sl_percent: clampNumber(wantedSl, slFloor, slCeiling),
    trailing_enabled: policyTrailingEnabled,
    trailing_arm_percent: policyTrailingEnabled ? numericOrNull(strat.trailing_arm_percent) : null,
    trailing_percent: policyTrailingEnabled ? Number(strat.trailing_percent || 0) : 0,
    breakeven_after_profit_percent: Number(strat.breakeven_after_profit_percent || 0),
    breakeven_lock_percent: Number(strat.breakeven_lock_percent || 0),
  };

  const clamps = [];
  if (wantedSize !== resolved.position_size_sol) clamps.push({ field: 'position_size_sol', from: wantedSize, to: resolved.position_size_sol });
  if (wantedTp !== resolved.tp_percent) clamps.push({ field: 'tp_percent', from: wantedTp, to: resolved.tp_percent });
  if (wantedSl !== resolved.sl_percent) clamps.push({ field: 'sl_percent', from: wantedSl, to: resolved.sl_percent });
  if (resolved.trailing_enabled && resolved.trailing_arm_percent == null) resolved.trailing_arm_percent = resolved.tp_percent;

  return {
    policy: LIVE_RISK_POLICY,
    raw_llm_risk: raw,
    resolved_risk: resolved,
    risk_clamps_applied: clamps,
  };
}

function earlyTokenSlSnapshot(candidate, strat, baseSlPercent) {
  const tokenAgeMs = numericOrNull(candidate?.signals?.ageMs);
  const ageTrusted = candidate?.signals?.ageTrusted;
  const earlyTokenAgeMs = numericOrNull(strat.early_token_age_ms) ?? 0;
  const earlyTokenSlPercent = numericOrNull(strat.early_token_sl_percent);
  const maxHoldIfNoTpMs = numericOrNull(strat.max_hold_if_no_tp_ms) ?? 0;
  const baseSl = Number(baseSlPercent);
  const snapshot = {
    base_sl_percent: baseSl,
    effective_sl_percent: baseSl,
    early_token_sl_percent: earlyTokenSlPercent,
    early_token_age_ms: earlyTokenAgeMs,
    token_age_ms: tokenAgeMs,
    max_hold_if_no_tp_ms: maxHoldIfNoTpMs,
    reason: 'early_token_sl_off',
    applied: false,
  };

  if (earlyTokenSlPercent === null) return snapshot;
  if (!Number.isFinite(earlyTokenSlPercent) || earlyTokenSlPercent >= 0) {
    return { ...snapshot, reason: 'early_token_sl_invalid' };
  }
  if (!Number.isFinite(baseSl) || earlyTokenSlPercent >= baseSl) {
    return { ...snapshot, reason: 'early_token_sl_not_wider' };
  }
  if (earlyTokenAgeMs <= 0) return { ...snapshot, reason: 'early_token_age_window_off' };
  if (maxHoldIfNoTpMs <= 0) return { ...snapshot, reason: 'no_tp_time_stop_off' };
  if (ageTrusted === false) return { ...snapshot, reason: 'token_age_untrusted' };
  if (tokenAgeMs === null) return { ...snapshot, reason: 'token_age_missing' };
  if (tokenAgeMs > earlyTokenAgeMs) return { ...snapshot, reason: 'token_not_early' };

  return {
    ...snapshot,
    effective_sl_percent: earlyTokenSlPercent,
    reason: 'early_token_with_no_tp_time_stop',
    applied: true,
  };
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  const sizeSol = decisionPositionSizeSol(decision, strat);
  const rawEntryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const rawEntryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const slippagePct = numSetting('dry_run_slippage_pct', 1.0);
  const slippageFactor = rawEntryMcap != null ? (1 + slippagePct / 100) : 1;
  const entryPrice = rawEntryPrice != null ? rawEntryPrice * slippageFactor : null;
  const entryMcap = rawEntryMcap != null ? rawEntryMcap * slippageFactor : null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const earlyTokenSl = earlyTokenSlSnapshot(candidate, strat, sl);
  const effectiveSl = earlyTokenSl.effective_sl_percent;
  const trailingEnabled = decisionBool(decision.suggested_trailing_enabled, strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingArmPercent = decisionNumber(decision.suggested_trailing_arm_percent, strat.trailing_arm_percent ?? tp);
  const trailingPercent = decisionNumber(decision.suggested_trailing_percent, strat.trailing_percent ?? numSetting('default_trailing_percent', 20));
  const breakevenLockPercent = decisionNumber(decision.suggested_breakeven_lock_percent, Number(strat.breakeven_lock_percent ?? numSetting('breakeven_lock_percent', 0)) || 0);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        effective_sl_percent, trailing_enabled, trailing_arm_percent, trailing_percent, trailing_armed, breakeven_lock_percent,
        llm_decision_id, strategy_id, scout_policy_version_id, scout_policy_score, scout_reward_status, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      effectiveSl,
      trailingEnabled,
      trailingArmPercent,
      trailingPercent,
      breakevenLockPercent,
      decision.id || null,
      strat.id,
      decision.scout_policy?.policy_version_id || null,
      decision.scout_policy?.score ?? null,
      json({
        candidate,
        decision,
        reason,
        strategy: strat.id,
        mcapSample: candidate.mcapSample || null,
        base_sl_percent: sl,
        effective_sl_percent: effectiveSl,
        early_token_sl: earlyTokenSl,
      }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({
      candidateId,
      decision,
      mcapSample: candidate.mcapSample || null,
      base_sl_percent: sl,
      effective_sl_percent: effectiveSl,
      early_token_sl: earlyTokenSl,
    }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    db.prepare('UPDATE tp_sl_rules SET trailing_arm_percent = ? WHERE position_id = ?').run(trailingArmPercent, positionId);
    return positionId;
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const liveRisk = decision.live_sniper_risk || resolveLiveSniperRisk(decision, strat);
  const resolvedRisk = liveRisk?.resolved_risk || null;
  const sizeSol = resolvedRisk?.position_size_sol ?? decisionPositionSizeSol(decision, strat);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = resolvedRisk?.tp_percent ?? Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = resolvedRisk?.sl_percent ?? Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const earlyTokenSl = earlyTokenSlSnapshot(candidate, strat, sl);
  const effectiveSl = sl;
  const trailingEnabled = (resolvedRisk
    ? boolish(resolvedRisk.trailing_enabled, false)
    : decisionBool(decision.suggested_trailing_enabled, strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true))) ? 1 : 0;
  const trailingArmPercent = resolvedRisk
    ? resolvedRisk.trailing_arm_percent
    : decisionNumber(decision.suggested_trailing_arm_percent, strat.trailing_arm_percent ?? tp);
  const trailingPercent = resolvedRisk
    ? resolvedRisk.trailing_percent
    : decisionNumber(decision.suggested_trailing_percent, strat.trailing_percent ?? numSetting('default_trailing_percent', 20));
  const breakevenLockPercent = resolvedRisk
    ? resolvedRisk.breakeven_lock_percent
    : decisionNumber(decision.suggested_breakeven_lock_percent, Number(strat.breakeven_lock_percent ?? numSetting('breakeven_lock_percent', 0)) || 0);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status IN ('open', 'partial_exit') LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return existing.id;

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        effective_sl_percent, trailing_enabled, trailing_arm_percent, trailing_percent, trailing_armed, breakeven_lock_percent, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, scout_policy_version_id, scout_policy_score, scout_reward_status, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'live', ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      effectiveSl,
      trailingEnabled,
      trailingArmPercent,
      trailingPercent,
      breakevenLockPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      decision.scout_policy?.policy_version_id || null,
      decision.scout_policy?.score ?? null,
      json({
        candidate,
        decision,
        reason,
        swap,
        strategy: strat.id,
        mcapSample: candidate.mcapSample || null,
        base_sl_percent: sl,
        effective_sl_percent: effectiveSl,
        live_early_token_sl_shadow_only: true,
        early_token_sl: earlyTokenSl,
        raw_llm_risk: liveRisk?.raw_llm_risk || null,
        resolved_risk: resolvedRisk,
        risk_policy: liveRisk?.policy || null,
        risk_clamps_applied: liveRisk?.risk_clamps_applied || [],
      }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({
      candidateId,
      decision,
      swap,
      mcapSample: candidate.mcapSample || null,
      base_sl_percent: sl,
      effective_sl_percent: effectiveSl,
      live_early_token_sl_shadow_only: true,
      early_token_sl: earlyTokenSl,
      raw_llm_risk: liveRisk?.raw_llm_risk || null,
      resolved_risk: resolvedRisk,
      risk_policy: liveRisk?.policy || null,
      risk_clamps_applied: liveRisk?.risk_clamps_applied || [],
    }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    db.prepare('UPDATE tp_sl_rules SET trailing_arm_percent = ? WHERE position_id = ?').run(trailingArmPercent, positionId);
    return positionId;
  })();
}
