import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachWalletRecurrenceFeatures,
  buildWalletRecurrenceIndex,
  deriveWalletRecurrenceFeatures,
  extractCandidateWalletFeatures,
  isPublicWalletAddress,
  normalizeWalletTier,
  summarizeWalletPredictiveness,
} from '../src/analysis/walletPredictiveness.js';

const ADDRESS_A = '11111111111111111111111111111111';
const ADDRESS_B = 'So11111111111111111111111111111111111111112';
const ADDRESS_C = 'Vote111111111111111111111111111111111111111';

test('extractCandidateWalletFeatures parses full saved wallet exposure addresses only', () => {
  const features = extractCandidateWalletFeatures({
    holders: {
      holders: [{ address: ADDRESS_C }],
    },
    savedWalletExposure: {
      holderCount: 2,
      matchedWallets: [
        { address: ADDRESS_A, tier: 'A', tags: ['smart_degen', 'alpha'] },
        { address: ADDRESS_A, tier: 'B', tags: ['duplicate_lower_tier'] },
        { addr: 'abcd...wxyz', tier: 'A', tags: ['compact_only'] },
      ],
      evidence: {
        wallets: [
          { walletAddress: ADDRESS_B, tier: 'tier_b', tags: ['smart_money'] },
          { addr: 'short...addr', tier: 'A' },
        ],
      },
    },
  });

  assert.equal(features.candidate_wallet_address_count, 2);
  assert.equal(features.candidate_tier_a_wallet_count, 1);
  assert.equal(features.candidate_best_wallet_tier, 'A');
  assert.equal(features.candidate_smart_degen_present, 1);
  assert.equal(features.candidate_wallet_quality_bucket, 'tier_a');
  assert.deepEqual(features.candidate_wallet_addresses, [ADDRESS_A, ADDRESS_B]);
  assert.equal(features.candidate_wallet_evidence[0].address, ADDRESS_A);
  assert.equal(features.candidate_wallet_evidence[0].tier, 'A');
});

test('extractCandidateWalletFeatures tolerates nearby candidate wallet shapes', () => {
  const features = extractCandidateWalletFeatures({
    saved_wallet_exposure: {
      matched_wallets: [
        { public_key: ADDRESS_C, tier: 'priority', owner_manual_label: 'manual smart-degen' },
      ],
    },
  });

  assert.equal(isPublicWalletAddress(ADDRESS_C), true);
  assert.equal(normalizeWalletTier('priority'), 'A');
  assert.equal(features.candidate_wallet_address_count, 1);
  assert.equal(features.candidate_tier_a_wallet_count, 1);
  assert.equal(features.candidate_smart_degen_present, 1);
  assert.deepEqual(features.candidate_wallet_addresses, [ADDRESS_C]);
});

test('extractCandidateWalletFeatures returns empty candidate defaults without full addresses', () => {
  const features = extractCandidateWalletFeatures({
    savedWalletExposure: {
      holderCount: 2,
      wallets: ['Label only'],
      evidence: { wallets: [{ addr: 'abc...xyz', tier: 'A' }] },
    },
  });

  assert.equal(features.candidate_wallet_address_count, 0);
  assert.equal(features.candidate_tier_a_wallet_count, 0);
  assert.equal(features.candidate_best_wallet_tier, null);
  assert.equal(features.candidate_smart_degen_present, 0);
  assert.equal(features.candidate_wallet_quality_bucket, 'no_wallet_evidence');
  assert.deepEqual(features.candidate_wallet_addresses, []);
});

