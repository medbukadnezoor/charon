import { db } from './connection.js';
import { now, json, safeJson } from '../utils.js';
import { boolSetting, numSetting, setting } from './settings.js';
import { extractScoutFeatureSnapshot, summarizeScoutFeatures } from '../scout/features.js';
import { calculateScoutReward } from '../scout/rewards.js';
import { scoreFeatureSnapshot, updateFeatureWeight } from '../scout/weights.js';

const DEFAULT_VERSION = 'scout-v1';

export function scoutPolicyEnabled() {
  return boolSetting('scout_policy_enabled', false);
}

export function activeScoutPolicyVersion() {
  const version = setting('scout_policy_active_version', DEFAULT_VERSION);
  return db.transaction(() => {
    let row = db.prepare('SELECT * FROM scout_policy_versions WHERE version = ?').get(version);
    if (!row) {
      const ts = now();
      const result = db.prepare(`
        INSERT INTO scout_policy_versions (version, status, created_at_ms, promoted_at_ms, promotion_reason, frozen_params_json)
        VALUES (?, 'active', ?, ?, ?, ?)
      `).run(version, ts, ts, 'initial scout policy', json({
        half_life_ms: numSetting('scout_learning_half_life_ms', 7 * 24 * 60 * 60_000),
        learner: 'darwin_weighted_v1',
      }));
      row = db.prepare('SELECT * FROM scout_policy_versions WHERE id = ?').get(result.lastInsertRowid);
    }
    return row;
  })();
}

export function scoutWeightsForPrompt(policyVersionId = activeScoutPolicyVersion().id, limit = 6) {
  const positive = db.prepare(`
    SELECT feature_key, weight, confidence, sample_count, live_sample_count, shadow_sample_count
    FROM scout_policy_weights
    WHERE policy_version_id = ?
    ORDER BY weight DESC
    LIMIT ?
  `).all(policyVersionId, limit);
  const negative = db.prepare(`
    SELECT feature_key, weight, confidence, sample_count, live_sample_count, shadow_sample_count
    FROM scout_policy_weights
    WHERE policy_version_id = ?
    ORDER BY weight ASC
    LIMIT ?
  `).all(policyVersionId, limit);
  return { positive, negative };
}

export function buildLearnedPolicyContext() {
  if (!scoutPolicyEnabled()) return null;
  const version = activeScoutPolicyVersion();
  const { positive, negative } = scoutWeightsForPrompt(version.id, 5);
  const lossRows = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(pnl_sol), 0) AS pnl
    FROM dry_run_positions
    WHERE execution_mode = 'live'
      AND closed_at_ms >= ?
      AND status = 'closed'
  `).get(now() - 24 * 60 * 60_000);
  return {
    policy_version: version.version,
    guidance: 'Use this as compact learned prior only. Candidate facts and hard safety gates override priors.',
    top_positive_cohorts: positive,
    top_negative_cohorts: negative,
    exploration: {
      rate: numSetting('scout_exploration_rate', 0.08),
      daily_buy_cap: numSetting('scout_daily_buy_cap', 3),
      daily_loss_stop_sol: numSetting('scout_daily_loss_stop_sol', 0.06),
      live_closed_24h: Number(lossRows?.n || 0),
      live_realized_pnl_sol_24h: Number(lossRows?.pnl || 0),
    },
  };
}

function weightsMap(policyVersionId) {
  const rows = db.prepare('SELECT feature_key, weight, confidence FROM scout_policy_weights WHERE policy_version_id = ?').all(policyVersionId);
  return new Map(rows.map(row => [row.feature_key, row]));
}

export function scoreScoutCandidate(row, decision = null, { asOfMs = now(), policyVersion = activeScoutPolicyVersion() } = {}) {
  const snapshot = extractScoutFeatureSnapshot(row.candidate, {
    asOfMs,
    llmDecision: decision,
    decisionPath: row.candidate?.signals?.route || null,
  });
  const scored = scoreFeatureSnapshot(snapshot, weightsMap(policyVersion.id));
  return { policyVersion, snapshot, ...scored };
}

export function recordScoutDecision({
  candidateRow,
  decision,
  executionAction,
  policyContext = buildLearnedPolicyContext(),
  asOfMs = now(),
}) {
  if (!scoutPolicyEnabled() || !candidateRow?.candidate) return null;
  const scored = scoreScoutCandidate(candidateRow, decision, { asOfMs });
  const result = db.prepare(`
    INSERT INTO scout_policy_decisions (
      candidate_id, mint, policy_version_id, created_at_ms, feature_snapshot_json,
      llm_prompt_summary_json, score, verdict, execution_action, policy_context_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateRow.id,
    candidateRow.candidate.token?.mint,
    scored.policyVersion.id,
    asOfMs,
    json(scored.snapshot),
    json({
      learned_policy_context: policyContext,
      candidate_features: summarizeScoutFeatures(scored.snapshot),
      matched_weights: scored.matched,
    }),
    scored.score,
    decision?.verdict || 'UNKNOWN',
    executionAction,
    json(policyContext || {}),
  );
  return {
    id: Number(result.lastInsertRowid),
    policy_version_id: scored.policyVersion.id,
    policy_version: scored.policyVersion.version,
    score: scored.score,
    feature_snapshot: scored.snapshot,
  };
}

