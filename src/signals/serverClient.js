import axios from 'axios';
import { SIGNAL_SERVER_URL, SIGNAL_SERVER_KEY, SIGNAL_POLL_MS } from '../config.js';
import { now } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { logScreeningEvent } from '../db/screeningEvents.js';
import { storeSignalEvent, trendingSignalPass, trending } from './trending.js';
import { graduated } from './graduated.js';
import { normalizeTrendingRiskFields } from '../enrichment/trendingRisk.js';

let candidateHandler = null;
let degenHandler = null;

export function setCandidateHandler(fn) { candidateHandler = fn; }
export function setDegenHandler(fn) { degenHandler = fn; }

const seenSignals = new Map();

function prune(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) {
    if (at - ts > ttlMs) map.delete(key);
  }
}

function signalKey(signal) {
  const sources = (signal.sources || []).sort().join('+');
  return `${signal.mint}:${sources}`;
}

async function triggerCandidate({ mint, fee, signature, graduatedCoin, trendingToken, route, signalMeta }) {
  if (!candidateHandler) return;
  await candidateHandler({ mint, fee, signature, graduatedCoin, trendingToken, route, signalMeta });
}

function sourceLabels(signal) {
  return Array.isArray(signal?.sources) ? signal.sources.map(source => String(source)) : [];
}

function routeForSignal({ hasFee, graduatedCoin, trendingToken, sourceCount }) {
  if (hasFee && graduatedCoin && trendingToken) return 'fee_graduated_trending';
  if (hasFee && graduatedCoin) return 'fee_graduated';
  if (hasFee && trendingToken) return 'fee_trending';
  if (graduatedCoin && trendingToken) return 'graduated_trending';
  if (sourceCount >= 3) return 'multi_source';
  if (sourceCount >= 2) return 'dual_source';
  return 'single_source';
}

export function buildSignalMeta({ signal, sourceCount, sources, hasFeeClaim, route, seenAtMs }) {
  return {
    ageMs: signal?.ageMs ?? null,
    sourceCount,
    sources,
    hasFeeClaim,
    seenAtMs,
    route,
  };
}

function logEarlySignalSkip({ signal, strat, signalMeta, reasonCode, reasonText }) {
  try {
    logScreeningEvent({
      stage: 'early_signal_gate',
      action: 'skipped',
      reasonCode,
      reasonText,
      mint: signal.mint,
      strategy: strat,
      signalKey: signalKey(signal),
      sourceCount: signalMeta.sourceCount,
      sources: signalMeta.sources,
      route: signalMeta.route,
      ageMs: signalMeta.ageMs,
      ageThresholdMs: strat.token_age_max_ms,
      hasFeeClaim: signalMeta.hasFeeClaim,
      configSnapshot: strat,
      providerFields: {
        seenAtMs: signalMeta.seenAtMs,
        trendingSource: signal.trending?.source,
        signalSources: signalMeta.sources,
      },
    });
  } catch (err) {
    console.log(`[server] screening event log failed for ${reasonCode}: ${err.message}`);
  }
}