test('summarizeWalletPredictiveness compares runner and non-runner wallet overlap', () => {
  const summary = summarizeWalletPredictiveness([
    {
      mint: 'RunnerA',
      multiple: 4,
      runner_label: '3x-5x',
      candidate_wallet_address_count: 2,
      candidate_tier_a_wallet_count: 1,
      candidate_best_wallet_tier: 'A',
      candidate_smart_degen_present: 1,
      candidate_wallet_quality_bucket: 'tier_a',
    },
    {
      mint: 'RunnerB',
      multiple: 2.5,
      runner_label: '2x-3x',
      candidate_wallet_address_count: 0,
      candidate_tier_a_wallet_count: 0,
      candidate_best_wallet_tier: null,
      candidate_smart_degen_present: 0,
      candidate_wallet_quality_bucket: 'no_wallet_evidence',
    },
    {
      mint: 'NonRunner',
      multiple: 1.4,
      runner_label: 'sub-2x',
      candidate_wallet_address_count: 1,
      candidate_tier_a_wallet_count: 0,
      candidate_best_wallet_tier: 'B',
      candidate_smart_degen_present: 0,
      candidate_wallet_quality_bucket: 'tier_b',
    },
  ], { thresholds: [2, 3] });

  assert.equal(summary.coverage.total_outcomes, 3);
  assert.equal(summary.coverage.outcomes_with_candidate_wallet_evidence, 2);
  assert.equal(summary.coverage.runners_2x_total, 2);
  assert.equal(summary.coverage.runners_2x_with_candidate_wallet_evidence, 1);
  assert.equal(summary.coverage.runners_3x_total, 1);
  assert.equal(summary.coverage.runners_3x_with_candidate_wallet_evidence, 1);

  const runner2x = summary.threshold_comparison.find(row => row.threshold === 2 && row.group === 'runner');
  const nonRunner2x = summary.threshold_comparison.find(row => row.threshold === 2 && row.group === 'non_runner');
  assert.equal(runner2x.outcomes, 2);
  assert.equal(runner2x.with_candidate_wallet_evidence, 1);
  assert.equal(runner2x.median_candidate_wallet_address_count, 1);
  assert.equal(runner2x.smart_degen_present_count, 1);
  assert.equal(nonRunner2x.outcomes, 1);
  assert.equal(nonRunner2x.median_candidate_tier_a_wallet_count, 0);

  const label3x = summary.quality_by_runner_label.find(row => row.runner_label === '3x-5x');
  assert.equal(label3x.tier_a, 1);
});

test('buildWalletRecurrenceIndex deduplicates repeated wallet evidence per mint', () => {
  const recurrence = buildWalletRecurrenceIndex([
    {
      mint: 'MintRunnerA',
      multiple: 4,
      candidate_wallet_addresses: [ADDRESS_A, ADDRESS_A],
      candidate_wallet_evidence: [
        { address: ADDRESS_A, tier: 'B', tags: ['repeat'] },
        { address: ADDRESS_A, tier: 'A', tags: ['smart_degen'] },
      ],
    },
    {
      mint: 'MintRunnerB',
      multiple: 2.5,
      candidate_wallet_addresses: [ADDRESS_A],
      candidate_wallet_evidence: [{ address: ADDRESS_A, tier: 'B' }],
    },
  ]);

  const wallet = recurrence.wallet_rows.find(row => row.wallet_address === ADDRESS_A);
  assert.equal(wallet.distinct_mint_count, 2);
  assert.equal(wallet.runner_mint_count, 2);
  assert.equal(wallet.runner_3x_mint_count, 1);
  assert.equal(wallet.runner_5x_mint_count, 0);
  assert.equal(wallet.best_observed_tier, 'A');
  assert.deepEqual(wallet.runner_mints, ['MintRunnerA', 'MintRunnerB']);
});

test('buildWalletRecurrenceIndex splits runner and non-runner mint counts', () => {
  const recurrence = buildWalletRecurrenceIndex([
    {
      mint: 'MintRunnerA',
      multiple: 6,
      candidate_wallet_addresses: [ADDRESS_A, ADDRESS_B],
      candidate_wallet_evidence: [{ address: ADDRESS_A, tier: 'A' }],
    },
    {
      mint: 'MintRunnerB',
      multiple: 3.2,
      candidate_wallet_addresses: [ADDRESS_A],
      candidate_wallet_evidence: [{ address: ADDRESS_A, tier: 'B' }],
    },
    {
      mint: 'MintNonRunner',
      multiple: 1.4,
      candidate_wallet_addresses: [ADDRESS_A],
      candidate_wallet_evidence: [{ address: ADDRESS_A, tier: 'C' }],
    },
  ]);

  const walletA = recurrence.wallet_rows.find(row => row.wallet_address === ADDRESS_A);
  const walletB = recurrence.wallet_rows.find(row => row.wallet_address === ADDRESS_B);
  assert.equal(walletA.distinct_mint_count, 3);
  assert.equal(walletA.runner_mint_count, 2);
  assert.equal(walletA.non_runner_mint_count, 1);
  assert.equal(walletA.runner_2x_mint_count, 2);
  assert.equal(walletA.runner_3x_mint_count, 2);
  assert.equal(walletA.runner_5x_mint_count, 1);
  assert.equal(walletB.runner_mint_count, 1);
  assert.equal(walletB.non_runner_mint_count, 0);
});

