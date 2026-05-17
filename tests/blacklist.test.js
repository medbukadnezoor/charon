import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-blacklist-'));
process.env.DB_PATH = path.join(tempDir, 'charon-blacklist.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { addMintBlacklist, recordDeployerObservation } = await import('../src/db/blacklist.js');
const { filterCandidate } = await import('../src/pipeline/candidateBuilder.js');
const { refreshPosition } = await import('../src/execution/positions.js');
const { strategyById, updateStrategyConfig } = await import('../src/db/settings.js');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function setPermissiveSniperConfig() {
  const strat = strategyById('sniper');
  const next = {
    ...strat,
    require_fee_claim: false,
    min_fee_claim_sol: 0,
    min_mcap_usd: 0,
    max_mcap_usd: 0,
    min_gmgn_total_fee_sol: 0,
    min_graduated_volume_usd: 0,
    min_holders: 0,
    max_top20_holder_percent: 100,
    min_saved_wallet_holders: 0,
    trending_max_rug_ratio: 0,
    trending_max_bundler_rate: 0,
  };
  delete next.id;
  delete next.name;
  updateStrategyConfig('sniper', next);
}

function candidate(mint, overrides = {}) {
  return {
    token: {
      mint,
      symbol: 'BLK',
      deployer: overrides.deployer || null,
      creator: overrides.creator || null,
    },
    metrics: {
      marketCapUsd: 100_000,
      holderCount: 200,
      gmgnTotalFeesSol: 0,
      graduatedVolumeUsd: 0,
    },
    holders: {
      maxHolderPercent: 12,
      top20Percent: 44,
      holders: overrides.creator
        ? [{ address: overrides.creator, percent: 12, tags: ['creator'] }]
        : [],
    },
    savedWalletExposure: { holderCount: 0 },
    trending: {
      rug_ratio: 0.12,
      bundler_rate: 0.18,
      volume: 0,
      swaps: 0,
      is_wash_trading: false,
    },
    chart: {},
    ...overrides,
  };
}

function insertPositionWithSnapshot(mint, snapshotCandidate) {
  const result = db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      effective_sl_percent, trailing_enabled, trailing_percent, trailing_armed,
      breakeven_armed, breakeven_lock_percent, partial_tp_done, execution_mode, snapshot_json
    ) VALUES (?, 'BLK', 'open', ?, 1, 0.001, 100000, 1000, 0.001, 100000,
      50, -25, -25, 0, 20, 0, 0, 0, 0, 'dry_run', ?)
  `).run(mint, Date.now() - 60_000, JSON.stringify({ candidate: snapshotCandidate }));
  return db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(result.lastInsertRowid);
}

test('initDb creates exact mint blacklist and deployer observation schemas', () => {
  initDb();

  const blacklistColumns = db.prepare('PRAGMA table_info(mint_blacklist)').all().map(row => row.name);
  assert.deepEqual(blacklistColumns, ['mint', 'reason', 'source', 'created_at_ms']);

  const observationColumns = db.prepare('PRAGMA table_info(deployer_observations)').all().map(row => row.name);
  for (const column of [
    'mint',
    'deployer',
    'creator',
    'exit_reason',
    'loss_severity',
    'pnl_percent',
    'pnl_sol',
    'rug_ratio',
    'top_holder_percent',
    'top20_holder_percent',
    'bundler_rate',
    'context_json',
    'observed_at_ms',
  ]) {
    assert.equal(observationColumns.includes(column), true, `missing ${column}`);
  }
});

test('exact mint blacklist blocks only the listed mint', () => {
  initDb();
  setPermissiveSniperConfig();
  addMintBlacklist('BlacklistedMint1111111111111111111111111111', {
    reason: 'test exact mint',
    source: 'test',
    createdAtMs: 123,
  });

  const blocked = filterCandidate(candidate('BlacklistedMint1111111111111111111111111111'));
  assert.equal(blocked.passed, false);
  assert.equal(blocked.primaryFailureCode, 'mint_blacklisted');
  assert.deepEqual(blocked.failureCodes, ['mint_blacklisted']);

  const allowed = filterCandidate(candidate('AllowedMintSameDeployer111111111111111111111', {
    deployer: 'SharedDeployer111111111111111111111111111',
    creator: 'SharedCreator1111111111111111111111111111',
  }));
  assert.equal(allowed.passed, true);
  assert.deepEqual(allowed.failureCodes, []);
});

test('hard-loss exit records deployer observation with compact risk context', async () => {
  initDb();
  setPermissiveSniperConfig();
  const mint = 'ObservedHardLoss1111111111111111111111111111';
  const snapshotCandidate = candidate(mint, {
    deployer: 'DeployerObservation111111111111111111111111',
    creator: 'CreatorObservation1111111111111111111111111',
  });
  const position = insertPositionWithSnapshot(mint, snapshotCandidate);

  const result = await refreshPosition(position, {
    fetchGmgn: async () => null,
    fetchAsset: async () => ({ usdPrice: 0.0007, mcap: 70_000 }),
  });

  assert.equal(result.exitReason, 'SL');
  const row = db.prepare('SELECT * FROM deployer_observations WHERE mint = ?').get(mint);
  assert.equal(row.deployer, 'DeployerObservation111111111111111111111111');
  assert.equal(row.creator, 'CreatorObservation1111111111111111111111111');
  assert.equal(row.exit_reason, 'SL');
  assert.equal(row.loss_severity, 'severe');
  assert.equal(Math.round(row.pnl_percent), -31);
  assert.equal(row.rug_ratio, 0.12);
  assert.equal(row.top_holder_percent, 12);
  assert.equal(row.top20_holder_percent, 44);
  assert.equal(row.bundler_rate, 0.18);
  assert.equal(JSON.parse(row.context_json).source, 'position_exit');
});

test('deployer observations do not block later candidates by deployer', () => {
  initDb();
  setPermissiveSniperConfig();
  const deployer = 'SharedObservedDeployer11111111111111111111';
  const observedMint = 'ObservedMintNoAutoBlock111111111111111111111';
  const nextMint = 'NextMintSameDeployer11111111111111111111111';

  const id = recordDeployerObservation(
    { id: 88, mint: observedMint, symbol: 'OBS', execution_mode: 'dry_run', snapshot_json: JSON.stringify({ candidate: candidate(observedMint, { deployer }) }) },
    { exitReason: 'SL', pnlPercent: -55, pnlSol: -0.55 },
  );
  assert.equal(Number.isInteger(id), true);

  const filtered = filterCandidate(candidate(nextMint, { deployer }));
  assert.equal(filtered.passed, true);
  assert.deepEqual(filtered.failureCodes, []);
});

test('unavailable deployer identity records null instead of blocking or failing', () => {
  initDb();
  const mint = 'UnknownDeployerObservation11111111111111111111';
  const id = recordDeployerObservation(
    { id: 99, mint, symbol: 'UNK', execution_mode: 'dry_run', snapshot_json: '{}' },
    { exitReason: 'TIME_STOP_NO_TP', pnlPercent: -30, pnlSol: -0.3 },
  );

  const row = db.prepare('SELECT deployer, creator, exit_reason, loss_severity FROM deployer_observations WHERE id = ?').get(id);
  assert.equal(row.deployer, null);
  assert.equal(row.creator, null);
  assert.equal(row.exit_reason, 'TIME_STOP_NO_TP');
  assert.equal(row.loss_severity, 'severe');
});