export async function fetchServerSignals() {
  try {
    const url = new URL('/api/signals', SIGNAL_SERVER_URL);
    url.searchParams.set('limit', '100');
    url.searchParams.set('minSources', '2');

    const res = await axios.get(url.toString(), {
      timeout: 10_000,
      headers: SIGNAL_SERVER_KEY ? { 'x-api-key': SIGNAL_SERVER_KEY } : {},
    });
    const signals = res.data?.signals || [];

    prune(seenSignals, 10 * 60_000);

    const strat = activeStrategy();
    let processed = 0;
    let triggered = 0;
    let dipAlerts = 0;

    for (const signal of signals) {
      const mint = signal.mint;
      if (!mint) continue;

      // Update graduated map
      if (signal.graduated) {
        graduated.set(mint, {
          ...signal.graduated,
          coinMint: mint,
          seenAt: now(),
          // Server doesn't nest these on the graduated object — pull from top-level
          name: signal.name,
          ticker: signal.symbol,
          volume: signal.volume24h ?? 0,
          marketCap: signal.marketCapUsd ?? 0,
        });
      }

      // Update trending map
      if (signal.trending) {
        const risk = normalizeTrendingRiskFields(signal.trending, {
          source: signal.sources?.find(s => s.includes('trending')) || 'signal_server',
        });
        const trendingToken = {
          address: mint,
          name: signal.name,
          symbol: signal.symbol,
          price: signal.priceUsd,
          market_cap: signal.marketCapUsd,
          liquidity: signal.liquidityUsd,
          holder_count: signal.holders,
          volume: signal.volume5m ?? signal.volume24h ?? 0,
          // Server sends buys/sells separately; compute swaps so trending_min_swaps works
          swaps: (signal.trending.buys ?? 0) + (signal.trending.sells ?? 0),
          source: signal.sources?.find(s => s.includes('trending')) || 'server',
          seenAt: now(),
          ...signal.trending,
          rug_ratio: risk.rug_ratio,
          bundler_rate: risk.bundler_rate,
          is_wash_trading: risk.is_wash_trading,
          risk_field_availability: risk.risk_field_availability,
        };
        trending.set(mint, trendingToken);
      }

      const key = `signal:${mint}`;
      if (seenSignals.has(key)) { processed++; continue; }
      seenSignals.set(key, now());

      // Store signal events
      for (const source of signal.sources) {
        const kind = source.includes('trending') ? 'trending' : source.includes('fee') ? 'fee_claim' : 'graduated';
        storeSignalEvent(mint, kind, source, signal);
      }

      const graduatedCoin = graduated.get(mint) || signal.graduated || null;
      const trendingToken = trending.get(mint) || null;
      const hasFee = Boolean(signal.feeClaim);
      const sourceCount = signal.sourceCount || 1;
      const sources = sourceLabels(signal);
      const route = routeForSignal({ hasFee, graduatedCoin, trendingToken, sourceCount });
      const signalMeta = buildSignalMeta({
        signal,
        sourceCount,
        sources,
        hasFeeClaim: hasFee,
        route,
        seenAtMs: now(),
      });

      // Strategy gate: check source count
      if (sourceCount < strat.min_source_count) {
        logEarlySignalSkip({
          signal,
          strat,
          signalMeta,
          reasonCode: 'source_count_below_min',
          reasonText: `source count ${sourceCount} below min ${strat.min_source_count}`,
        });
        processed++;
        continue;
      }

      // Strategy gate: fee claim requirement
      if (strat.require_fee_claim && !hasFee) {
        logEarlySignalSkip({
          signal,
          strat,
          signalMeta,
          reasonCode: 'fee_claim_missing_required',
          reasonText: 'fee claim missing but required by strategy',
        });
        processed++;
        continue;
      }

      // Strategy gate: token age
      if (strat.token_age_max_ms > 0) {
        const tokenAge = signal.ageMs || 0;
        if (tokenAge > strat.token_age_max_ms) {
          logEarlySignalSkip({
            signal,
            strat,
            signalMeta,
            reasonCode: 'token_age_above_max',
            reasonText: `token age ${tokenAge}ms above max ${strat.token_age_max_ms}ms`,
          });
          processed++;
          continue;
        }
      }

      // Build fee object if present
      let fee = null;
      let signature = null;
      if (signal.feeClaim) {
        fee = {
          mint,
          distributed: BigInt(Math.floor(signal.feeClaim.distributedSol * 1e9)),
          shareholders: (signal.feeClaim.shareholders || []).map(h => ({
            pubkey: h.address,
            bps: h.bps,
          })),
        };
        signature = signal.feeClaim.signature;
      }

      // Entry mode logic
      if (strat.entry_mode === 'wait_for_dip' && strat.max_ath_distance_pct < 0) {
        // Dip buy strategy: check if already at target
        const athDist = signal.graduated?.distanceFromAthPercent;
        if (athDist != null && athDist <= strat.max_ath_distance_pct) {
          // Already at dip target, trigger immediately
          await triggerCandidate({ mint, fee, signature, graduatedCoin, trendingToken, route, signalMeta });
          triggered++;
        } else {
          // Store price alert for later
          const { storePriceAlert } = await import('./priceMonitor.js');
          const targetPrice = signal.priceUsd ? signal.priceUsd * (1 + strat.max_ath_distance_pct / 100) : null;
          storePriceAlert({
            mint,
            strategyId: strat.id,
            alertType: 'dip_target',
            targetPriceUsd: targetPrice,
            targetAthDistancePercent: strat.max_ath_distance_pct,
            signal,
            expiresMs: 24 * 60 * 60 * 1000,
          });
          dipAlerts++;
        }
      } else {
        // Immediate entry mode (sniper, smart_money, degen)
        await triggerCandidate({ mint, fee, signature, graduatedCoin, trendingToken, route, signalMeta });
        triggered++;
      }

      processed++;
    }

    const dipPart = dipAlerts > 0 ? `, ${dipAlerts} dip alerts` : '';
    console.log(`[server] ${processed} signals, ${triggered} triggered${dipPart}, tracking ${trending.size}`);
  } catch (err) {
    console.log(`[server] ${err.message}`);
  }
}
