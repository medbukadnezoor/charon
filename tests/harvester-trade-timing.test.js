import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeHarvesterTradeTiming,
  detectHarvesterTradeSchema,
  skippedHarvesterTradeTiming,
} from '../src/analysis/harvesterTradeTiming.js';

function fakeDb(tables) {
  const tableEntries = Object.entries(tables).map(([name, spec]) => ({
    name,
    columns: spec.columns,
    rows: spec.rows || [],
  }));
  const byName = new Map(tableEntries.map(table => [table.name, table]));

  return {
    prepare(sql) {
      return {
        all(...params) {
          if (/FROM sqlite_master/i.test(sql)) {
            return tableEntries.map(table => ({ name: table.name })).sort((a, b) => a.name.localeCompare(b.name));
          }

          const pragma = sql.match(/PRAGMA table_info\("([^"]+)"\)/i);
          if (pragma) {
            return (byName.get(pragma[1])?.columns || []).map(name => ({ name }));
          }

          const select = sql.match(/SELECT\s+"([^"]+)"\s+AS mint,\s+"([^"]+)"\s+AS wallet_address,\s+"([^"]+)"\s+AS traded_at_raw,\s+(?:"([^"]+)"|NULL)\s+AS side_raw\s+FROM\s+"([^"]+)"/i);
          if (select) {
            const [, mintColumn, walletColumn, timestampColumn, sideColumn, tableName] = select;
            const [mint, wallet] = params;
            return (byName.get(tableName)?.rows || [])
              .filter(row => row[mintColumn] === mint && row[walletColumn] === wallet)
              .sort((a, b) => Number(a[timestampColumn] || 0) - Number(b[timestampColumn] || 0))
              .map(row => ({
                mint: row[mintColumn],
                wallet_address: row[walletColumn],
                traded_at_raw: row[timestampColumn],
                side_raw: sideColumn ? row[sideColumn] : null,
              }));
          }

          throw new Error(`Unsupported fake all() SQL: ${sql}`);
        },
        get() {
          const count = sql.match(/SELECT COUNT\(\*\) AS count FROM "([^"]+)"/i);
          if (count) return { count: byName.get(count[1])?.rows.length || 0 };
          throw new Error(`Unsupported fake get() SQL: ${sql}`);
        },
      };
    },
  };
}

const BASE = Date.parse('2026-05-18T00:00:00.000Z');
const WALLET_A = '11111111111111111111111111111111';
const WALLET_B = 'So11111111111111111111111111111111111111112';
const WALLET_C = 'Vote111111111111111111111111111111111111111';

test('detectHarvesterTradeSchema detects supported trade table conservatively', () => {
  const db = fakeDb({
    sightings: {
      columns: ['mint', 'seen_at_ms'],
    },
    wallet_trades: {
      columns: ['id', 'token_mint', 'wallet_address', 'traded_at_ms', 'action'],
    },
  });

  assert.deepEqual(detectHarvesterTradeSchema(db), {
    table: 'wallet_trades',
    mint_column: 'token_mint',
    wallet_column: 'wallet_address',
    timestamp_column: 'traded_at_ms',
    side_column: 'action',
    score: 68,
  });
});

