import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-same-mint-'));
process.env.DB_PATH = path.join(tempDir, 'charon-same-mint.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { hasOpenPositionForMint } = await import('../src/db/positions.js');
const { logAllowedSameMintGuardWarning, sameMintExposureGuard } = await import('../src/execution/router.js');

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function insertPosition({ mint, status }) {
  db.prepare(`
    INSERT INTO dry_run_positions (
      mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
      token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
      trailing_enabled, trailing_percent, trailing_armed, execution_mode, snapshot_json
    ) VALUES (?, 'GUARD', ?, ?, 1, 0.001, 100000, 1000, 0.001, 100000, 50, -25, 0, 20, 0, 'live', '{}')
  `).run(mint, status, Date.now() - 60_000);
}

test('open or partial_exit DB position blocks same-mint live entry', async () => {
  initDb();
  const mint = 'OpenMint11111111111111111111111111111111111';
  insertPosition({ mint, status: 'open' });
  insertPosition({ mint: 'PartialMint111111111111111111111111111111', status: 'partial_exit' });

  assert.equal(hasOpenPositionForMint(mint), true);
  assert.equal(hasOpenPositionForMint('PartialMint111111111111111111111111111111'), true);

  const guard = await sameMintExposureGuard(mint, {
    fetchTokenBalance: async () => '0',
  });
  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, 'open_position');
});

test('non-dust wallet balance blocks same-mint live entry', async () => {
  initDb();
  const guard = await sameMintExposureGuard('WalletBalance111111111111111111111111111111', {
    hasOpenPosition: () => false,
    fetchTokenBalance: async () => '5000',
    dustThresholdRaw: 1000,
  });

  assert.equal(guard.blocked, true);
  assert.equal(guard.reason, 'wallet_balance');
  assert.equal(guard.walletBalanceRaw, 5000);
});

test('clear DB exposure and dust wallet balance allow same-mint live entry', async () => {
  initDb();
  const guard = await sameMintExposureGuard('ClearMint111111111111111111111111111111111', {
    hasOpenPosition: () => false,
    fetchTokenBalance: async () => '1000',
    dustThresholdRaw: 1000,
  });

  assert.equal(guard.blocked, false);
  assert.equal(guard.reason, 'clear');
});

test('failed wallet balance check allows entry with diagnostic reason', async () => {
  initDb();
  const guard = await sameMintExposureGuard('UnknownMint1111111111111111111111111111111', {
    hasOpenPosition: () => false,
    fetchTokenBalance: async () => null,
  });

  assert.equal(guard.blocked, false);
  assert.equal(guard.reason, 'balance_check_failed');
});

test('allowed balance-check failure writes same-mint diagnostic decision log', async () => {
  initDb();
  const selectedRow = {
    id: 77,
    candidate: {
      token: {
        mint: 'DiagnosticMint11111111111111111111111111111',
        symbol: 'DIAG',
      },
      filters: { strategy: 'sniper' },
    },
  };
  const guard = {
    blocked: false,
    reason: 'balance_check_failed',
    walletBalanceRaw: null,
    dustThresholdRaw: 1000,
  };

  logAllowedSameMintGuardWarning({
    batchId: 12,
    triggerCandidateId: 77,
    selectedRow,
    rows: [selectedRow],
    decision: { verdict: 'BUY', confidence: 90 },
    guard,
  });

  const row = db.prepare('SELECT action, reason, selected_mint, guardrails_json, execution_json FROM decision_logs ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.action, 'same_mint_balance_check_failed');
  assert.equal(row.reason, 'balance_check_failed');
  assert.equal(row.selected_mint, selectedRow.candidate.token.mint);
  assert.deepEqual(JSON.parse(row.guardrails_json).sameMintGuard, guard);
  assert.deepEqual(JSON.parse(row.execution_json), {
    blocked: false,
    reason: 'balance_check_failed',
  });
});
