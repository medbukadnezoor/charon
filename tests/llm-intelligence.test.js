import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTieredEnvelope,
  classifyTier,
  computeOverlapQuality,
  enforcePayloadBudget,
} from '../src/pipeline/llm-intelligence.js';

test('classifyTier follows severity and confidence rules', () => {
  assert.equal(classifyTier({ severity: 'critical', confidence: 1 }), 'critical');
  assert.equal(classifyTier({ severity: 'high', confidence: 71 }), 'critical');
  assert.equal(classifyTier({ severity: 'high', confidence: 70 }), 'notable');
  assert.equal(classifyTier({ severity: 'medium', confidence: 100 }), 'notable');
  assert.equal(classifyTier({ severity: 'low', confidence: 100 }), 'routine');
});

test('buildTieredEnvelope orders conclusions and applies evidence by tier', () => {
  const envelope = buildTieredEnvelope({
    summary: {
      count: 10,
      top5Percent: 25,
      top10Percent: 40,
      top20Percent: 55,
      maxHolderPercent: 9,
      largeHolderCount: 3,
      concentrationRisk: 'medium',
    },
    conclusions: [
      { signal: 'routine_a', severity: 'low', confidence: 90, explanation: 'routine', evidence: ['1111...aaa'] },
      { signal: 'critical_a', severity: 'critical', confidence: 40, explanation: 'critical', evidence: ['1111...aaa', '2222...bbb', '3333...ccc'], metrics: { clusterSize: 3 } },
      { signal: 'notable_a', severity: 'high', confidence: 70, explanation: 'notable', evidence: ['1111...aaa', '2222...bbb', '3333...ccc'] },
    ],
  }, { holderCount: 0, evidence: { wallets: [] } });

  assert.deepEqual(envelope.conclusions.map(item => item.signal), ['critical_a', 'notable_a', 'routine_a']);
  assert.equal(envelope.conclusions[0].tier, 'critical');
  assert.equal(envelope.conclusions[0].evidence.length, 3);
  assert.deepEqual(envelope.conclusions[0].metrics, { clusterSize: 3 });
  assert.equal(envelope.conclusions[1].tier, 'notable');
  assert.equal(envelope.conclusions[1].evidence.length, 2);
  assert.equal(envelope.conclusions[2].tier, 'routine');
  assert.equal(Object.hasOwn(envelope.conclusions[2], 'evidence'), false);
  assert.equal(envelope.summary.smartWalletOverlap, 0);
});

test('computeOverlapQuality is bounded and rewards tier plus winrate quality', () => {
  const wallets = [
    { tier: 'A', gmgn: { wr: 0.8 } },
    { tier: 'B', gmgn: { wr: 0.7 } },
    { tier: 'C', gmgn: { wr: 0.8 } },
    { tier: 'universe' },
  ];
  assert.equal(computeOverlapQuality([]), 0);
  assert.equal(computeOverlapQuality(wallets), 66);
  assert.equal(computeOverlapQuality(Array.from({ length: 10 }, () => ({ tier: 'A', gmgn: { wr: 0.9 } }))), 100);
});

test('enforcePayloadBudget is idempotent when payload already fits', () => {
  const payload = { task: 'x', candidates: [{ candidate_id: 1, holderIntelligence: { conclusions: [] } }] };
  const result = enforcePayloadBudget(payload, 10_000);
  assert.deepEqual(result.payload, payload);
  assert.deepEqual(result.trimStages, []);
  assert.equal(result.candidatesRemoved, 0);
  assert.equal(result.skipped, false);
});

test('enforcePayloadBudget trims in order and preserves critical candidates', () => {
  const criticalCandidate = {
    candidate_id: 1,
    chart: { windows: [{ candles: Array.from({ length: 100 }, (_, i) => i) }] },
    holderIntelligence: {
      summary: { smartWalletOverlap: 0, overlapQualityScore: 0 },
      conclusions: [
        { signal: 'critical', tier: 'critical', severity: 'critical', explanation: 'x'.repeat(100), evidence: ['1111...aaa'], metrics: { clusterSize: 3 } },
      ],
    },
  };
  const removableCandidate = {
    candidate_id: 2,
    chart: { windows: [{ candles: Array.from({ length: 100 }, (_, i) => i) }] },
    holderIntelligence: {
      summary: { smartWalletOverlap: 0, overlapQualityScore: 0 },
      conclusions: [
        { signal: 'routine', tier: 'routine', severity: 'low', explanation: 'y'.repeat(200) },
        { signal: 'notable', tier: 'notable', severity: 'medium', explanation: 'z'.repeat(200), evidence: ['2222...bbb'] },
      ],
    },
  };

  const result = enforcePayloadBudget({ candidates: [criticalCandidate, removableCandidate] }, 450);
  assert.deepEqual(result.trimStages, ['a', 'b', 'c', 'd']);
  assert.deepEqual(result.payload.candidates.map(candidate => candidate.candidate_id), [1]);
  assert.equal(result.payload.candidates[0].holderIntelligence.conclusions[0].evidence[0], '1111...aaa');
});
