import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-live-sell-recon-'));
process.env.DB_PATH = path.join(tempDir, 'charon-live-sell-recon.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { refreshPosition } = await import('../src/execution/positions.js');
const { strategyById, updateStrategyConfig } = await import('../src/db/settings.js');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function insertLivePosition(overrides = {}) {
  const row = {
    mint: 'MintLiveSell1111111111111111111111111111111',
    symbol: 'SELL',
    status: 'open',
    opened_at_ms: Date.now() - 60_000,
    size_sol: 1,
    entry_price: 0.001,
    entry_mcap: 100_000,
    token_amount_est: 50_000,
    high_water_price: 0.001,
    high_water_mcap: 100_000,
    tp_percent: 50,
    sl_percent: -25,
    trailing_enabled: 0,
    trailing_percent: 20,
    trailing_armed: 0,
    breakeven_armed: 0,
    breakeven_armed_at_ms: null,
    breakeven_lock_percent: 0,
    partial_tp_done: 0,
    execution_mode: 'live',
    token_amount_raw: '50000',
    snapshot_json: '{}',
    ...overrides,
  };
  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, breakeven_armed,
      breakeven_armed_at_ms, breakeven_lock_percent, partial_tp_done,
      execution_mode, token_amount_raw, snapshot_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.mint,
    row.symbol,
    row.status,
    row.opened_at_ms,
    row.size_sol,
    row.entry_price,
    row.entry_mcap,
    row.token_amount_est,
    row.high_water_price,
    row.high_water_mcap,
    row.tp_percent,
    row.sl_percent,
    row.trailing_enabled,
    row.trailing_percent,
    row.trailing_armed,
    row.breakeven_armed,
    row.breakeven_armed_at_ms,
    row.breakeven_lock_percent,
    row.partial_tp_done,
    row.execution_mode,
    row.token_amount_raw,
    row.snapshot_json,
  );
  return db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(result.lastInsertRowid);
}

function setSniperConfig(overrides = {}) {
  const strat = strategyById('sniper');
  const newConfig = { ...strat, max_hold_ms: 0, max_hold_if_no_tp_ms: 0, ...overrides };
  delete newConfig.id;
  delete newConfig.name;
  updateStrategyConfig('sniper', newConfig);
}

test('dust post-sell balance closes live position normally', async () => {
  initDb();
  const position = insertLivePosition({ mint: 'DustBalance111111111111111111111111111111111' });
  const alerts = [];

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
    executeSell: async () => ({ signature: 'sig-dust', outputAmount: '800000000' }),
    fetchTokenBalance: async () => '999',
    sendReconciliationAlert: async payload => alerts.push(payload),
  });

  const stored = db.prepare('SELECT status, closed_at_ms, exit_signature FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'closed');
  assert.equal(Boolean(stored.closed_at_ms), true);
  assert.equal(stored.exit_signature, 'sig-dust');
  assert.equal(result.exitReason, 'SL');
  assert.equal(alerts.length, 0);
});

test('residual post-sell balance keeps live position in partial_exit and alerts operator', async () => {
  initDb();
  const position = insertLivePosition({ mint: 'ResidualBalance111111111111111111111111111111' });
  const alerts = [];

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
    executeSell: async () => ({ signature: 'sig-residual', outputAmount: '800000000' }),
    fetchTokenBalance: async () => '32132',
    sendReconciliationAlert: async payload => alerts.push(payload),
  });

  const stored = db.prepare('SELECT status, closed_at_ms, token_amount_raw, exit_signature FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'partial_exit');
  assert.equal(stored.closed_at_ms, null);
  assert.equal(stored.token_amount_raw, '32132');
  assert.equal(stored.exit_signature, 'sig-residual');
  assert.equal(result.exitReason, null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].remainingBalance, 32132);
});

test('failed post-sell balance check closes live position and alerts operator', async () => {
  initDb();
  const position = insertLivePosition({ mint: 'UnknownBalance1111111111111111111111111111111' });
  const alerts = [];

  await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
    executeSell: async () => ({ signature: 'sig-unknown', outputAmount: '800000000' }),
    fetchTokenBalance: async () => null,
    sendReconciliationAlert: async payload => alerts.push(payload),
  });

  const stored = db.prepare('SELECT status, closed_at_ms, exit_signature FROM dry_run_positions WHERE id = ?').get(position.id);
  assert.equal(stored.status, 'closed');
  assert.equal(Boolean(stored.closed_at_ms), true);
  assert.equal(stored.exit_signature, 'sig-unknown');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].balanceCheckFailed, true);
});

test('armed breakeven lock live exit sells the full position once without partial TP state', async () => {
  initDb();
  setSniperConfig({
    breakeven_after_profit_percent: 50,
    breakeven_lock_percent: 0,
    partial_tp: true,
    partial_tp_at_percent: 50,
    partial_tp_sell_percent: 50,
  });
  const position = insertLivePosition({
    mint: 'LiveBreakevenLock111111111111111111111111111',
    breakeven_armed: 1,
    breakeven_armed_at_ms: Date.now() - 10_000,
    breakeven_lock_percent: 0,
    partial_tp_done: 0,
  });
  const sells = [];

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.001, mcap: 100_000 }),
    executeSell: async (sellPosition, reason) => {
      sells.push({ tokenAmountRaw: sellPosition.token_amount_raw, reason });
      return { signature: 'sig-breakeven', outputAmount: '1000000000' };
    },
    fetchTokenBalance: async () => '0',
    sendReconciliationAlert: async () => {},
  });

  const stored = db.prepare(`
    SELECT status, exit_reason, exit_signature, token_amount_raw, partial_tp_done
    FROM dry_run_positions
    WHERE id = ?
  `).get(position.id);
  assert.deepEqual(sells, [{ tokenAmountRaw: '50000', reason: 'BREAKEVEN_LOCK' }]);
  assert.equal(stored.status, 'closed');
  assert.equal(stored.exit_reason, 'BREAKEVEN_LOCK');
  assert.equal(stored.exit_signature, 'sig-breakeven');
  assert.equal(stored.token_amount_raw, '50000');
  assert.equal(stored.partial_tp_done, 0);
  assert.equal(result.exitReason, 'BREAKEVEN_LOCK');
});