test('analyzeHarvesterTradeTiming classifies buy-before, buy-after, and no matched trade', () => {
  const db = fakeDb({
    trades: {
      columns: ['id', 'mint', 'wallet_address', 'timestamp_ms', 'side'],
      rows: [
        { mint: 'MintBefore', wallet_address: WALLET_A, timestamp_ms: BASE - 60_000, side: 'buy' },
        { mint: 'MintAfter', wallet_address: WALLET_B, timestamp_ms: BASE + 60_000, side: 'BUY' },
        { mint: 'MintBefore', wallet_address: WALLET_B, timestamp_ms: BASE - 60_000, side: 'sell' },
        { mint: 'UnrelatedMint', wallet_address: WALLET_A, timestamp_ms: BASE - 60_000, side: 'buy' },
      ],
    },
  });

  const timing = analyzeHarvesterTradeTiming([
    { mint: 'MintBefore', symbol: 'BEF', multiple: 3.1, runner_label: '3x-5x', first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_A, WALLET_B] },
    { mint: 'MintAfter', symbol: 'AFT', multiple: 2.2, runner_label: '2x-3x', first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_B] },
    { mint: 'MintMissing', symbol: 'MISS', multiple: 5.2, runner_label: '5x-10x', first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_C] },
  ], db);

  assert.equal(timing.status, 'ok');
  assert.equal(timing.total_candidate_pairs, 4);
  assert.equal(timing.timing.bought_before_shadow, 1);
  assert.equal(timing.timing.bought_after_shadow, 1);
  assert.equal(timing.timing.no_matched_trade, 1);
  assert.equal(timing.timing.no_buy_trade, 1);

  const before = timing.pair_rows.find(row => row.mint === 'MintBefore' && row.wallet_address === WALLET_A);
  const after = timing.pair_rows.find(row => row.mint === 'MintAfter');
  const missing = timing.pair_rows.find(row => row.mint === 'MintMissing');
  const sellOnly = timing.pair_rows.find(row => row.mint === 'MintBefore' && row.wallet_address === WALLET_B);
  assert.equal(before.timing_bucket, 'bought_before_shadow');
  assert.equal(after.timing_bucket, 'bought_after_shadow');
  assert.equal(missing.timing_bucket, 'no_matched_trade');
  assert.equal(sellOnly.timing_bucket, 'no_buy_trade');

  const runners3x = timing.timing_by_threshold.find(row => row.threshold === 3);
  assert.equal(runners3x.total_pairs, 3);
  assert.equal(runners3x.bought_before_shadow, 1);
  assert.equal(runners3x.no_matched_trade, 1);
});

test('analyzeHarvesterTradeTiming reports unknown side timing without buy proof', () => {
  const db = fakeDb({
    swaps: {
      columns: ['id', 'token_mint', 'owner', 'block_time'],
      rows: [
        { token_mint: 'MintUnknownBefore', owner: WALLET_A, block_time: Math.trunc((BASE - 60_000) / 1000) },
        { token_mint: 'MintUnknownAfter', owner: WALLET_B, block_time: Math.trunc((BASE + 60_000) / 1000) },
      ],
    },
  });

  const timing = analyzeHarvesterTradeTiming([
    { mint: 'MintUnknownBefore', multiple: 4.1, first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_A] },
    { mint: 'MintUnknownAfter', multiple: 4.1, first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_B] },
  ], db);

  assert.equal(timing.status, 'ok');
  assert.equal(timing.schema.side_column, null);
  assert.equal(timing.timing.bought_before_shadow, 0);
  assert.equal(timing.timing.bought_after_shadow, 0);
  assert.equal(timing.timing.unknown_side_pairs, 2);
  assert.equal(timing.timing.trade_unknown_side_before_shadow, 1);
  assert.equal(timing.timing.trade_unknown_side_after_shadow, 1);
  assert.deepEqual(timing.pair_rows.map(row => row.timing_bucket).sort(), [
    'trade_unknown_side_after_shadow',
    'trade_unknown_side_before_shadow',
  ]);
});

test('analyzeHarvesterTradeTiming reports unsupported schema without claiming zero evidence', () => {
  const db = fakeDb({
    unrelated: {
      columns: ['id', 'wallet_address', 'note'],
    },
  });
  const timing = analyzeHarvesterTradeTiming([
    { mint: 'MintA', multiple: 3, first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_A] },
  ], db);

  assert.equal(timing.status, 'unsupported_schema');
  assert.equal(timing.total_candidate_pairs, 1);
  assert.match(timing.reason, /No supported harvester trade\/swap table/);
  assert.equal(timing.pair_rows.length, 0);
});

test('analyzeHarvesterTradeTiming reports no_trade_history for empty supported table', () => {
  const db = fakeDb({
    trades: {
      columns: ['id', 'mint', 'wallet_address', 'timestamp_ms', 'side'],
      rows: [],
    },
  });

  const timing = analyzeHarvesterTradeTiming([
    { mint: 'MintA', multiple: 3, first_seen_at_ms: BASE, candidate_wallet_addresses: [WALLET_A] },
  ], db);

  assert.equal(timing.status, 'no_trade_history');
  assert.equal(timing.total_trade_rows, 0);
  assert.equal(timing.total_candidate_pairs, 1);
  assert.match(timing.reason, /contains no rows/);
});

test('skippedHarvesterTradeTiming reports omitted harvester DB as skipped', () => {
  const timing = skippedHarvesterTradeTiming();
  assert.equal(timing.status, 'skipped');
  assert.match(timing.reason, /no --harvester-db/);
});
