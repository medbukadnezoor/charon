import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.MIMO_API_KEY = 'mimo-key';
process.env.LLM_PROVIDER_ORDER = 'mimo,cliproxy';
const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-llm-usage-'));
process.env.DB_PATH = path.join(tempDir, 'charon-usage-smoke.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const { setSetting, setting } = await import('../src/db/settings.js');
const {
  estimateTokensFromBytes,
  logUsageEvent,
  normalizeUsageTokens,
} = await import('../src/db/usage.js');

function llmCandidate(mint = 'UsageMint11111111111111111111111111111111') {
  return {
    token: { mint, symbol: 'USE', name: 'Usage' },
    signals: { route: 'graduated_trending', sourceCount: 2, sources: ['graduated', 'trending'] },
    metrics: { marketCapUsd: 50000, liquidityUsd: 20000 },
    holders: { holders: [], count: 0 },
    savedWalletExposure: { holderCount: 1, checked: 1, evidence: { wallets: [] } },
    filters: { passed: true },
    chart: { windows: [] },
    dataQuality: 'full',
  };
}

after(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('initDb creates llm usage schema and default cost settings', () => {
  initDb();

  const columns = db.prepare('PRAGMA table_info(llm_usage_events)').all().map(row => row.name);
  assert.deepEqual(
    [
      'status',
      'request_bytes',
      'latency_ms',
      'prompt_tokens',
      'completion_tokens',
      'total_tokens',
      'token_estimate_method',
      'estimated_cost_usd',
      'error_class',
    ].every(column => columns.includes(column)),
    true,
  );
  assert.equal(setting('llm_cost_tracking_enabled'), 'false');
  assert.equal(setting('llm_input_cost_per_1m_tokens'), '0');
  assert.equal(setting('llm_output_cost_per_1m_tokens'), '0');
});

test('logUsageEvent persists provider usage tokens and opt-in cost', () => {
  initDb();
  setSetting('llm_cost_tracking_enabled', 'true');
  setSetting('llm_input_cost_per_1m_tokens', '2');
  setSetting('llm_output_cost_per_1m_tokens', '6');

  const id = logUsageEvent({
    status: 'success',
    provider: 'test-provider',
    model: 'test-model',
    triggerCandidateId: 42,
    candidateCount: 3,
    requestBytes: 1200,
    responseBytes: 300,
    latencyMs: 250,
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 200,
      total_tokens: 1200,
    },
  });
  const row = db.prepare('SELECT * FROM llm_usage_events WHERE id = ?').get(id);

  assert.equal(row.status, 'success');
  assert.equal(row.prompt_tokens, 1000);
  assert.equal(row.completion_tokens, 200);
  assert.equal(row.total_tokens, 1200);
  assert.equal(row.token_estimate_method, 'provider_usage');
  assert.equal(row.estimated_cost_usd, 0.0032);
});

test('missing provider usage falls back to rough bytes divided by four estimate', () => {
  initDb();
  setSetting('llm_cost_tracking_enabled', 'false');

  assert.equal(estimateTokensFromBytes(17), 5);
  assert.deepEqual(normalizeUsageTokens({ requestBytes: 17, responseBytes: 5 }), {
    promptTokens: 5,
    completionTokens: 2,
    totalTokens: 7,
    tokenEstimateMethod: 'estimated_bytes_div_4',
  });

  const id = logUsageEvent({
    status: 'error',
    provider: 'test-provider',
    model: 'test-model',
    requestBytes: 17,
    responseBytes: 5,
    latencyMs: 100,
    errorClass: 'parse_error',
  });
  const row = db.prepare('SELECT * FROM llm_usage_events WHERE id = ?').get(id);

  assert.equal(row.status, 'error');
  assert.equal(row.prompt_tokens, 5);
  assert.equal(row.completion_tokens, 2);
  assert.equal(row.total_tokens, 7);
  assert.equal(row.token_estimate_method, 'estimated_bytes_div_4');
  assert.equal(row.estimated_cost_usd, null);
});

test('empty provider content records semantic failure before successful fallback', async () => {
  initDb();
  db.prepare('DELETE FROM llm_usage_events').run();
  setSetting('llm_intelligence_enabled', 'false');
  const axios = (await import('axios')).default;
  const originalPost = axios.post;
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    if (calls === 1) {
      return { data: { choices: [{ message: { content: '' } }] } };
    }
    return { data: { choices: [{ message: { content: '{"verdict":"PASS","confidence":8}' } }] } };
  };

  try {
    const { decideCandidateBatch } = await import('../src/pipeline/llm.js');
    const decision = await decideCandidateBatch([{ id: 880, candidate: llmCandidate() }], 880);
    const rows = db.prepare(`
      SELECT status, provider, model, response_bytes, error_class
      FROM llm_usage_events
      ORDER BY id
    `).all();

    assert.equal(decision.verdict, 'PASS');
    assert.equal(calls, 2);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(row => [row.status, row.error_class, row.response_bytes]), [
      ['error', 'empty_content', 0],
      ['success', null, 33],
    ]);
    assert.equal(rows[0].provider, 'xiaomi-mimo');
    assert.equal(rows[1].provider, 'cliproxy-api');
  } finally {
    axios.post = originalPost;
  }
});

test('malformed provider content records parse failure with byte count before fallback', async () => {
  initDb();
  db.prepare('DELETE FROM llm_usage_events').run();
  setSetting('llm_intelligence_enabled', 'false');
  const axios = (await import('axios')).default;
  const originalPost = axios.post;
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    if (calls === 1) {
      return { data: { choices: [{ message: { content: '{bad json' } }] } };
    }
    return { data: { choices: [{ message: { content: '{"verdict":"WATCH","confidence":5}' } }] } };
  };

  try {
    const { decideCandidateBatch } = await import('../src/pipeline/llm.js');
    const decision = await decideCandidateBatch([{ id: 881, candidate: llmCandidate('UsageMint22222222222222222222222222222222') }], 881);
    const rows = db.prepare(`
      SELECT status, provider, response_bytes, error_class
      FROM llm_usage_events
      ORDER BY id
    `).all();

    assert.equal(decision.verdict, 'WATCH');
    assert.equal(calls, 2);
    assert.deepEqual(rows.map(row => [row.status, row.error_class, row.response_bytes]), [
      ['error', 'parse_error', 9],
      ['success', null, 34],
    ]);
    assert.equal(rows[0].provider, 'xiaomi-mimo');
    assert.equal(rows[1].provider, 'cliproxy-api');
  } finally {
    axios.post = originalPost;
  }
});
