import axios from 'axios';

import {
  PUMP_HELIUS_RPC_URL,
  PUMP_HELIUS_WS_URL,
  SOLANA_RPC_URL,
  SOLANA_WS_URL,
} from '../config.js';

export const RPC_ENDPOINT_LABELS = Object.freeze({
  general: 'general',
  pump_fallback: 'pump_fallback',
});

export const RPC_CONTEXTS = Object.freeze({
  pump_logs: { pumpFallbackAllowed: true },
  pump_transaction_lookup: { pumpFallbackAllowed: true },
  holder_history: { pumpFallbackAllowed: false },
  wallet_balance: { pumpFallbackAllowed: false },
  execution_rpc: { pumpFallbackAllowed: false },
});

const RETRYABLE_STATUSES = new Set([429, 503]);
const RETRYABLE_NETWORK_CODES = new Set([
  'aborterror',
  'econnaborted',
  'econnreset',
  'enetdown',
  'enetunreach',
  'eai_again',
  'etimedout',
  'timeout',
]);
const DEFAULT_BASE_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DEFAULT_CIRCUIT_MS = 30_000;
const DEFAULT_FAILURES_TO_OPEN = 3;
const DEFAULT_RPC_TIMEOUT_MS = 10_000;

function asText(value) {
  if (value == null || value === '') return null;
  return String(value);
}

function contextConfig(context) {
  return RPC_CONTEXTS[context] || { pumpFallbackAllowed: false };
}

export function pumpFallbackAllowed(context) {
  return contextConfig(context).pumpFallbackAllowed === true;
}

export function defaultRpcEndpoints() {
  return {
    general: {
      rpc: SOLANA_RPC_URL,
      ws: SOLANA_WS_URL,
    },
    pump_fallback: {
      rpc: PUMP_HELIUS_RPC_URL || null,
      ws: PUMP_HELIUS_WS_URL || null,
    },
  };
}

export function endpointForContext(context, kind = 'rpc', {
  endpoints = defaultRpcEndpoints(),
  label = RPC_ENDPOINT_LABELS.general,
} = {}) {
  const selected = endpoints[label]?.[kind] || null;
  return {
    context,
    kind,
    label,
    url: selected,
    fallbackAllowed: pumpFallbackAllowed(context),
  };
}

export function redactedEndpoint(endpoint) {
  return {
    context: asText(endpoint?.context),
    kind: asText(endpoint?.kind),
    endpoint: asText(endpoint?.label),
    configured: Boolean(endpoint?.url),
    fallbackAllowed: Boolean(endpoint?.fallbackAllowed),
  };
}