export function scoutDailyGuard({ atMs = now() } = {}) {
  if (!scoutPolicyEnabled()) return { blocked: false, reason: 'disabled' };
  const dayStart = atMs - 24 * 60 * 60_000;
  const buys = db.prepare(`
    SELECT COUNT(*) AS n
    FROM dry_run_positions
    WHERE opened_at_ms >= ?
      AND execution_mode IN ('live', 'dry_run')
  `).get(dayStart).n;
  const closed = db.prepare(`
    SELECT COALESCE(SUM(pnl_sol), 0) AS pnl
    FROM dry_run_positions
    WHERE closed_at_ms >= ?
      AND execution_mode IN ('live', 'dry_run')
      AND status = 'closed'
  `).get(dayStart);
  const cap = numSetting('scout_daily_buy_cap', 3);
  const lossStop = Math.abs(numSetting('scout_daily_loss_stop_sol', 0.06));
  const pnl = Number(closed?.pnl || 0);
  if (cap > 0 && buys >= cap) return { blocked: true, reason: 'scout_daily_buy_cap', buys, cap, pnl };
  if (pnl <= -lossStop) return { blocked: true, reason: 'scout_daily_loss_stop', buys, cap, pnl, lossStop };
  return { blocked: false, reason: 'clear', buys, cap, pnl, lossStop };
}

export function recordScoutRewardForPosition(position, { source = null, policyDecisionId = null } = {}) {
  const reward = calculateScoutReward(position, { source: source || (position.execution_mode === 'live' ? 'live' : 'shadow') });
  if (!reward.eligible) return reward;
  const snapshot = safeJson(position.snapshot_json, {})?.decision?.scout_policy?.feature_snapshot
    || safeJson(position.snapshot_json, {})?.scout_policy?.feature_snapshot
    || { feature_keys: [] };
  if (!Array.isArray(snapshot.feature_keys) || snapshot.feature_keys.length === 0) {
    return { eligible: false, reason: 'missing_scout_feature_snapshot' };
  }
  db.prepare(`
    INSERT OR IGNORE INTO scout_reward_events (
      policy_decision_id, position_id, outcome_id, mint, source, realized_pnl_sol,
      realized_pnl_percent, high_water_multiple, drawdown_percent, reward, reward_weight,
      feature_snapshot_json, created_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    policyDecisionId,
    position.id,
    `position:${position.id}`,
    position.mint,
    reward.source,
    reward.realized_pnl_sol,
    reward.realized_pnl_percent,
    reward.high_water_multiple,
    reward.drawdown_percent,
    reward.reward,
    reward.reward_weight,
    json(snapshot),
    now(),
  );
  return reward;
}

export function updateScoutWeightsFromRewards({ policyVersion = activeScoutPolicyVersion(), limit = 500 } = {}) {
  const halfLifeMs = numSetting('scout_learning_half_life_ms', 7 * 24 * 60 * 60_000);
  const rewards = db.prepare(`
    SELECT *
    FROM scout_reward_events
    WHERE applied_to_weights_at_ms IS NULL
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).reverse();
  const upsert = db.prepare(`
    INSERT INTO scout_policy_weights (
      policy_version_id, feature_key, weight, confidence, sample_count, live_sample_count,
      shadow_sample_count, last_reward_at_ms, decay_half_life_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(policy_version_id, feature_key) DO UPDATE SET
      weight = excluded.weight,
      confidence = excluded.confidence,
      sample_count = excluded.sample_count,
      live_sample_count = scout_policy_weights.live_sample_count + excluded.live_sample_count,
      shadow_sample_count = scout_policy_weights.shadow_sample_count + excluded.shadow_sample_count,
      last_reward_at_ms = excluded.last_reward_at_ms,
      decay_half_life_ms = excluded.decay_half_life_ms,
      updated_at_ms = excluded.updated_at_ms
  `);
  return db.transaction(() => {
    let updates = 0;
    for (const event of rewards) {
      const snapshot = safeJson(event.feature_snapshot_json, {});
      for (const featureKey of snapshot.feature_keys || []) {
        const current = db.prepare(`
          SELECT * FROM scout_policy_weights
          WHERE policy_version_id = ? AND feature_key = ?
        `).get(policyVersion.id, featureKey);
        const next = updateFeatureWeight({
          currentWeight: current?.weight || 0,
          currentConfidence: current?.confidence || 0,
          currentSamples: current?.sample_count || 0,
          reward: event.reward,
          rewardWeight: event.reward_weight,
          elapsedMs: current?.last_reward_at_ms ? Number(event.created_at_ms) - Number(current.last_reward_at_ms) : 0,
          halfLifeMs,
        });
        upsert.run(
          policyVersion.id,
          featureKey,
          next.weight,
          next.confidence,
          next.sample_count,
          event.source === 'live' ? 1 : 0,
          event.source === 'shadow' ? 1 : 0,
          event.created_at_ms,
          halfLifeMs,
          now(),
        );
        db.prepare('UPDATE scout_reward_events SET applied_to_weights_at_ms = ? WHERE id = ?').run(now(), event.id);
        updates += 1;
      }
    }
    return { rewards: rewards.length, updates, policy_version: policyVersion.version };
  })();
}
