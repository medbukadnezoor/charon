import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.SOLANA_RPC_URL = 'https://general.example/rpc';
process.env.SOLANA_WS_URL = 'wss://general.example/ws';
process.env.PUMP_HELIUS_RPC_URL = 'https://pump.example/rpc';
process.env.PUMP_HELIUS_WS_URL = 'wss://pump.example/ws';

const {
  classifyRpcFailure,
  createRpcRouter,
  endpointForContext,
  publicRpcOutcome,
  pumpFallbackAllowed,
} = await import('../src/rpc/router.js');

const endpoints = {
  general: {
    rpc: process.env.SOLANA_RPC_URL,
    ws: process.env.SOLANA_WS_URL,
  },
  pump_fallback: {
    rpc: process.env.PUMP_HELIUS_RPC_URL,
    ws: process.env.PUMP_HELIUS_WS_URL,
  },
};

test('context allowlist limits pump fallback to Pump contexts', () => {
  assert.equal(pumpFallbackAllowed('pump_logs'), true);
  assert.equal(pumpFallbackAllowed('pump_transaction_lookup'), true);
  assert.equal(pumpFallbackAllowed('holder_history'), false);
  assert.equal(pumpFallbackAllowed('wallet_balance'), false);
  assert.equal(pumpFallbackAllowed('execution_rpc'), false);
});

test('pump context falls back to pump endpoint after 429', async () => {
  const router = createRpcRouter({ endpoints, random: () => 0.5 });
  const calls = [];
  const outcome = await router.requestJsonRpc('pump_transaction_lookup', { method: 'getTransaction' }, {
    transport: async ({ endpoint }) => {
      calls.push(endpoint);
      if (endpoint === 'general') {
        const error = new Error('rate limited');
        error.response = { status: 429, headers: { 'retry-after': '2' } };
        throw error;
      }
      return { result: 'fallback-ok' };
    },
  });

  assert.deepEqual(calls, ['general', 'pump_fallback']);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.endpoint, 'pump_fallback');
  assert.equal(outcome.action, 'fallback_success');
  assert.equal(outcome.fallbackUsed, true);
  assert.equal(outcome.attempts[0].circuit.backoffMs, 2000);
});

test('holder, wallet, and execution contexts do not use pump fallback', async () => {
  for (const context of ['holder_history', 'wallet_balance', 'execution_rpc']) {
    const router = createRpcRouter({ endpoints, random: () => 0.5 });
    const calls = [];
    const outcome = await router.requestJsonRpc(context, { method: 'getBalance' }, {
      transport: async ({ endpoint }) => {
        calls.push(endpoint);
        const error = new Error('HTTP 503');
        error.response = { status: 503, headers: {} };
        throw error;
      },
    });

    assert.deepEqual(calls, ['general']);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.action, 'no_fallback_allowed');
    assert.equal(outcome.fallbackAllowed, false);
    assert.equal(outcome.fallbackUsed, false);
  }
});

test('missing pump endpoint reports fallback unavailable without raw URL leakage', async () => {
  const router = createRpcRouter({
    endpoints: {
      general: endpoints.general,
      pump_fallback: { rpc: null, ws: null },
    },
    random: () => 0.5,
  });
  const outcome = await router.requestJsonRpc('pump_transaction_lookup', { method: 'getTransaction' }, {
    transport: async () => {
      const error = new Error('network down');
      error.code = 'ECONNRESET';
      throw error;
    },
  });
  const publicOutcome = publicRpcOutcome(outcome);
  const rendered = JSON.stringify(publicOutcome);

  assert.equal(publicOutcome.action, 'fallback_unavailable');
  assert.equal(publicOutcome.fallbackAllowed, true);
  assert.equal(publicOutcome.fallbackUnavailable, true);
  assert.equal(rendered.includes('https://'), false);
});

test('repeated failures open a short circuit with bounded backoff', async () => {
  let now = 1_000;
  const router = createRpcRouter({
    endpoints,
    now: () => now,
    random: () => 0.5,
    baseBackoffMs: 100,
    maxBackoffMs: 250,
    circuitMs: 1_500,
    failuresToOpen: 2,
  });
  const fail = async () => {
    const error = new Error('timeout');
    error.code = 'ETIMEDOUT';
    throw error;
  };

  await router.requestJsonRpc('holder_history', { method: 'getSignaturesForAddress' }, { transport: fail });
  const second = await router.requestJsonRpc('holder_history', { method: 'getSignaturesForAddress' }, { transport: fail });
  assert.equal(second.circuit.circuitOpen, true);
  assert.equal(second.circuit.backoffMs, 200);

  const third = await router.requestJsonRpc('holder_history', { method: 'getSignaturesForAddress' }, {
    transport: async () => {
      throw new Error('should not call transport while circuit is open');
    },
  });
  assert.equal(third.attempts[0].reason, 'circuit_open');

  now = 3_000;
  const recovered = await router.requestJsonRpc('holder_history', { method: 'getSignaturesForAddress' }, {
    transport: async () => ({ result: [] }),
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.circuit.circuitOpen, false);
});

test('endpoint reports use labels and never expose URL material', () => {
  const endpoint = endpointForContext('pump_logs', 'rpc', { endpoints, label: 'pump_fallback' });
  const rendered = JSON.stringify(publicRpcOutcome({
    ok: true,
    context: endpoint.context,
    endpoint: endpoint.label,
    action: 'success',
    fallbackAllowed: endpoint.fallbackAllowed,
    fallbackUsed: true,
    circuit: { backoffMs: 0, circuitOpen: false },
  }));

  assert.equal(rendered.includes('pump_fallback'), true);
  assert.equal(rendered.includes('pump.example'), false);
});

test('failure classifier treats 429, 503, timeout, and network as retryable', () => {
  assert.deepEqual(classifyRpcFailure({ response: { status: 429 } }), {
    reason: 'rate_limited',
    status: 429,
    retryable: true,
  });
  assert.equal(classifyRpcFailure({ response: { status: 503 } }).reason, 'provider_unavailable');
  assert.equal(classifyRpcFailure({ code: 'ETIMEDOUT' }).reason, 'timeout');
  assert.equal(classifyRpcFailure({ code: 'ECONNRESET' }).reason, 'network_error');
  assert.equal(classifyRpcFailure({ response: { status: 400 } }).retryable, false);
});
