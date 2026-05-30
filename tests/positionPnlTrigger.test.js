import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-position-pnl-'));
process.env.DB_PATH = path.join(tempDir, 'charon-position-pnl.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { refreshPosition } = await import('../src/execution/positions.js');
const { createDryRunPosition, createLivePosition, resolveLiveSniperRisk } = await import('../src/db/positions.js');
const { liveBuyAmountLamports } = await import('../src/execution/router.js');
const { strategyById, updateStrategyConfig, setSetting } = await import('../src/db/settings.js');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function setSniperConfig(overrides = {}) {
  const strat = strategyById('sniper');
  const newConfig = { ...strat, max_hold_ms: 0, max_hold_if_no_tp_ms: 0, ...overrides };
  delete newConfig.id;
  delete newConfig.name;
  updateStrategyConfig('sniper', newConfig);
}

function setLiveRiskTestConfig(overrides = {}) {
  setSniperConfig({
    position_size_sol: 0.03,
    tp_percent: 80,
    sl_percent: -40,
    trailing_enabled: true,
    trailing_arm_percent: null,
    trailing_percent: 20,
    breakeven_after_profit_percent: 0,
    breakeven_lock_percent: 0,
    live_min_position_size_sol: 0.03,
    live_max_position_size_sol: 0.03,
    live_min_tp_percent: 80,
    live_max_tp_percent: 80,
    live_min_sl_percent: -40,
    live_max_sl_percent: -40,
    live_default_risk_profile: 'runner',
    live_risk_policy_enabled: true,
    ...overrides,
  });
}

function insertDryRunPosition(mint, overrides = {}) {
  const row = {
    opened_at_ms: Date.now() - 60_000,
    trailing_enabled: 0,
    trailing_armed: 0,
    breakeven_armed: 0,
    breakeven_armed_at_ms: null,
    breakeven_lock_percent: 0,
    partial_tp_done: 0,
    ...overrides,
  };
  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, breakeven_armed,
      breakeven_armed_at_ms, breakeven_lock_percent, partial_tp_done, execution_mode, snapshot_json
    ) VALUES (?, 'PNL', 'open', ?, 1, 0.001, 100000, 1000, 0.001, 100000, 50, -30, ?, 20, ?, ?, ?, ?, ?, 'dry_run', '{}')
  `).run(
    mint,
    row.opened_at_ms,
    row.trailing_enabled,
    row.trailing_armed,
    row.breakeven_armed,
    row.breakeven_armed_at_ms,
    row.breakeven_lock_percent,
    row.partial_tp_done,
  );
  return db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(result.lastInsertRowid);
}

function insertLiveBreakevenPosition(mint, overrides = {}) {
  const position = insertDryRunPosition(mint, {
    breakeven_armed: 1,
    breakeven_armed_at_ms: Date.now() - 10_000,
    breakeven_lock_percent: 0,
    ...overrides,
  });
  db.prepare(`
    UPDATE dry_run_positions
    SET execution_mode = 'live', token_amount_raw = '1000'
    WHERE id = ?
  `).run(position.id);
  return db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(position.id);
}

test('wallet-level Jupiter PnL does not trigger SL when position mcap PnL is above threshold', async () => {
  initDb();
  setSniperConfig();
  const position = insertDryRunPosition('PnlFiveDown11111111111111111111111111111111');

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.00095, mcap: 95_000 }),
    jupiterPnl: { totalPnlPercentageNative: -80, totalPnlNative: -0.8 },
  });

  const stored = db.prepare('SELECT status, exit_reason FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'open');
  assert.equal(stored.exit_reason, null);
  assert.equal(result.exitReason, null);
  assert.equal(Math.round(result.pnlPercent), -5);
});

test('position-scoped mcap PnL triggers SL at configured threshold', async () => {
  initDb();
  setSniperConfig();
  const position = insertDryRunPosition('PnlThirtyDown111111111111111111111111111111');

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
  });

  const stored = db.prepare('SELECT status, exit_reason, exit_mcap FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'SL');
  assert.equal(stored.exit_mcap, 70_000);
  assert.equal(result.exitReason, 'SL');
});

test('early token effective SL is persisted at position creation when no-TP time stop is enabled', async () => {
  initDb();
  setSniperConfig({
    sl_percent: -25,
    max_hold_if_no_tp_ms: 30_000,
    early_token_age_ms: 60_000,
    early_token_sl_percent: -60,
  });
  const candidate = {
    token: { mint: 'EarlyWideSl111111111111111111111111111111111', symbol: 'EWSL' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: { ageMs: 45_000 },
  };

  const positionId = createDryRunPosition(candidate.id || null, candidate, {
    suggested_tp_percent: 50,
    suggested_sl_percent: -25,
  }, 'test_early_wide_sl');

  const stored = db.prepare(`
    SELECT sl_percent, effective_sl_percent, snapshot_json
    FROM dry_run_positions
    WHERE id = ?
  `).get(positionId);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(stored.sl_percent, -25);
  assert.equal(stored.effective_sl_percent, -60);
  assert.equal(snapshot.effective_sl_percent, -60);
  assert.equal(snapshot.early_token_sl.reason, 'early_token_with_no_tp_time_stop');
  assert.equal(snapshot.early_token_sl.applied, true);
});

test('decision-level watch-dip overrides set size, TP/SL, trailing, and breakeven fields', async () => {
  initDb();
  setSniperConfig({
    position_size_sol: 0.03,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: false,
    trailing_percent: 20,
    breakeven_after_profit_percent: 0,
    breakeven_lock_percent: 0,
  });
  const candidate = {
    token: { mint: 'WatchDipOverride111111111111111111111111111', symbol: 'WDIP' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: {},
  };
  const decision = {
    suggested_position_size_sol: 0.03,
    suggested_tp_percent: 300,
    suggested_sl_percent: -60,
    suggested_trailing_enabled: true,
    suggested_trailing_percent: 35,
    suggested_breakeven_after_profit_percent: 80,
    suggested_breakeven_lock_percent: 20,
  };

  const positionId = createDryRunPosition(null, candidate, decision, 'llm_watch_dip');
  const stored = db.prepare(`
    SELECT size_sol, tp_percent, sl_percent, effective_sl_percent,
           trailing_enabled, trailing_percent, breakeven_lock_percent, snapshot_json
    FROM dry_run_positions WHERE id = ?
  `).get(positionId);
  assert.equal(stored.size_sol, 0.03);
  assert.equal(stored.tp_percent, 300);
  assert.equal(stored.sl_percent, -60);
  assert.equal(stored.effective_sl_percent, -60);
  assert.equal(stored.trailing_enabled, 1);
  assert.equal(stored.trailing_percent, 35);
  assert.equal(stored.breakeven_lock_percent, 20);
  assert.equal(JSON.parse(stored.snapshot_json).decision.suggested_breakeven_after_profit_percent, 80);
});

test('missing token age keeps normal effective SL with explicit snapshot reason', async () => {
  initDb();
  setSniperConfig({
    sl_percent: -25,
    max_hold_if_no_tp_ms: 30_000,
    early_token_age_ms: 60_000,
    early_token_sl_percent: -60,
  });
  const candidate = {
    token: { mint: 'MissingAgeWideSl11111111111111111111111111111', symbol: 'MASL' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: {},
  };

  const positionId = createDryRunPosition(null, candidate, {
    suggested_tp_percent: 50,
    suggested_sl_percent: -25,
  }, 'test_missing_age_sl');

  const stored = db.prepare(`
    SELECT sl_percent, effective_sl_percent, snapshot_json
    FROM dry_run_positions
    WHERE id = ?
  `).get(positionId);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(stored.sl_percent, -25);
  assert.equal(stored.effective_sl_percent, -25);
  assert.equal(snapshot.effective_sl_percent, -25);
  assert.equal(snapshot.early_token_sl.reason, 'token_age_missing');
  assert.equal(snapshot.early_token_sl.applied, false);
});

test('untrusted token age keeps normal effective SL with explicit snapshot reason', async () => {
  initDb();
  setSniperConfig({
    sl_percent: -25,
    max_hold_if_no_tp_ms: 30_000,
    early_token_age_ms: 60_000,
    early_token_sl_percent: -60,
  });
  const candidate = {
    token: { mint: 'UntrustedAgeWideSl11111111111111111111111111', symbol: 'UASL' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: { ageMs: 10_000, ageTrusted: false },
  };

  const positionId = createDryRunPosition(null, candidate, {
    suggested_tp_percent: 50,
    suggested_sl_percent: -25,
  }, 'test_untrusted_age_sl');

  const stored = db.prepare(`
    SELECT sl_percent, effective_sl_percent, snapshot_json
    FROM dry_run_positions
    WHERE id = ?
  `).get(positionId);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(stored.sl_percent, -25);
  assert.equal(stored.effective_sl_percent, -25);
  assert.equal(snapshot.effective_sl_percent, -25);
  assert.equal(snapshot.early_token_sl.reason, 'token_age_untrusted');
  assert.equal(snapshot.early_token_sl.applied, false);
});

test('live position creation records early-token shadow evidence but persists base effective SL', async () => {
  initDb();
  setSniperConfig({
    sl_percent: -25,
    max_hold_if_no_tp_ms: 30_000,
    early_token_age_ms: 60_000,
    early_token_sl_percent: -60,
  });
  const candidate = {
    token: { mint: 'LiveShadowWideSl111111111111111111111111111', symbol: 'LSWS' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: { ageMs: 10_000 },
  };

  const positionId = createLivePosition(null, candidate, {
    suggested_tp_percent: 50,
    suggested_sl_percent: -25,
  }, {
    signature: 'fake-live-entry-signature',
    outputAmount: '1000',
  }, 'test_live_shadow_sl');

  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  const snapshot = JSON.parse(position.snapshot_json);
  assert.equal(position.sl_percent, -25);
  assert.equal(position.effective_sl_percent, -25);
  assert.equal(snapshot.effective_sl_percent, -25);
  assert.equal(snapshot.live_early_token_sl_shadow_only, true);
  assert.equal(snapshot.early_token_sl.effective_sl_percent, -60);
  assert.equal(snapshot.early_token_sl.reason, 'early_token_with_no_tp_time_stop');

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
    executeSell: async () => ({ signature: 'fake-live-exit-signature', outputAmount: '0' }),
    fetchTokenBalance: async () => 0,
    sendReconciliationAlert: async () => {},
  });

  const stored = db.prepare('SELECT status, exit_reason, effective_sl_percent FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.effective_sl_percent, -25);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'SL');
  assert.equal(result.exitReason, 'SL');
});

test('live sniper risk policy clamps weak raw LLM risk to the active strategy policy', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig({
    position_size_sol: 0.03,
    tp_percent: 50,
    sl_percent: -25,
    live_min_position_size_sol: 0.03,
    live_max_position_size_sol: 0.03,
    live_min_tp_percent: 50,
    live_max_tp_percent: 50,
    live_min_sl_percent: -25,
    live_max_sl_percent: -25,
    trailing_enabled: false,
  });

  const risk = resolveLiveSniperRisk({
    suggested_position_size_sol: 0.01,
    suggested_tp_percent: 42,
    suggested_sl_percent: -24,
  }, strategyById('sniper'), { tradingMode: 'live' });

  assert.equal(risk.policy, 'live_sniper_floor_v1');
  assert.equal(risk.resolved_risk.profile, 'conservative');
  assert.equal(risk.resolved_risk.position_size_sol, 0.03);
  assert.equal(risk.resolved_risk.tp_percent, 50);
  assert.equal(risk.resolved_risk.sl_percent, -25);
  assert.equal(risk.resolved_risk.trailing_enabled, false);
  assert.deepEqual(risk.risk_clamps_applied.map(item => item.field), ['position_size_sol', 'tp_percent', 'sl_percent']);
});

test('live sniper runner profile is bounded by the active strategy policy', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig();

  const risk = resolveLiveSniperRisk({ risk_profile: 'runner' }, strategyById('sniper'), { tradingMode: 'live' });

  assert.equal(risk.resolved_risk.profile, 'runner');
  assert.equal(risk.resolved_risk.position_size_sol, 0.03);
  assert.equal(risk.resolved_risk.tp_percent, 80);
  assert.equal(risk.resolved_risk.sl_percent, -40);
  assert.equal(risk.resolved_risk.trailing_enabled, true);
  assert.equal(risk.resolved_risk.trailing_arm_percent, 80);
  assert.equal(risk.resolved_risk.breakeven_after_profit_percent, 0);
});

test('live sniper explicit profile cannot widen active strategy TP/SL', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig();

  const risk = resolveLiveSniperRisk({
    risk_profile: 'runner',
    suggested_position_size_sol: 0.01,
    suggested_tp_percent: 42,
    suggested_sl_percent: -24,
  }, strategyById('sniper'), { tradingMode: 'live' });

  assert.equal(risk.resolved_risk.profile, 'runner');
  assert.equal(risk.resolved_risk.position_size_sol, 0.03);
  assert.equal(risk.resolved_risk.tp_percent, 80);
  assert.equal(risk.resolved_risk.sl_percent, -40);
  assert.deepEqual(risk.risk_clamps_applied.map(item => item.field), ['position_size_sol', 'tp_percent', 'sl_percent']);
});

test('live sniper risk policy defaults missing raw LLM risk to runner', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig();

  const risk = resolveLiveSniperRisk({
    suggested_tp_percent: 50,
    suggested_sl_percent: -25,
    raw: { verdict: 'BUY' },
  }, strategyById('sniper'), { tradingMode: 'live' });

  assert.equal(risk.resolved_risk.profile, 'runner');
  assert.equal(risk.resolved_risk.profile_source, 'strategy_default');
  assert.equal(risk.resolved_risk.tp_percent, 80);
  assert.equal(risk.resolved_risk.sl_percent, -40);
});

test('live sniper risk policy blocks raw values more aggressive than active strategy policy', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig();

  const risk = resolveLiveSniperRisk({
    risk_profile: 'standard',
    suggested_position_size_sol: 0.05,
    suggested_tp_percent: 220,
    suggested_sl_percent: -70,
  }, strategyById('sniper'), { tradingMode: 'live' });

  assert.equal(risk.resolved_risk.profile, 'standard');
  assert.equal(risk.resolved_risk.position_size_sol, 0.03);
  assert.equal(risk.resolved_risk.tp_percent, 80);
  assert.equal(risk.resolved_risk.sl_percent, -40);
  assert.deepEqual(risk.risk_clamps_applied.map(item => item.field), ['position_size_sol', 'tp_percent', 'sl_percent']);
});

test('live sniper TP60 SL20 policy cannot be widened by standard or runner LLM profiles', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig({
    position_size_sol: 0.02,
    tp_percent: 60,
    sl_percent: -20,
    trailing_enabled: false,
    live_min_position_size_sol: 0.02,
    live_max_position_size_sol: 0.02,
    live_min_tp_percent: 60,
    live_max_tp_percent: 60,
    live_min_sl_percent: -20,
    live_max_sl_percent: -20,
  });

  for (const profile of ['standard', 'runner']) {
    const risk = resolveLiveSniperRisk({
      risk_profile: profile,
      suggested_position_size_sol: 0.03,
      suggested_tp_percent: 300,
      suggested_sl_percent: -60,
      suggested_trailing_enabled: true,
    }, strategyById('sniper'), { tradingMode: 'live' });

    assert.equal(risk.resolved_risk.position_size_sol, 0.02);
    assert.equal(risk.resolved_risk.tp_percent, 60);
    assert.equal(risk.resolved_risk.sl_percent, -20);
    assert.equal(risk.resolved_risk.trailing_enabled, false);
    assert.deepEqual(risk.risk_clamps_applied.map(item => item.field), ['position_size_sol', 'tp_percent', 'sl_percent']);
  }
});

test('live router amount uses resolved live sniper minimum size', async () => {
  initDb();
  setLiveRiskTestConfig();

  const { amountLamports, liveRisk } = liveBuyAmountLamports({
    suggested_position_size_sol: 0.005,
    suggested_tp_percent: 42,
    suggested_sl_percent: -24,
  }, strategyById('sniper'));

  assert.equal(amountLamports, 30_000_000);
  assert.equal(liveRisk.resolved_risk.position_size_sol, 0.03);
});

test('createLivePosition stores raw and resolved live sniper risk separately', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig({
    position_size_sol: 0.03,
    tp_percent: 50,
    sl_percent: -25,
    live_min_position_size_sol: 0.03,
    live_max_position_size_sol: 0.03,
    live_min_tp_percent: 50,
    live_max_tp_percent: 50,
    live_min_sl_percent: -25,
    live_max_sl_percent: -25,
    trailing_enabled: false,
  });
  const candidate = {
    token: { mint: 'LiveRiskClamp11111111111111111111111111111', symbol: 'LRISK' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: {},
  };

  const positionId = createLivePosition(null, candidate, {
    suggested_position_size_sol: 0.01,
    suggested_tp_percent: 42,
    suggested_sl_percent: -24,
  }, {
    signature: 'fake-live-risk-entry',
    outputAmount: '1000',
  }, 'test_live_risk_policy');

  const position = db.prepare(`
    SELECT size_sol, tp_percent, sl_percent, effective_sl_percent, trailing_enabled,
           trailing_arm_percent, trailing_percent, breakeven_lock_percent, snapshot_json
    FROM dry_run_positions WHERE id = ?
  `).get(positionId);
  const snapshot = JSON.parse(position.snapshot_json);
  const trade = db.prepare('SELECT size_sol, payload_json FROM dry_run_trades WHERE position_id = ? AND side = ?').get(positionId, 'buy');
  const rule = db.prepare('SELECT tp_percent, sl_percent, trailing_arm_percent FROM tp_sl_rules WHERE position_id = ?').get(positionId);

  assert.equal(position.size_sol, 0.03);
  assert.equal(position.tp_percent, 50);
  assert.equal(position.sl_percent, -25);
  assert.equal(position.effective_sl_percent, -25);
  assert.equal(position.trailing_enabled, 0);
  assert.equal(position.trailing_arm_percent, null);
  assert.equal(position.trailing_percent, 0);
  assert.equal(position.breakeven_lock_percent, 0);
  assert.equal(snapshot.risk_policy, 'live_sniper_floor_v1');
  assert.equal(snapshot.raw_llm_risk.suggested_tp_percent, 42);
  assert.equal(snapshot.resolved_risk.tp_percent, 50);
  assert.equal(trade.size_sol, 0.03);
  assert.equal(JSON.parse(trade.payload_json).resolved_risk.sl_percent, -25);
  assert.equal(rule.tp_percent, 50);
  assert.equal(rule.sl_percent, -25);
  assert.equal(rule.trailing_arm_percent, null);
});

test('createLivePosition persists TP60 SL20 policy when LLM requests runner risk', async () => {
  initDb();
  setSetting('trading_mode', 'live');
  setLiveRiskTestConfig({
    position_size_sol: 0.02,
    tp_percent: 60,
    sl_percent: -20,
    trailing_enabled: false,
    live_min_position_size_sol: 0.02,
    live_min_tp_percent: 60,
    live_min_sl_percent: -20,
  });
  const candidate = {
    token: { mint: 'LiveRiskPolicyBound111111111111111111111111', symbol: 'LBOUND' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: {},
  };

  const positionId = createLivePosition(null, candidate, {
    risk_profile: 'runner',
    suggested_position_size_sol: 0.05,
    suggested_tp_percent: 300,
    suggested_sl_percent: -60,
    suggested_trailing_enabled: true,
    suggested_breakeven_after_profit_percent: 100,
    suggested_breakeven_lock_percent: 20,
  }, {
    signature: 'fake-live-risk-bound-entry',
    outputAmount: '1000',
  }, 'test_live_risk_policy_bound');

  const position = db.prepare(`
    SELECT size_sol, tp_percent, sl_percent, effective_sl_percent, trailing_enabled,
           trailing_arm_percent, trailing_percent, breakeven_lock_percent, snapshot_json
    FROM dry_run_positions WHERE id = ?
  `).get(positionId);
  const snapshot = JSON.parse(position.snapshot_json);
  const trade = db.prepare('SELECT size_sol, payload_json FROM dry_run_trades WHERE position_id = ? AND side = ?').get(positionId, 'buy');
  const rule = db.prepare('SELECT tp_percent, sl_percent, trailing_arm_percent FROM tp_sl_rules WHERE position_id = ?').get(positionId);

  assert.equal(position.size_sol, 0.02);
  assert.equal(position.tp_percent, 60);
  assert.equal(position.sl_percent, -20);
  assert.equal(position.effective_sl_percent, -20);
  assert.equal(position.trailing_enabled, 0);
  assert.equal(position.trailing_arm_percent, null);
  assert.equal(position.trailing_percent, 0);
  assert.equal(position.breakeven_lock_percent, 0);
  assert.equal(snapshot.risk_policy, 'live_sniper_floor_v1');
  assert.equal(snapshot.raw_llm_risk.suggested_tp_percent, 300);
  assert.equal(snapshot.resolved_risk.tp_percent, 60);
  assert.equal(snapshot.resolved_risk.sl_percent, -20);
  assert.equal(snapshot.resolved_risk.trailing_enabled, false);
  assert.deepEqual(snapshot.risk_clamps_applied.map(item => item.field), ['position_size_sol', 'tp_percent', 'sl_percent']);
  assert.equal(trade.size_sol, 0.02);
  assert.equal(JSON.parse(trade.payload_json).resolved_risk.sl_percent, -20);
  assert.equal(rule.tp_percent, 60);
  assert.equal(rule.sl_percent, -20);
  assert.equal(rule.trailing_arm_percent, null);
});

test('dry-run position creation still honors raw LLM risk suggestions', async () => {
  initDb();
  setSetting('trading_mode', 'dry_run');
  setSniperConfig({
    position_size_sol: 0.1,
    tp_percent: 50,
    sl_percent: -25,
    live_risk_policy_enabled: true,
  });
  const candidate = {
    token: { mint: 'DryRunRawRisk11111111111111111111111111111', symbol: 'DRISK' },
    metrics: { priceUsd: 0.001, marketCapUsd: 100_000 },
    signals: {},
  };

  const positionId = createDryRunPosition(null, candidate, {
    suggested_position_size_sol: 0.01,
    suggested_tp_percent: 42,
    suggested_sl_percent: -24,
  }, 'test_dry_run_raw_risk');

  const position = db.prepare('SELECT size_sol, tp_percent, sl_percent, snapshot_json FROM dry_run_positions WHERE id = ?').get(positionId);
  const snapshot = JSON.parse(position.snapshot_json);
  assert.equal(position.size_sol, 0.01);
  assert.equal(position.tp_percent, 42);
  assert.equal(position.sl_percent, -24);
  assert.equal(snapshot.resolved_risk, undefined);
});

test('old positions without trailing_arm_percent still arm trailing at tp_percent', async () => {
  initDb();
  setSniperConfig();
  const position = insertDryRunPosition('OldTrailingArm111111111111111111111111111111', {
    trailing_enabled: 1,
  });

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0016, mcap: 160_000 }),
    autoExit: false,
  });

  const stored = db.prepare('SELECT trailing_armed FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.trailing_armed, 1);
  assert.equal(result.trailing_armed, 1);
});

test('existing position without persisted effective SL is not widened retroactively', async () => {
  initDb();
  setSniperConfig({
    sl_percent: -25,
    max_hold_if_no_tp_ms: 30_000,
    early_token_age_ms: 60_000,
    early_token_sl_percent: -60,
  });
  const position = insertDryRunPosition('LegacyNoEffectiveSl1111111111111111111111111');

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.00065, mcap: 65_000 }),
  });

  const stored = db.prepare('SELECT status, exit_reason, effective_sl_percent FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.effective_sl_percent, null);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'SL');
  assert.equal(result.effective_sl_percent, -30);
  assert.equal(result.exitReason, 'SL');
});

test('max_hold_if_no_tp_ms closes stale position before TP with TIME_STOP_NO_TP', async () => {
  initDb();
  setSniperConfig({ max_hold_if_no_tp_ms: 30_000 });
  const position = insertDryRunPosition('NoTpTimeStop11111111111111111111111111111111', {
    opened_at_ms: Date.now() - 31_000,
  });

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.001, mcap: 100_000 }),
  });

  const stored = db.prepare('SELECT status, exit_reason, exit_mcap FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'TIME_STOP_NO_TP');
  assert.equal(stored.exit_mcap, 100_000);
  assert.equal(result.exitReason, 'TIME_STOP_NO_TP');
});

test('max_hold_if_no_tp_ms does not close trailing-armed runner', async () => {
  initDb();
  setSniperConfig({ max_hold_if_no_tp_ms: 30_000 });
  const position = insertDryRunPosition('TrailingRunnerNoTimeStop1111111111111111111111', {
    opened_at_ms: Date.now() - 31_000,
    trailing_enabled: 1,
    trailing_armed: 1,
  });

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.001, mcap: 100_000 }),
  });

  const stored = db.prepare('SELECT status, exit_reason FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'open');
  assert.equal(stored.exit_reason, null);
  assert.equal(result.exitReason, null);
});

test('breakeven lock arms at configured profit without closing or marking partial TP', async () => {
  initDb();
  setSniperConfig({
    breakeven_after_profit_percent: 50,
    breakeven_lock_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 50,
    partial_tp_sell_percent: 50,
  });
  const position = insertDryRunPosition('BreakevenArmOnly1111111111111111111111111111');

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0015, mcap: 150_000 }),
  });

  const stored = db.prepare(`
    SELECT status, exit_reason, breakeven_armed, breakeven_armed_at_ms,
           breakeven_lock_percent, partial_tp_done
    FROM dry_run_positions
    WHERE id = ?
  `).get(position.id);
  assert.equal(stored.status, 'open');
  assert.equal(stored.exit_reason, null);
  assert.equal(stored.breakeven_armed, 1);
  assert.equal(Boolean(stored.breakeven_armed_at_ms), true);
  assert.equal(stored.breakeven_lock_percent, 0);
  assert.equal(stored.partial_tp_done, 0);
  assert.equal(result.exitReason, null);
  assert.equal(result.breakeven_armed, 1);
});

test('armed breakeven lock closes at configured floor without partial TP state', async () => {
  initDb();
  setSniperConfig({
    breakeven_after_profit_percent: 50,
    breakeven_lock_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 50,
    partial_tp_sell_percent: 50,
  });
  const position = insertDryRunPosition('BreakevenFloorClose1111111111111111111111111', {
    breakeven_armed: 1,
    breakeven_armed_at_ms: Date.now() - 10_000,
    breakeven_lock_percent: 0,
  });

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.001, mcap: 100_000 }),
  });

  const stored = db.prepare(`
    SELECT status, exit_reason, breakeven_armed, breakeven_lock_percent, partial_tp_done
    FROM dry_run_positions
    WHERE id = ?
  `).get(position.id);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'BREAKEVEN_LOCK');
  assert.equal(stored.breakeven_armed, 1);
  assert.equal(stored.breakeven_lock_percent, 0);
  assert.equal(stored.partial_tp_done, 0);
  assert.equal(result.exitReason, 'BREAKEVEN_LOCK');
});

test('live breakeven lock defers when executable estimate is below floor', async () => {
  initDb();
  setSniperConfig({
    breakeven_after_profit_percent: 50,
    breakeven_lock_percent: 0,
  });
  const position = insertLiveBreakevenPosition('LiveBreakevenDefer111111111111111111111111');
  let sellCalls = 0;

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.001, mcap: 100_000 }),
    estimateExecutableExit: async () => ({ outputAmount: '950000000', source: 'test_quote' }),
    executeSell: async () => {
      sellCalls += 1;
      return { signature: 'unexpected-sell', outputAmount: '950000000' };
    },
    fetchTokenBalance: async () => 0,
    sendReconciliationAlert: async () => {},
  });

  const stored = db.prepare('SELECT status, exit_reason, snapshot_json FROM dry_run_positions WHERE id = ?').get(position.id);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.equal(sellCalls, 0);
  assert.equal(stored.status, 'open');
  assert.equal(stored.exit_reason, null);
  assert.equal(result.exitReason, null);
  assert.equal(result.deferredBreakevenExit.reason, 'executable_estimate_below_floor');
  assert.equal(snapshot.breakeven_exit_deferred.estimated_sol, 0.95);
  assert.equal(snapshot.breakeven_exit_deferred.floor_sol, 1);
});

test('live breakeven lock sells when executable estimate meets floor', async () => {
  initDb();
  setSniperConfig({
    breakeven_after_profit_percent: 50,
    breakeven_lock_percent: 0,
  });
  const position = insertLiveBreakevenPosition('LiveBreakevenProceed1111111111111111111111');
  const sellReasons = [];

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.001, mcap: 100_000 }),
    estimateExecutableExit: async () => ({ outputAmount: '1000000000', source: 'test_quote' }),
    executeSell: async (_position, reason) => {
      sellReasons.push(reason);
      return { signature: 'fake-live-breakeven-exit', outputAmount: '1000000000' };
    },
    fetchTokenBalance: async () => 0,
    sendReconciliationAlert: async () => {},
  });

  const stored = db.prepare('SELECT status, exit_reason, exit_signature FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.deepEqual(sellReasons, ['BREAKEVEN_LOCK']);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'BREAKEVEN_LOCK');
  assert.equal(stored.exit_signature, 'fake-live-breakeven-exit');
  assert.equal(result.exitReason, 'BREAKEVEN_LOCK');
});

test('live SL still sells when breakeven executable estimate is below floor', async () => {
  initDb();
  setSniperConfig({
    breakeven_after_profit_percent: 50,
    breakeven_lock_percent: 0,
  });
  const position = insertLiveBreakevenPosition('LiveBreakevenPoorQuoteSl1111111111111111111');
  const sellReasons = [];

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
    estimateExecutableExit: async () => ({ outputAmount: '600000000', source: 'test_quote' }),
    executeSell: async (_position, reason) => {
      sellReasons.push(reason);
      return { signature: 'fake-live-sl-exit', outputAmount: '600000000' };
    },
    fetchTokenBalance: async () => 0,
    sendReconciliationAlert: async () => {},
  });

  const stored = db.prepare('SELECT status, exit_reason, exit_signature, snapshot_json FROM dry_run_positions WHERE id = ?').get(position.id);
  const snapshot = JSON.parse(stored.snapshot_json);
  assert.deepEqual(sellReasons, ['SL']);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'SL');
  assert.equal(stored.exit_signature, 'fake-live-sl-exit');
  assert.equal(result.exitReason, 'SL');
  assert.equal(snapshot.breakeven_exit_deferred, undefined);
  assert.equal(result.deferredBreakevenExit, null);
});
