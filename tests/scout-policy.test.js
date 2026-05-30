import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.INSTANCE_ID = 'scout';
process.env.SCOUT_POLICY_ENABLED = 'true';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-scout-policy-'));
process.env.DB_PATH = path.join(tempDir, 'scout.sqlite');
process.env.GLOBAL_LIVE_LOCK_DB_PATH = path.join(tempDir, 'live-lock.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { extractScoutFeatureSnapshot } = await import('../src/scout/features.js');
const { calculateScoutReward } = await import('../src/scout/rewards.js');
const { updateFeatureWeight } = await import('../src/scout/weights.js');
const { activeStrategy } = await import('../src/db/settings.js');
const { rawTradingMode } = await import('../src/db/positions.js');
const {
  activeScoutPolicyVersion,
  recordScoutDecision,
  scoutDailyGuard,
  updateScoutWeightsFromRewards,
} = await import('../src/db/scoutPolicy.js');
const {
  acquireLiveExecutionLock,
  attachLiveExecutionLockPosition,
  closeLiveLockDbForTests,
  getLiveLockDb,
  releaseLiveExecutionLock,
} = await import('../src/execution/liveLock.js');
const { createDryRunPosition } = await import('../src/db/positions.js');
const { releaseLiveExecutionLockForPosition } = await import('../src/execution/positions.js');
const { executionLaneForRuntime } = await import('../src/telemetry/snapshot.js');
const { validateExecutionLane, validateSourceInstance } = await import('../src/telemetry/laneTags.js');

after(() => {
  closeLiveLockDbForTests();
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function candidate(overrides = {}) {
  return {
    token: { mint: overrides.mint || 'ScoutMint111111111111111111111111111111111', symbol: 'SCOUT' },
    signals: { route: 'llm_watch_dip', sourceCount: 2, sources: ['graduated', 'trending'] },
    metrics: { marketCapUsd: 22_000, liquidityUsd: 12_000, priceUsd: 0.001 },
    chart: { distanceFromAthPercent: -32, aboveLowPercent: 11 },
    feeClaim: { claimSol: 0 },
    holders: { top20Percent: 42, maxHolderPercent: 7 },
    savedWalletExposure: {
      holderCount: 1,
      evidence: { wallets: [{ tier: 'A', tags: ['early_runner'] }] },
    },
    filters: { passed: true, strategy: 'scout' },
    ...overrides,
  };
}

test('scout feature extractor rejects future observations', () => {
  const asOfMs = 1_000;
  assert.throws(() => extractScoutFeatureSnapshot(candidate(), {
    asOfMs,
    observations: [{ observed_at_ms: 1_001, market_cap_usd: 100_000 }],
  }), /future observation rejected/);

  const snapshot = extractScoutFeatureSnapshot(candidate(), {
    asOfMs,
    observations: [{ observed_at_ms: 999, market_cap_usd: 100_000 }],
    llmDecision: { verdict: 'WATCH', confidence: 73 },
  });
  assert.equal(snapshot.fields.mcap_usd, 22_000);
  assert(snapshot.feature_keys.includes('llm:WATCH:60-79'));
  assert(snapshot.feature_keys.includes('wallet:tier:A'));
});

test('scout runtime has valid telemetry lane tags', () => {
  assert.equal(validateSourceInstance('scout'), 'scout');
  assert.equal(executionLaneForRuntime('dry_run'), 'scout_dry_run');
  assert.equal(validateExecutionLane('scout_dry_run'), 'scout_dry_run');
});

test('reward calculator handles TP, SL, cutoff, breakeven, and unresolved rows', () => {
  assert.equal(calculateScoutReward({ status: 'open' }).eligible, false);

  const tp = calculateScoutReward({
    status: 'closed',
    execution_mode: 'live',
    pnl_sol: 0.02,
    pnl_percent: 100,
    entry_mcap: 10_000,
    high_water_mcap: 25_000,
    exit_reason: 'TP',
  });
  assert.equal(tp.eligible, true);
  assert(tp.reward > 1);

  const sl = calculateScoutReward({
    status: 'closed',
    execution_mode: 'live',
    pnl_sol: -0.01,
    pnl_percent: -50,
    entry_mcap: 10_000,
    high_water_mcap: 11_000,
    exit_reason: 'SL',
  });
  assert(sl.reward < -1);

  const cutoff = calculateScoutReward({
    status: 'closed',
    execution_mode: 'live',
    pnl_sol: -0.004,
    pnl_percent: -20,
    entry_mcap: 10_000,
    high_water_mcap: 20_000,
    exit_reason: 'soft_cutoff',
  });
  assert(cutoff.reward < 0);

  const breakeven = calculateScoutReward({
    status: 'closed',
    execution_mode: 'live',
    pnl_sol: 0,
    pnl_percent: 0,
    entry_mcap: 10_000,
    high_water_mcap: 12_000,
    exit_reason: 'breakeven',
  });
  assert(Math.abs(breakeven.reward) < 0.2);
});

test('weight updater moves deterministically with decay', () => {
  const first = updateFeatureWeight({
    currentWeight: 0,
    reward: 1,
    rewardWeight: 1,
    halfLifeMs: 1_000,
  });
  assert.equal(first.weight, 0.25);

  const second = updateFeatureWeight({
    currentWeight: first.weight,
    currentConfidence: first.confidence,
    currentSamples: first.sample_count,
    reward: -1,
    rewardWeight: 1,
    elapsedMs: 1_000,
    halfLifeMs: 1_000,
  });
  assert(second.weight < first.weight);
  assert(second.confidence >= first.confidence);
});

test('scout DB bootstrap activates scout strategy and records policy weights', () => {
  initDb();
  assert.equal(activeStrategy().id, 'scout');
  assert.equal(rawTradingMode(), 'dry_run');
  const row = {
    id: 1,
    candidate: candidate(),
  };
  const decision = recordScoutDecision({
    candidateRow: row,
    decision: { verdict: 'BUY', confidence: 88 },
    executionAction: 'dry_run_entry',
    policyContext: { policy_version: 'scout-v1' },
    asOfMs: 2_000,
  });
  assert.equal(decision.policy_version, 'scout-v1');

  db.prepare(`
    INSERT INTO scout_reward_events (
      policy_decision_id, position_id, outcome_id, mint, source, reward, reward_weight,
      feature_snapshot_json, created_at_ms
    ) VALUES (?, 10, 'position:10', ?, 'live', 1, 1, ?, 3000)
  `).run(decision.id, row.candidate.token.mint, JSON.stringify(decision.feature_snapshot));

  const update = updateScoutWeightsFromRewards({ policyVersion: activeScoutPolicyVersion() });
  assert(update.updates > 0);
  const learned = db.prepare('SELECT COUNT(*) AS n FROM scout_policy_weights').get();
  assert(learned.n > 0);
  const secondUpdate = updateScoutWeightsFromRewards({ policyVersion: activeScoutPolicyVersion() });
  assert.equal(secondUpdate.updates, 0);
});

test('scout dry-run position stores policy score and pending reward status', () => {
  initDb();
  const c = candidate({ mint: 'PositionMint1111111111111111111111111111111' });
  const decision = {
    id: 123,
    verdict: 'BUY',
    confidence: 90,
    suggested_tp_percent: 60,
    suggested_sl_percent: -20,
    scout_policy: {
      policy_version_id: activeScoutPolicyVersion().id,
      policy_version: 'scout-v1',
      score: 0.42,
      feature_snapshot: extractScoutFeatureSnapshot(c, { asOfMs: 4_000 }),
    },
  };
  const positionId = createDryRunPosition(50, c, decision, 'scout_test');
  const row = db.prepare('SELECT scout_policy_score, scout_reward_status, snapshot_json FROM dry_run_positions WHERE id = ?').get(positionId);
  assert.equal(row.scout_policy_score, 0.42);
  assert.equal(row.scout_reward_status, 'pending');
  assert.equal(JSON.parse(row.snapshot_json).decision.scout_policy.policy_version, 'scout-v1');
});

test('global live execution lock blocks duplicate mints and combined risk', () => {
  initDb();
  const first = acquireLiveExecutionLock({
    mint: 'DupMint11111111111111111111111111111111111',
    amountSol: 0.02,
    lane: 'charon',
    maxOpenSol: 0.04,
  });
  assert.equal(first.acquired, true);

  const dup = acquireLiveExecutionLock({
    mint: 'DupMint11111111111111111111111111111111111',
    amountSol: 0.02,
    lane: 'scout',
    maxOpenSol: 0.04,
  });
  assert.equal(dup.acquired, false);
  assert.equal(dup.reason, 'duplicate_mint_lock');

  const risk = acquireLiveExecutionLock({
    mint: 'RiskMint1111111111111111111111111111111111',
    amountSol: 0.03,
    lane: 'scout',
    maxOpenSol: 0.04,
  });
  assert.equal(risk.acquired, false);
  assert.equal(risk.reason, 'combined_wallet_risk_limit');

  releaseLiveExecutionLock(first.lockId, 'test_done');
});

test('dry-run scout positions cannot release shared live locks by overlapping id', () => {
  initDb();
  const lock = acquireLiveExecutionLock({
    mint: 'SharedLockMint111111111111111111111111111111',
    amountSol: 0.02,
    lane: 'charon',
    maxOpenSol: 0.08,
  });
  assert.equal(lock.acquired, true);
  attachLiveExecutionLockPosition(lock.lockId, 999);

  const dryReleased = releaseLiveExecutionLockForPosition({
    id: 999,
    mint: 'SharedLockMint111111111111111111111111111111',
    execution_mode: 'dry_run',
  }, 'SL');
  assert.equal(dryReleased, false);

  const wrongLaneReleased = releaseLiveExecutionLockForPosition({
    id: 999,
    mint: 'SharedLockMint111111111111111111111111111111',
    execution_mode: 'live',
  }, 'SL');
  assert.equal(wrongLaneReleased, false);

  const row = getLiveLockDb().prepare('SELECT status FROM live_execution_locks WHERE id = ?').get(lock.lockId);
  assert.equal(row.status, 'open');
  releaseLiveExecutionLock(lock.lockId, 'test_done');
});

test('scout dry-run loss stop counts dry-run closed PnL during soak', () => {
  initDb();
  db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, closed_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, execution_mode, strategy_id,
      pnl_sol, pnl_percent, scout_reward_status, snapshot_json
    ) VALUES ('LossStopMint111111111111111111111111111111', 'LOSS', 'closed', ?, ?, 0.02, 0.001, 10000,
      1000, 0.001, 10000, 60, -20, 0, 0, 0, 'dry_run', 'scout', -0.07, -35, 'pending', '{}')
  `).run(Date.now() - 60_000, Date.now() - 30_000);
  const guard = scoutDailyGuard();
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, 'scout_daily_loss_stop');
});