function retryAfterMs(headers = {}) {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw == null) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function classifyRpcFailure(error) {
  const status = Number(error?.response?.status || error?.status || 0);
  const code = String(error?.code || error?.name || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if (status === 429 || message.includes('429')) return { reason: 'rate_limited', status: status || 429, retryable: true };
  if (status === 503 || message.includes('503')) return { reason: 'provider_unavailable', status: status || 503, retryable: true };
  if (code === 'aborterror' || code === 'econnaborted' || code === 'etimedout' || message.includes('timeout')) {
    return { reason: 'timeout', status: status || null, retryable: true };
  }
  if (!status && (RETRYABLE_NETWORK_CODES.has(code) || message.includes('network'))) {
    return { reason: 'network_error', status: null, retryable: true };
  }
  return {
    reason: status ? `http_${status}` : 'network_error',
    status: status || null,
    retryable: RETRYABLE_STATUSES.has(status) || !status,
  };
}

function boundedBackoffMs({ failure, failures, baseBackoffMs, maxBackoffMs, random }) {
  const retryHeaderMs = retryAfterMs(failure?.headers || failure?.response?.headers || {});
  if (retryHeaderMs != null) return Math.min(maxBackoffMs, retryHeaderMs);
  const exponent = Math.min(5, Math.max(0, failures - 1));
  const jitter = 0.75 + random() * 0.5;
  return Math.min(maxBackoffMs, Math.round(baseBackoffMs * (2 ** exponent) * jitter));
}

export function createRpcRouter({
  endpoints = defaultRpcEndpoints(),
  now = () => Date.now(),
  random = Math.random,
  baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  circuitMs = DEFAULT_CIRCUIT_MS,
  failuresToOpen = DEFAULT_FAILURES_TO_OPEN,
} = {}) {
  const state = new Map();

  function key(context, label) {
    return `${context}:${label}`;
  }

  function endpoint(context, kind, label = RPC_ENDPOINT_LABELS.general) {
    return endpointForContext(context, kind, { endpoints, label });
  }

  function stateFor(context, label) {
    const id = key(context, label);
    if (!state.has(id)) state.set(id, { failures: 0, circuitOpenUntil: 0, lastBackoffMs: 0 });
    return state.get(id);
  }

  function circuitState(context, label) {
    const current = stateFor(context, label);
    const remainingMs = Math.max(0, current.circuitOpenUntil - now());
    return {
      failures: current.failures,
      backoffMs: current.lastBackoffMs,
      circuitOpen: remainingMs > 0,
      circuitOpenUntil: current.circuitOpenUntil || null,
      circuitRemainingMs: remainingMs,
    };
  }

  function recordSuccess(context, label) {
    state.set(key(context, label), { failures: 0, circuitOpenUntil: 0, lastBackoffMs: 0 });
  }

  function recordFailure(context, label, error) {
    const current = stateFor(context, label);
    const nextFailures = current.failures + 1;
    const backoffMs = boundedBackoffMs({
      failure: error,
      failures: nextFailures,
      baseBackoffMs,
      maxBackoffMs,
      random,
    });
    const circuitOpenUntil = nextFailures >= failuresToOpen ? now() + circuitMs : current.circuitOpenUntil;
    const next = { failures: nextFailures, circuitOpenUntil, lastBackoffMs: backoffMs };
    state.set(key(context, label), next);
    return {
      failures: next.failures,
      backoffMs: next.lastBackoffMs,
      circuitOpen: circuitOpenUntil > now(),
      circuitOpenUntil: circuitOpenUntil || null,
      circuitRemainingMs: Math.max(0, circuitOpenUntil - now()),
    };
  }

  function unavailable(context, kind, label, action) {
    return {
      ok: false,
      context,
      kind,
      endpoint: label,
      action,
      fallbackAllowed: pumpFallbackAllowed(context),
      fallbackUsed: false,
      fallbackUnavailable: label === RPC_ENDPOINT_LABELS.pump_fallback,
      reason: 'endpoint_unconfigured',
      circuit: circuitState(context, label),
    };
  }

  async function attempt({ context, kind, label, payload, transport }) {
    const selected = endpoint(context, kind, label);
    if (!selected.url) return unavailable(context, kind, label, `${label}_unavailable`);
    const circuit = circuitState(context, label);
    if (circuit.circuitOpen) {
      return {
        ok: false,
        context,
        kind,
        endpoint: label,
        action: 'circuit_open',
        fallbackAllowed: selected.fallbackAllowed,
        fallbackUsed: false,
        reason: 'circuit_open',
        circuit,
      };
    }
    try {
      const result = await transport({ url: selected.url, endpoint: label, payload, context, kind });
      recordSuccess(context, label);
      return {
        ok: true,
        context,
        kind,
        endpoint: label,
        action: 'success',
        fallbackAllowed: selected.fallbackAllowed,
        fallbackUsed: label === RPC_ENDPOINT_LABELS.pump_fallback,
        result,
        circuit: circuitState(context, label),
      };
    } catch (error) {
      const failure = classifyRpcFailure(error);
      const nextCircuit = recordFailure(context, label, error);
      return {
        ok: false,
        context,
        kind,
        endpoint: label,
        action: failure.retryable ? 'retryable_failure' : 'failure',
        fallbackAllowed: selected.fallbackAllowed,
        fallbackUsed: false,
        reason: failure.reason,
        status: failure.status,
        retryable: failure.retryable,
        circuit: nextCircuit,
      };
    }
  }

  async function requestJsonRpc(context, payload, { transport } = {}) {
    if (typeof transport !== 'function') throw new Error('requestJsonRpc requires a transport function');
    const primary = await attempt({ context, kind: 'rpc', label: RPC_ENDPOINT_LABELS.general, payload, transport });
    if (primary.ok) return { ...primary, attempts: [primary] };
    if (!primary.retryable && primary.reason !== 'circuit_open') return { ...primary, attempts: [primary] };
    if (!pumpFallbackAllowed(context)) {
      return {
        ...primary,
        action: 'no_fallback_allowed',
        attempts: [primary],
      };
    }
    const fallbackEndpoint = endpoint(context, 'rpc', RPC_ENDPOINT_LABELS.pump_fallback);
    if (!fallbackEndpoint.url) {
      return {
        ...primary,
        action: 'fallback_unavailable',
        fallbackUnavailable: true,
        attempts: [primary],
      };
    }
    const fallback = await attempt({
      context,
      kind: 'rpc',
      label: RPC_ENDPOINT_LABELS.pump_fallback,
      payload,
      transport,
    });
    return {
      ...fallback,
      fallbackUsed: fallback.ok,
      action: fallback.ok ? 'fallback_success' : fallback.action,
      attempts: [primary, fallback],
    };
  }

  return {
    endpoint,
    circuitState,
    recordFailure,
    recordSuccess,
    requestJsonRpc,
  };
}

export const rpcRouter = createRpcRouter();

export function rpcEndpointForContext(context) {
  return rpcRouter.endpoint(context, 'rpc', RPC_ENDPOINT_LABELS.general).url;
}

export function wsEndpointForContext(context) {
  return rpcRouter.endpoint(context, 'ws', RPC_ENDPOINT_LABELS.general).url;
}

export function wsEndpointCandidatesForContext(context) {
  const general = rpcRouter.endpoint(context, 'ws', RPC_ENDPOINT_LABELS.general);
  const candidates = [general];
  if (pumpFallbackAllowed(context)) {
    const fallback = rpcRouter.endpoint(context, 'ws', RPC_ENDPOINT_LABELS.pump_fallback);
    if (fallback.url) candidates.push(fallback);
  }
  return candidates;
}

export async function axiosJsonRpcTransport({ url, payload, timeoutMs = DEFAULT_RPC_TIMEOUT_MS, signal }) {
  const response = await axios.post(url, payload, {
    timeout: timeoutMs,
    signal,
    headers: { 'content-type': 'application/json' },
  });
  return response.data;
}

export async function requestSolanaRpc(context, payload, {
  transport,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  signal,
} = {}) {
  const rpcTransport = transport || ((args) => axiosJsonRpcTransport({ ...args, timeoutMs, signal }));
  return rpcRouter.requestJsonRpc(context, payload, { transport: rpcTransport });
}

export function publicRpcOutcome(outcome) {
  const clean = {
    ok: Boolean(outcome?.ok),
    context: asText(outcome?.context),
    endpoint: asText(outcome?.endpoint),
    action: asText(outcome?.action),
    fallbackAllowed: Boolean(outcome?.fallbackAllowed),
    fallbackUsed: Boolean(outcome?.fallbackUsed),
    fallbackUnavailable: Boolean(outcome?.fallbackUnavailable),
    reason: asText(outcome?.reason),
    status: outcome?.status ?? null,
    backoffMs: outcome?.circuit?.backoffMs ?? 0,
    circuitOpen: Boolean(outcome?.circuit?.circuitOpen),
  };
  if (Array.isArray(outcome?.attempts)) {
    clean.attempts = outcome.attempts.map(attempt => ({
      endpoint: asText(attempt.endpoint),
      action: asText(attempt.action),
      reason: asText(attempt.reason),
      status: attempt.status ?? null,
      backoffMs: attempt.circuit?.backoffMs ?? 0,
      circuitOpen: Boolean(attempt.circuit?.circuitOpen),
    }));
  }
  return clean;
}
