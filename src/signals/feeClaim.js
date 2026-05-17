import WebSocket from 'ws';
import { PUMP_PROGRAM, PUMP_AMM, DISC_DIST_FEES } from '../config.js';
import { now, pruneSeen, lamToSol, discMatch, parseDistFees } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { storeSignalEvent } from './trending.js';
import { graduated } from './graduated.js';
import { trending } from './trending.js';
import { buildFeeSnapshot } from '../pipeline/candidateBuilder.js';
import { classifyRpcFailure, wsEndpointCandidatesForContext } from '../rpc/router.js';

export const seenFeeClaims = new Map();
let candidateHandler = null;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export async function handleFeeClaim(fee, signature) {
  const sol = lamToSol(fee.distributed);
  if (sol < numSetting('min_fee_claim_sol', 2)) return;
  const graduatedCoin = graduated.get(fee.mint) || null;
  const trendingToken = boolSetting('trending_enabled', true) ? trending.get(fee.mint) || null : null;
  if (!graduatedCoin && !trendingToken) return;

  const key = `${signature}:${fee.mint}:${fee.distributed}`;
  pruneSeen(seenFeeClaims, 10 * 60 * 1000);
  if (seenFeeClaims.has(key)) return;
  seenFeeClaims.set(key, now());
  storeSignalEvent(fee.mint, 'fee_claim', 'pump_logs', { signature, fee: buildFeeSnapshot(fee, signature) });
  const route = graduatedCoin && trendingToken
    ? 'fee_graduated_trending'
    : graduatedCoin
      ? 'fee_graduated'
      : 'fee_trending';
  if (candidateHandler) {
    await candidateHandler({
      mint: fee.mint,
      fee,
      signature,
      graduatedCoin,
      trendingToken,
      route,
    });
  }
}

async function processLog(logInfo) {
  const { signature, logs, err } = logInfo;
  if (err || !logs) return;
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let data;
    try {
      data = Buffer.from(line.slice('Program data: '.length), 'base64');
    } catch {
      continue;
    }
    if (data.length < 8 || !discMatch(data, DISC_DIST_FEES)) continue;
    try {
      await handleFeeClaim(parseDistFees(data), signature);
    } catch (error) {
      console.log(`[fee] parse/alert failed: ${error.message}`);
    }
  }
}

export function startWebsocket() {
  const endpoints = wsEndpointCandidatesForContext('pump_logs');
  let ws;
  let pingTimer;
  let endpointIndex = 0;
  let lastError = null;

  function connect() {
    const endpoint = endpoints[endpointIndex] || endpoints[0];
    if (!endpoint?.url) {
      console.log(`[ws] RPC endpoint unavailable endpoint=${endpoint?.label || 'general'} context=pump_logs`);
      return;
    }
    ws = new WebSocket(endpoint.url);
    ws.on('open', () => {
      lastError = null;
      console.log(`[ws] connected endpoint=${endpoint.label}`);
      for (const [id, program] of [[1, PUMP_PROGRAM], [2, PUMP_AMM]]) {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'logsSubscribe',
          params: [{ mentions: [program] }, { commitment: 'confirmed' }],
        }));
      }
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, 30_000);
    });
    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const value = msg.params?.result?.value;
      if (msg.method === 'logsNotification' && value) {
        processLog(value).catch(error => console.log(`[ws] process failed: ${error.message}`));
      }
    });
    ws.on('close', () => {
      clearInterval(pingTimer);
      const failure = lastError ? classifyRpcFailure(lastError) : null;
      const canFallback = endpoint.label === 'general' && endpoints[1] && failure?.retryable;
      if (canFallback) endpointIndex = 1;
      else endpointIndex = 0;
      console.log(`[ws] closed endpoint=${endpoint.label}, reconnecting in 5s${canFallback ? ' via pump_fallback' : ''}`);
      setTimeout(connect, 5000);
    });
    ws.on('error', error => {
      lastError = error;
      console.log(`[ws] endpoint=${endpoint.label} ${error.message}`);
    });
  }
  connect();
}
