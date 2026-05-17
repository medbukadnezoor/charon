process.env.CHARON_SKIP_DOTENV = 'true';
process.env.SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://general.shadow/rpc';
process.env.SOLANA_WS_URL = process.env.SOLANA_WS_URL || 'wss://general.shadow/ws';
process.env.PUMP_HELIUS_RPC_URL = process.env.PUMP_HELIUS_RPC_URL || 'https://pump.shadow/rpc';
process.env.PUMP_HELIUS_WS_URL = process.env.PUMP_HELIUS_WS_URL || 'wss://pump.shadow/ws';

const {
  createRpcRouter,
  publicRpcOutcome,
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

function providerError(status, code = null, headers = {}) {
  const error = new Error(status ? `HTTP ${status}` : (code || 'network'));
  if (status) error.response = { status, headers };
  if (code) error.code = code;
  return error;
}

async function runCase(name, context, expected, transport, options = {}) {
  const router = createRpcRouter({
    endpoints: options.endpoints || endpoints,
    now: () => 1_000_000,
    random: () => 0.5,
    failuresToOpen: options.failuresToOpen || 3,
    circuitMs: 30_000,
  });
  const calls = [];
  const outcome = await router.requestJsonRpc(context, { method: 'shadow' }, {
    transport: async (args) => {
      calls.push(args.endpoint);
      return transport(args);
    },
  });
  const publicOutcome = publicRpcOutcome(outcome);
  const pass = Object.entries(expected).every(([key, value]) => publicOutcome[key] === value);
  return {
    name,
    pass,
    calls: calls.join('>'),
    outcome: publicOutcome,
  };
}

async function runCircuitCase() {
  const router = createRpcRouter({
    endpoints,
    now: () => 1_000_000,
    random: () => 0.5,
    failuresToOpen: 2,
    circuitMs: 15_000,
  });
  await router.requestJsonRpc('holder_history', { method: 'shadow' }, {
    transport: async () => {
      throw providerError(429);
    },
  });
  const outcome = await router.requestJsonRpc('holder_history', { method: 'shadow' }, {
    transport: async () => {
      throw providerError(429);
    },
  });
  const publicOutcome = publicRpcOutcome(outcome);
  return {
    name: 'repeated failures open circuit breaker',
    pass: publicOutcome.circuitOpen === true
      && publicOutcome.action === 'no_fallback_allowed'
      && publicOutcome.endpoint === 'general',
    calls: 'general>general',
    outcome: publicOutcome,
  };
}

function formatOutcome(row) {
  const out = row.outcome;
  return `${row.pass ? 'PASS' : 'FAIL'} ${row.name} context=${out.context || 'n/a'} endpoint=${out.endpoint || 'n/a'} action=${out.action || 'n/a'} fallbackAllowed=${out.fallbackAllowed} fallbackUsed=${out.fallbackUsed} reason=${out.reason || 'none'} backoffMs=${out.backoffMs} circuitOpen=${out.circuitOpen}`;
}

const missingFallbackEndpoints = {
  general: endpoints.general,
  pump_fallback: { rpc: null, ws: null },
};

const rows = [
  await runCase('pump_logs 429 falls back to pump_fallback', 'pump_logs', {
    ok: true,
    endpoint: 'pump_fallback',
    action: 'fallback_success',
    fallbackAllowed: true,
    fallbackUsed: true,
  }, async ({ endpoint }) => {
    if (endpoint === 'general') throw providerError(429);
    return { result: 'ok' };
  }),
  await runCase('pump_transaction_lookup 503 falls back to pump_fallback', 'pump_transaction_lookup', {
    ok: true,
    endpoint: 'pump_fallback',
    action: 'fallback_success',
    fallbackAllowed: true,
    fallbackUsed: true,
  }, async ({ endpoint }) => {
    if (endpoint === 'general') throw providerError(503);
    return { result: 'ok' };
  }),
  await runCase('holder_history does not use pump fallback on 429', 'holder_history', {
    ok: false,
    endpoint: 'general',
    action: 'no_fallback_allowed',
    fallbackAllowed: false,
    fallbackUsed: false,
  }, async () => {
    throw providerError(429, null, { 'retry-after': '3' });
  }),
  await runCase('wallet_balance does not use pump fallback on timeout', 'wallet_balance', {
    ok: false,
    endpoint: 'general',
    action: 'no_fallback_allowed',
    fallbackAllowed: false,
    fallbackUsed: false,
  }, async () => {
    throw providerError(null, 'ETIMEDOUT');
  }),
  await runCase('execution_rpc does not use pump fallback on 503', 'execution_rpc', {
    ok: false,
    endpoint: 'general',
    action: 'no_fallback_allowed',
    fallbackAllowed: false,
    fallbackUsed: false,
  }, async () => {
    throw providerError(503);
  }),
  await runCase('missing fallback endpoint reports fallback unavailable', 'pump_logs', {
    ok: false,
    endpoint: 'general',
    action: 'fallback_unavailable',
    fallbackAllowed: true,
    fallbackUsed: false,
  }, async () => {
    throw providerError(429);
  }, { endpoints: missingFallbackEndpoints }),
  await runCircuitCase(),
];

const redactionText = JSON.stringify(rows.map(row => row.outcome));
rows.push({
  name: 'endpoint labels redact raw URLs and API keys',
  pass: !/api-key=|GENERAL_SECRET|PUMP_SECRET|https:\/\/|wss:\/\//i.test(redactionText),
  calls: 'n/a',
  outcome: {
    ok: true,
    context: null,
    endpoint: null,
    action: 'redaction_check',
    fallbackAllowed: false,
    fallbackUsed: false,
    reason: null,
    backoffMs: 0,
    circuitOpen: false,
  },
});

const failed = rows.filter(row => !row.pass);
console.log('Charon RPC routing shadow report');
console.log(`Overall: ${failed.length ? 'FAIL' : 'PASS'}`);
console.log('');
for (const row of rows) {
  console.log(formatOutcome(row));
}

if (failed.length) {
  console.error('');
  console.error(JSON.stringify(failed.map(row => ({ name: row.name, calls: row.calls, outcome: row.outcome })), null, 2));
  process.exitCode = 1;
}
