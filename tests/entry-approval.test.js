import assert from 'node:assert/strict';
import test from 'node:test';

import { effectiveLlmMinConfidence, shouldApproveEntry } from '../src/pipeline/entryApproval.js';

test('entry approval uses active strategy confidence threshold before global fallback', () => {
  const selectedRow = { id: 1 };
  const decision = { verdict: 'BUY', confidence: 50 };
  const confidenceThreshold = effectiveLlmMinConfidence({ llm_min_confidence: 50 }, 75);

  assert.equal(confidenceThreshold, 50);
  assert.equal(shouldApproveEntry({
    selectedRow,
    agentEnabled: true,
    decision,
    confidenceThreshold,
  }), true);
});

test('entry approval falls back to global confidence only when strategy value is absent', () => {
  assert.equal(effectiveLlmMinConfidence({}, 75), 75);
  assert.equal(effectiveLlmMinConfidence({ llm_min_confidence: null }, 75), 75);
  assert.equal(effectiveLlmMinConfidence({ llm_min_confidence: '' }, 75), 75);
  assert.equal(effectiveLlmMinConfidence({ llm_min_confidence: 0 }, 75), 0);
});

test('entry approval rejects below the effective threshold', () => {
  assert.equal(shouldApproveEntry({
    selectedRow: { id: 1 },
    agentEnabled: true,
    decision: { verdict: 'BUY', confidence: 50 },
    confidenceThreshold: 75,
  }), false);

  assert.equal(shouldApproveEntry({
    selectedRow: { id: 1 },
    agentEnabled: false,
    decision: { verdict: 'BUY', confidence: 100 },
    confidenceThreshold: 75,
  }), false);
});
