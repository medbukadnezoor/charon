import assert from 'node:assert/strict';
import test from 'node:test';

import {
  csvEscape,
  parseArgs,
  toCsv,
} from '../scripts/analyze_shadow_runners.js';

test('parseArgs supports required Slice 4 CLI flags and defaults', () => {
  const opts = parseArgs([
    '--db=/tmp/shadow.sqlite',
    '--output-dir=reports/shadow-runner-analysis/manual',
    '--harvester-db=/tmp/harvester.db',
    '--min-multiple=3',
    '--max-first-mcap=250000',
    '--skip-observations',
  ]);

  assert.equal(opts.db, '/tmp/shadow.sqlite');
  assert.equal(opts.outputDir, 'reports/shadow-runner-analysis/manual');
  assert.equal(opts.harvesterDb, '/tmp/harvester.db');
  assert.equal(opts.minMultiple, 3);
  assert.equal(opts.maxFirstMcap, 250000);
  assert.equal(opts.skipObservations, true);
});

test('parseArgs keeps backwards-compatible --out alias', () => {
  const opts = parseArgs(['--db=/tmp/shadow.sqlite', '--out=/tmp/reports']);
  assert.equal(opts.out, '/tmp/reports');
  assert.equal(opts.minMultiple, 2);
  assert.equal(opts.maxFirstMcap, 500000);
});

test('CSV export escapes spreadsheet-sensitive cells and serializes arrays', () => {
  assert.equal(csvEscape('a,b "quoted"'), '"a,b ""quoted"""');
  assert.equal(csvEscape(['fee_claim', 'wallet,hit']), '"[""fee_claim"",""wallet,hit""]"');

  const csv = toCsv([
    { mint: 'MintA', first_sources: ['jupiter', 'fee,claim'], symbol: 'A"B' },
    { mint: 'MintB', first_sources: [], symbol: 'plain' },
  ], ['mint', 'symbol', 'first_sources']);

  assert.equal(csv, [
    'mint,symbol,first_sources',
    'MintA,"A""B","[""jupiter"",""fee,claim""]"',
    'MintB,plain,[]',
    '',
  ].join('\n'));
});

test('CSV export can pin guide_source in filter comparison column order', () => {
  const csv = toCsv([
    {
      recipe_name: 'guide_anti_cabal_strict',
      guide_source: 'ponyin',
      threshold: 3,
      tp: 1,
    },
  ], ['recipe_name', 'guide_source', 'threshold', 'tp']);

  assert.equal(csv, [
    'recipe_name,guide_source,threshold,tp',
    'guide_anti_cabal_strict,ponyin,3,1',
    '',
  ].join('\n'));
});
