import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';

import {
  analyzeHarvesterCoverage,
  detectHarvesterSightingSchema,
  skippedHarvesterCoverage,
} from '../src/analysis/harvesterCoverage.js';

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'charon-harvester-coverage-'));
  const dbPath = path.join(dir, 'harvester.db');
  const db = new Database(dbPath);
  return {
    db,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BASE = Date.parse('2026-05-18T00:00:00.000Z');

test('detectHarvesterSightingSchema prefers sightings table with mint/timestamp/source columns', () => {
  const { db, close } = tempDb();
  try {
    db.exec(`
      CREATE TABLE tokens (id INTEGER PRIMARY KEY, token_mint TEXT);
      CREATE TABLE sightings (
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        seen_at_ms INTEGER,
        source TEXT
      );
    `);

    assert.deepEqual(detectHarvesterSightingSchema(db), {
      table: 'sightings',
      mint_column: 'mint',
      timestamp_column: 'seen_at_ms',
      source_column: 'source',
      score: 107,
    });
  } finally {
    close();
  }
});

test('analyzeHarvesterCoverage summarizes coverage and timing buckets', () => {
  const { db, close } = tempDb();
  try {
    db.exec(`
      CREATE TABLE sightings (
        id INTEGER PRIMARY KEY,
        mint TEXT NOT NULL,
        seen_at_ms INTEGER,
        source TEXT
      );
    `);
    const insert = db.prepare('INSERT INTO sightings (mint, seen_at_ms, source) VALUES (?, ?, ?)');
    insert.run('RunnerBefore', BASE - 60_000, 'gmgn');
    insert.run('RunnerNear', BASE + 10 * 60_000, 'trenches');
    insert.run('RunnerLate', BASE + 90 * 60_000, 'trending');
    insert.run('RunnerAfterPeak', BASE + 3 * 60 * 60_000, 'gmgn');
    insert.run('NonRunner', BASE + 5 * 60_000, 'gmgn');
    insert.run('UnrelatedMint', BASE, 'gmgn');

    const coverage = analyzeHarvesterCoverage([
      { mint: 'RunnerBefore', symbol: 'BEF', multiple: 2.1, runner_label: '2x-3x', first_seen_at_ms: BASE, max_mcap_at_ms: BASE + 60 * 60_000 },
      { mint: 'RunnerNear', symbol: 'NEAR', multiple: 3.2, runner_label: '3x-5x', first_seen_at_ms: BASE, max_mcap_at_ms: BASE + 60 * 60_000 },
      { mint: 'RunnerLate', symbol: 'LATE', multiple: 5.2, runner_label: '5x-10x', first_seen_at_ms: BASE, max_mcap_at_ms: BASE + 2 * 60 * 60_000 },
      { mint: 'RunnerAfterPeak', symbol: 'AFT', multiple: 6.1, runner_label: '5x-10x', first_seen_at_ms: BASE, max_mcap_at_ms: BASE + 60 * 60_000 },
      { mint: 'RunnerMissing', symbol: 'MISS', multiple: 4.1, runner_label: '3x-5x', first_seen_at_ms: BASE, max_mcap_at_ms: BASE + 60 * 60_000 },
      { mint: 'NonRunner', symbol: 'NO', multiple: 1.2, runner_label: 'sub-2x', first_seen_at_ms: BASE, max_mcap_at_ms: BASE + 60 * 60_000 },
    ], db);

    assert.equal(coverage.status, 'ok');
    assert.equal(coverage.total_outcomes, 6);
    assert.equal(coverage.total_runners_2x, 5);
    assert.equal(coverage.total_runners_3x, 4);
    assert.equal(coverage.total_runners_5x, 2);
    assert.equal(coverage.outcomes_with_harvester_coverage, 5);
    assert.equal(coverage.sighted_before_shadow, 1);
    assert.equal(coverage.sighted_within_15m, 3);
    assert.equal(coverage.sighted_within_plus_2h, 3);
    assert.equal(coverage.sighted_after_peak, 1);

    const runners2x = coverage.coverage_by_threshold.find(row => row.threshold === 2);
    assert.equal(runners2x.total, 5);
    assert.equal(runners2x.with_harvester_coverage, 4);
    assert.equal(runners2x.sighted_before_shadow, 1);
    assert.equal(runners2x.sighted_within_15m, 2);
    assert.equal(runners2x.sighted_within_plus_2h, 2);
    assert.equal(runners2x.sighted_after_peak, 1);

    const lateRow = coverage.outcome_rows.find(row => row.mint === 'RunnerLate');
    assert.deepEqual(lateRow.harvester_sources, ['trending']);
    assert.equal(lateRow.sighted_within_plus_2h, 1);
  } finally {
    close();
  }
});

test('analyzeHarvesterCoverage returns unsupported schema without claiming zero coverage', () => {
  const { db, close } = tempDb();
  try {
    db.exec('CREATE TABLE unrelated (id INTEGER PRIMARY KEY, wallet_address TEXT, note TEXT);');
    const coverage = analyzeHarvesterCoverage([
      { mint: 'RunnerA', multiple: 3, first_seen_at_ms: BASE, max_mcap_at_ms: BASE },
    ], db);

    assert.equal(coverage.status, 'unsupported_schema');
    assert.match(coverage.reason, /No supported harvester sightings table/);
    assert.equal(coverage.total_outcomes, 1);
    assert.equal(coverage.total_runners_3x, 1);
    assert.equal(coverage.outcomes_with_harvester_coverage, 0);
    assert.match(coverage.interpretation, /could not identify/i);
  } finally {
    close();
  }
});

test('skippedHarvesterCoverage reports omitted harvester DB as skipped', () => {
  const coverage = skippedHarvesterCoverage();
  assert.equal(coverage.status, 'skipped');
  assert.match(coverage.interpretation, /skipped/i);
});