test('buildWalletRecurrenceIndex summarizes recurring runner thresholds', () => {
  const recurrence = buildWalletRecurrenceIndex([
    { mint: 'A1', multiple: 2.1, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'A2', multiple: 3.1, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'A3', multiple: 5.1, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'B1', multiple: 2.4, candidate_wallet_addresses: [ADDRESS_B] },
    { mint: 'B2', multiple: 1.4, candidate_wallet_addresses: [ADDRESS_B] },
    { mint: 'C1', multiple: 5.5, candidate_wallet_addresses: [ADDRESS_C] },
    { mint: 'C2', multiple: 6.2, candidate_wallet_addresses: [ADDRESS_C] },
  ]);

  assert.deepEqual(recurrence.top_recurring_wallets.map(row => row.wallet_address), [ADDRESS_A, ADDRESS_C, ADDRESS_B]);

  const min2 = recurrence.threshold_summaries.find(row => row.min_runner_mints === 2);
  const min3 = recurrence.threshold_summaries.find(row => row.min_runner_mints === 3);
  const min5 = recurrence.threshold_summaries.find(row => row.min_runner_mints === 5);
  assert.equal(min2.recurring_wallet_count, 2);
  assert.equal(min2.total_runner_mint_links, 5);
  assert.equal(min2.distinct_runner_mints_covered, 5);
  assert.equal(min3.recurring_wallet_count, 1);
  assert.equal(min3.wallets_with_5x_runner_mints, 1);
  assert.equal(min5.recurring_wallet_count, 0);
});

test('deriveWalletRecurrenceFeatures emits compact per-outcome recurrence fields', () => {
  const outcomes = [
    { mint: 'A1', multiple: 2.1, candidate_wallet_addresses: [ADDRESS_A, ADDRESS_A] },
    { mint: 'A2', multiple: 3.1, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'A3', multiple: 5.1, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'B1', multiple: 5.5, candidate_wallet_addresses: [ADDRESS_B] },
    { mint: 'B2', multiple: 6.2, candidate_wallet_addresses: [ADDRESS_B] },
    { mint: 'Probe', multiple: 1.2, candidate_wallet_addresses: [ADDRESS_A, ADDRESS_B, ADDRESS_B] },
    { mint: 'Empty', multiple: 1.1, candidate_wallet_addresses: [] },
  ];
  const recurrence = buildWalletRecurrenceIndex(outcomes);

  assert.deepEqual(deriveWalletRecurrenceFeatures(outcomes[5], recurrence), {
    candidate_recurring_runner_wallet_count_2x: 2,
    candidate_recurring_runner_wallet_count_3x: 1,
    candidate_recurring_runner_wallet_count_5x: 0,
    candidate_best_wallet_runner_recurrence: 3,
    candidate_has_recurring_runner_wallet: 1,
  });
  assert.deepEqual(deriveWalletRecurrenceFeatures(outcomes[6], recurrence), {
    candidate_recurring_runner_wallet_count_2x: 0,
    candidate_recurring_runner_wallet_count_3x: 0,
    candidate_recurring_runner_wallet_count_5x: 0,
    candidate_best_wallet_runner_recurrence: 0,
    candidate_has_recurring_runner_wallet: 0,
  });
});

test('attachWalletRecurrenceFeatures mutates outcomes with recurrence feature columns', () => {
  const outcomes = [
    { mint: 'RunnerA', multiple: 2.2, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'RunnerB', multiple: 3.4, candidate_wallet_addresses: [ADDRESS_A] },
    { mint: 'Candidate', multiple: 1.3, candidate_wallet_addresses: [ADDRESS_A] },
  ];
  const recurrence = buildWalletRecurrenceIndex(outcomes);
  attachWalletRecurrenceFeatures(outcomes, recurrence);

  assert.equal(outcomes[2].candidate_recurring_runner_wallet_count_2x, 1);
  assert.equal(outcomes[2].candidate_recurring_runner_wallet_count_3x, 0);
  assert.equal(outcomes[2].candidate_best_wallet_runner_recurrence, 2);
  assert.equal(outcomes[2].candidate_has_recurring_runner_wallet, 1);
});
