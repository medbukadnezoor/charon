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
const { createDryRunPosition, createLivePosition } = await import('../src/db/positions.js');
const { strategyById, updateStrategyConfig } = await import('../src/db/settings.js');

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
