import { now, json } from '../utils.js';
import { numSetting, strategyById, activeStrategy } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl } from '../enrichment/jupiter.js';
import { estimateJupiterSwapOutput, fetchLiveTokenBalance, liveWalletPubkey } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sampleMarketCap } from '../enrichment/mcapSampler.js';
import { recordDeployerObservation } from '../db/blacklist.js';
import { fetchBirdeyeOhlcv } from '../enrichment/birdeye.js';
import { computeCutoffSignals } from '../analysis/ohlcvSignals.js';
import { insertReentryWatch, pruneReentryWatches } from '../db/reentry.js';
import { buildCutoffLlmPayload } from '../pipeline/llm.js';
import { INSTANCE_ID, LLM_TIMEOUT_MS, WSOL_MINT } from '../config.js';
import { postChatCompletion } from '../llm/providers.js';
import { getLiveLockDb, releaseLiveExecutionLock } from './liveLock.js';

async function callCutoffLlm(position, { ohlcvCandles, cutoffSignals, pnlPercent, holdTimeMin }) {
  try {
    const { systemPrompt, userPayload } = buildCutoffLlmPayload(position, {
      ohlcvCandles,
      cutoffSignals,
      pnlPercent,
      holdTimeMin,
    });
    const { response } = await postChatCompletion({
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
    }, {
      timeout: Math.min(LLM_TIMEOUT_MS, 30000),
    });
    const data = response.data;
    const text = data.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const verdict = String(parsed.verdict || '').toUpperCase();
    if (!['CUT', 'HOLD', 'TIGHTEN_SL'].includes(verdict)) return null;
    return {
      verdict,
      confidence: Number(parsed.confidence) || 50,
      reason: String(parsed.reason || ''),
      suggested_new_sl_percent: parsed.suggested_new_sl_percent != null ? Number(parsed.suggested_new_sl_percent) : null,
    };
  } catch (err) {
    console.log(`[soft-cutoff] LLM call failed: ${err.message}`);
    return null;
  }
}

export async function freshEntryMarket(mint, candidate) {
  const mcapSample = await sampleMarketCap({
    mint,
    context: 'fresh_entry_market',
    trendingToken: trending.get(mint) || candidate?.trending || null,
    fallbackMarketCapUsd: firstPositiveNumber(candidate?.metrics?.marketCapUsd, candidate?.metrics?.graduatedMarketCapUsd),
    fallbackPriceUsd: candidate?.metrics?.priceUsd,
    useCache: false,
  });
  return {
    gmgn: mcapSample.gmgn,
    asset: mcapSample.jupiterAsset,
    priceUsd: mcapSample.priceUsd,
    marketCapUsd: mcapSample.marketCapUsd,
    mcapSample,
    refreshedAtMs: mcapSample.sampledAtMs,
  };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const strat = activeStrategy();
  const mcapSample = await sampleMarketCap({
    mint,
    context: 'pre_execution',
    trendingToken: selectedTrending,
    fallbackMarketCapUsd: firstPositiveNumber(candidate.metrics?.marketCapUsd, candidate.metrics?.graduatedMarketCapUsd),
    fallbackPriceUsd: candidate.metrics?.priceUsd,
    useCache: false,
    thresholds: {
      minMarketCapUsd: strat.min_mcap_usd,
      maxMarketCapUsd: strat.max_mcap_usd,
    },
  });
  const gmgn = mcapSample.gmgn;
  const asset = mcapSample.jupiterAsset;
  const holders = await fetchJupiterHolders(mint);
  const chart = await fetchJupiterChartContext(mint);
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = mcapSample.priceUsd;
  const marketCapUsd = mcapSample.marketCapUsd;
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    mcapSample,
    executionRefresh: {
      refreshedAtMs: mcapSample.sampledAtMs,
      source: 'pre_execution',
      marketCapUsd,
      marketCapSource: mcapSample.source,
      marketCapDisagreementPercent: mcapSample.disagreementPercent,
      mcapSample,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export function positionScopedPnl(position, mcap) {
  const pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  return {
    pnlPercent,
    pnlSol: Number(position.size_sol) * pnlPercent / 100,
  };
}

export function classifyLiveSellReconciliation(balanceRaw, dustThresholdRaw) {
  if (balanceRaw == null) return { state: 'unknown', remainingRaw: null, hasResidual: false };
  const remainingRaw = Number(balanceRaw);
  if (!Number.isFinite(remainingRaw)) return { state: 'unknown', remainingRaw: null, hasResidual: false };
  const hasResidual = remainingRaw > Number(dustThresholdRaw);
  return {
    state: hasResidual ? 'residual' : 'matched',
    remainingRaw,
    hasResidual,
  };
}

function executableExitEstimateSol(estimate) {
  const outputLamports = Number(estimate?.outputAmount ?? estimate?.outputLamports ?? estimate?.outAmount ?? NaN);
  if (Number.isFinite(outputLamports) && outputLamports >= 0) return outputLamports / 1_000_000_000;
  const outputSol = Number(estimate?.outputSol ?? estimate?.receivedSol ?? estimate?.estimatedSol ?? NaN);
  return Number.isFinite(outputSol) && outputSol >= 0 ? outputSol : null;
}

async function estimateLiveExecutableExit(position) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to estimate.');
  return estimateJupiterSwapOutput({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
}

function numericOrFallback(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function recordHardLossObservation(position, { exitReason, pnlPercent, pnlSol, mcapSample }) {
  try {
    recordDeployerObservation(position, { exitReason, pnlPercent, pnlSol, mcapSample });
  } catch (err) {
    console.log(`[position] ${position.id} deployer observation failed: ${err.message}`);
  }
}

export async function refreshPosition(position, {
  autoExit = true,
  jupiterPnl = null,
  fetchAsset = fetchJupiterAsset,
  fetchGmgn = fetchGmgnTokenInfo,
  fetchMcapSample = sampleMarketCap,
  executeSell = executeLiveSell,
  estimateExecutableExit = estimateLiveExecutableExit,
  fetchTokenBalance = fetchLiveTokenBalance,
  sendReconciliationAlert = null,
} = {}) {
  const selectedTrending = trending.get(position.mint) || null;
  const mcapSample = await fetchMcapSample({
    mint: position.mint,
    context: 'position_monitor',
    trendingToken: selectedTrending,
    useCache: false,
    fetchGmgn,
    fetchAsset,
    fallbackReadings: [
      { source: 'position_high_water_mcap', marketCapUsd: position.high_water_mcap, priceUsd: position.high_water_price },
      { source: 'position_entry_mcap', marketCapUsd: position.entry_mcap, priceUsd: position.entry_price },
    ],
  });
  const asset = mcapSample.jupiterAsset;
  const price = firstPositiveNumber(mcapSample.priceUsd, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(mcapSample.marketCapUsd, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  const scopedPnl = positionScopedPnl(position, mcap);
  let pnlPercent = scopedPnl.pnlPercent;
  let pnlSol = scopedPnl.pnlSol;
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const hasPersistedTrailingArm = position.trailing_arm_percent !== null
    && position.trailing_arm_percent !== undefined
    && position.trailing_arm_percent !== '';
  const trailingArmPercent = hasPersistedTrailingArm && Number.isFinite(Number(position.trailing_arm_percent))
    ? Number(position.trailing_arm_percent)
    : Number(position.tp_percent);
  const trailingArmHit = pnlPercent >= trailingArmPercent;
  const hasPersistedEffectiveSl = position.effective_sl_percent !== null
    && position.effective_sl_percent !== undefined
    && position.effective_sl_percent !== '';
  const effectiveSlPercent = hasPersistedEffectiveSl && Number.isFinite(Number(position.effective_sl_percent))
    ? Number(position.effective_sl_percent)
    : Number(position.sl_percent);
  const slHit = pnlPercent <= effectiveSlPercent;
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && trailingArmHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  const trailingHit = trailingArmed && position.trailing_enabled && trailDrop <= -Math.abs(Number(position.trailing_percent));
  let exitReason = null;
  let closed = false;

  // Max hold time check
  const strat = strategyById(position.strategy_id);
  let snapshot = {};
  try {
    snapshot = JSON.parse(position.snapshot_json || '{}');
  } catch {
    snapshot = {};
  }
  const decisionOverrides = snapshot?.decision || {};
  const riskOverrides = snapshot?.resolved_risk || {};
  const breakevenAfterProfitPercent = numericOrFallback(
    riskOverrides.breakeven_after_profit_percent,
    numericOrFallback(decisionOverrides.suggested_breakeven_after_profit_percent, numericOrFallback(strat?.breakeven_after_profit_percent, 0)),
  );
  const existingBreakevenLockPercent = numericOrFallback(position.breakeven_lock_percent, NaN);
  const configuredBreakevenLockPercent = numericOrFallback(
    riskOverrides.breakeven_lock_percent,
    numericOrFallback(decisionOverrides.suggested_breakeven_lock_percent, numericOrFallback(strat?.breakeven_lock_percent, 0)),
  );
  const breakevenLockPercent = Number.isFinite(existingBreakevenLockPercent)
    ? existingBreakevenLockPercent
    : configuredBreakevenLockPercent;
  let breakevenArmed = Boolean(position.breakeven_armed);
  let breakevenArmedAtMs = position.breakeven_armed_at_ms ?? null;
  let deferredBreakevenExit = null;

  if (!breakevenArmed && breakevenAfterProfitPercent > 0 && pnlPercent >= breakevenAfterProfitPercent) {
    breakevenArmed = true;
    breakevenArmedAtMs = now();
    db.prepare(`
      UPDATE dry_run_positions
      SET breakeven_armed = 1, breakeven_armed_at_ms = ?, breakeven_lock_percent = ?
      WHERE id = ?
    `).run(breakevenArmedAtMs, breakevenLockPercent, position.id);
    console.log(`[position] ${position.id} breakeven lock armed at ${pnlPercent.toFixed(1)}% (floor ${breakevenLockPercent}%)`);
  }

  if (strat?.max_hold_ms > 0 && (now() - position.opened_at_ms) >= strat.max_hold_ms) {
    exitReason = 'MAX_HOLD';
  }

  // Soft cutoff: OHLCV-based hold/cut decision at configurable time
  if (!exitReason && strat?.soft_cutoff_ms > 0) {
    const posAge = now() - Number(position.opened_at_ms);
    const cutoffChecks = Number(position.cutoff_checks || 0);
    const maxRechecks = Number(strat.soft_cutoff_max_rechecks ?? 3);
    const recheckMs = Number(strat.soft_cutoff_recheck_ms ?? 3600000);
    const nextCutoffAt = Number(position.next_cutoff_at_ms || 0);
    const cutoffTriggerMs = Number(strat.soft_cutoff_ms) + (cutoffChecks * recheckMs);

    if (posAge >= cutoffTriggerMs && (nextCutoffAt === 0 || now() >= nextCutoffAt)) {
      if (cutoffChecks >= maxRechecks) {
        exitReason = 'SOFT_CUTOFF_MAX_RECHECKS';
      } else {
        try {
          const ohlcvInterval = strat.soft_cutoff_ohlcv_interval || '5m';
          const ohlcvCount = Number(strat.soft_cutoff_ohlcv_count ?? 30);
          const ohlcv = await fetchBirdeyeOhlcv(position.mint, { interval: ohlcvInterval, count: ohlcvCount });
          const signals = computeCutoffSignals(ohlcv.candles || [], {
            entryMcap: Number(position.entry_mcap),
            currentMcap: Number(mcap),
            highWaterMcap: Number(highWaterMcap),
          });

          // Try LLM for smarter decision, fall back to indicator-only
          const holdTimeMin = Math.round((now() - Number(position.opened_at_ms)) / 60000);
          const llmDecision = await callCutoffLlm(position, {
            ohlcvCandles: ohlcv.candles || [],
            cutoffSignals: signals,
            pnlPercent,
            holdTimeMin,
          });

          // Use LLM verdict if available, otherwise fall back to indicator recommendation
          const finalVerdict = llmDecision?.verdict || signals.recommendation.toUpperCase();
          const finalReason = llmDecision?.reason || `indicator: ${signals.recommendation}`;
          console.log(`[soft-cutoff] ${position.id} LLM=${llmDecision?.verdict || 'n/a'} indicator=${signals.recommendation} → ${finalVerdict} (${finalReason})`);

          if (finalVerdict === 'CUT') {
            exitReason = 'SOFT_CUTOFF_CUT';
            console.log(`[soft-cutoff] ${position.id} CUT: RSI=${signals.rsi?.toFixed(1)} mom=${signals.momentum?.toFixed(3)} vol=${signals.volume_trend}`);
          } else if (finalVerdict === 'TIGHTEN_SL') {
            const suggestedSl = llmDecision?.suggested_new_sl_percent ?? Math.max(-30, breakevenLockPercent);
            const tightenedSl = Math.max(suggestedSl, -60); // never tighten beyond original SL
            db.prepare('UPDATE dry_run_positions SET effective_sl_percent = ?, cutoff_checks = ?, next_cutoff_at_ms = ? WHERE id = ?')
              .run(tightenedSl, cutoffChecks + 1, now() + recheckMs, position.id);
            console.log(`[soft-cutoff] ${position.id} TIGHTEN: SL moved to ${tightenedSl}%, recheck #${cutoffChecks + 1}`);
          } else {
            db.prepare('UPDATE dry_run_positions SET cutoff_checks = ?, next_cutoff_at_ms = ? WHERE id = ?')
              .run(cutoffChecks + 1, now() + recheckMs, position.id);
            console.log(`[soft-cutoff] ${position.id} HOLD: recheck #${cutoffChecks + 1} in ${recheckMs / 60000}min`);
          }
        } catch (err) {
          // On OHLCV fetch failure, schedule recheck without incrementing
          db.prepare('UPDATE dry_run_positions SET next_cutoff_at_ms = ? WHERE id = ?')
            .run(now() + recheckMs, position.id);
          console.log(`[soft-cutoff] ${position.id} OHLCV fetch failed: ${err.message}, retry in ${recheckMs / 60000}min`);
        }
      }
    }
  }

  if (!exitReason && slHit) {
    exitReason = 'SL';
  } else if (!exitReason && breakevenArmed && pnlPercent <= breakevenLockPercent) {
    exitReason = 'BREAKEVEN_LOCK';
  }

  if (
    exitReason === 'BREAKEVEN_LOCK'
    && autoExit
    && position.execution_mode === 'live'
    && typeof estimateExecutableExit === 'function'
  ) {
    try {
      const estimate = await estimateExecutableExit(position, exitReason);
      const estimatedSol = executableExitEstimateSol(estimate);
      const breakevenFloorSol = Number(position.size_sol) * (1 + breakevenLockPercent / 100);
      if (estimatedSol != null && Number.isFinite(breakevenFloorSol) && estimatedSol < breakevenFloorSol) {
        deferredBreakevenExit = {
          at_ms: now(),
          reason: 'executable_estimate_below_floor',
          floor_sol: breakevenFloorSol,
          estimated_sol: estimatedSol,
          estimate,
          mcap_pnl_percent: pnlPercent,
          mcap,
        };
        db.prepare('UPDATE dry_run_positions SET snapshot_json = ? WHERE id = ?')
          .run(json({ ...snapshot, breakeven_exit_deferred: deferredBreakevenExit }), position.id);
        console.log(`[position] ${position.id} breakeven lock deferred: executable estimate ${estimatedSol.toFixed(6)} SOL below floor ${breakevenFloorSol.toFixed(6)} SOL`);
        exitReason = null;
      }
    } catch (err) {
      deferredBreakevenExit = {
        at_ms: now(),
        reason: 'executable_estimate_failed',
        error: err.message,
        mcap_pnl_percent: pnlPercent,
        mcap,
      };
      db.prepare('UPDATE dry_run_positions SET snapshot_json = ? WHERE id = ?')
        .run(json({ ...snapshot, breakeven_exit_deferred: deferredBreakevenExit }), position.id);
      console.log(`[position] ${position.id} breakeven lock deferred: executable estimate failed: ${err.message}`);
      exitReason = null;
    }
  }

  // Partial TP check
  if (!exitReason && breakevenAfterProfitPercent <= 0 && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1 WHERE id = ?').run(position.id);
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      try {
        const sellAmount = Math.floor(Number(position.token_amount_raw) * (strat.partial_tp_sell_percent / 100));
        if (sellAmount > 0) {
          const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
          const remaining = Number(position.token_amount_raw) - sellAmount;
          db.prepare('UPDATE dry_run_positions SET token_amount_raw = ? WHERE id = ?').run(String(remaining), position.id);
          db.prepare(`
            INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
            VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
          `).run(position.id, position.mint, now(), price, mcap,
            position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
            json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining }));
          console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${remaining} remaining`);
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed: ${err.message}`);
      }
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (tpHit && !position.trailing_enabled && breakevenAfterProfitPercent <= 0) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }

  if (!exitReason && strat?.max_hold_if_no_tp_ms > 0) {
    const positionAgeMs = now() - Number(position.opened_at_ms);
    if (positionAgeMs >= Number(strat.max_hold_if_no_tp_ms) && !trailingArmed) {
      exitReason = 'TIME_STOP_NO_TP';
    }
  }

  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?,
        breakeven_armed = ?, breakeven_armed_at_ms = ?, breakeven_lock_percent = ?
    WHERE id = ?
  `).run(
    highWaterMcap,
    highWaterPrice,
    trailingArmed ? 1 : 0,
    breakevenArmed ? 1 : 0,
    breakevenArmedAtMs,
    breakevenLockPercent,
    position.id,
  );

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    const dustThresholdRaw = numSetting('live_sell_dust_threshold_raw', 1000);
    const balanceRaw = await fetchTokenBalance(position.mint);
    const reconciliation = classifyLiveSellReconciliation(balanceRaw, dustThresholdRaw);
    const alertPayload = {
      position,
      expectedSellAmount: position.token_amount_raw || position.token_amount_est,
      remainingBalance: reconciliation.remainingRaw,
      signature: sell.signature,
      reason: exitReason,
    };
    const alertFn = sendReconciliationAlert || (async (payload) => {
      const { sendLiveSellReconciliationAlert } = await import('../telegram/send.js');
      return sendLiveSellReconciliationAlert(payload);
    });
    if (reconciliation.state === 'unknown') {
      await alertFn({ ...alertPayload, balanceCheckFailed: true });
    }
    if (reconciliation.hasResidual) {
      db.prepare(`
        UPDATE dry_run_positions
        SET status = 'partial_exit', token_amount_raw = ?, exit_price = ?, exit_mcap = ?,
            exit_reason = ?, pnl_percent = ?, pnl_sol = ?, exit_signature = ?
        WHERE id = ?
      `).run(String(reconciliation.remainingRaw), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
      db.prepare(`
        INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
        VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
      `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({
        pnlPercent: finalPnlPercent,
        pnlSol: finalPnlSol,
        receivedSol: receivedSol ?? null,
        sell,
        reconciliation,
        jupiterPnl,
        mcapSample,
      }));
      await alertFn(alertPayload);
      return {
        ...position,
        status: 'partial_exit',
        token_amount_raw: String(reconciliation.remainingRaw),
        asset,
        mcapSample,
        price,
        mcap,
        highWaterMcap,
        high_water_mcap: highWaterMcap,
        high_water_price: highWaterPrice,
        effective_sl_percent: effectiveSlPercent,
        breakeven_armed: breakevenArmed ? 1 : 0,
        breakeven_armed_at_ms: breakevenArmedAtMs,
        breakeven_lock_percent: breakevenLockPercent,
        pnlPercent: finalPnlPercent,
        pnl_percent: finalPnlPercent,
        pnlSol: finalPnlSol,
        pnl_sol: finalPnlSol,
        exitReason: null,
        exit_reason: exitReason,
        exit_mcap: mcap,
        exit_price: price,
        exit_signature: sell.signature,
        deferredBreakevenExit,
      };
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell, reconciliation, jupiterPnl, mcapSample }));
    releaseLiveExecutionLockForPosition(position, exitReason);
    recordHardLossObservation(position, { exitReason, pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, mcapSample });
    closed = true;
  } else if (exitReason && autoExit) {
    // Dry-run: apply configurable slippage and fee simulation
    const drySlippagePct = numSetting('dry_run_slippage_pct', 1.0);
    const dryFeePct = numSetting('dry_run_fee_pct', 0.2);
    const effectiveExitMcap = Number(mcap) * (1 - drySlippagePct / 100);
    const effectiveEntryMcap = Number(position.entry_mcap);
    const simPnlPercent = effectiveEntryMcap > 0
      ? (effectiveExitMcap / effectiveEntryMcap - 1) * 100
      : pnlPercent;
    const feeDeductionSol = Number(position.size_sol) * (dryFeePct / 100);
    const simPnlSol = Number(position.size_sol) * simPnlPercent / 100 - feeDeductionSol;
    finalPnlPercent = simPnlPercent;
    finalPnlSol = simPnlSol;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, drySlippagePct, dryFeePct, mcapSample }));
    releaseLiveExecutionLockForPosition(position, exitReason);
    recordHardLossObservation(position, { exitReason, pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, mcapSample });
    closed = true;
  }
  // Re-entry watch: track SL exits for potential re-entry
  if (exitReason === 'SL') {
    try {
      if (strat?.reentry_enabled) {
        const windowMs = Number(strat.reentry_window_ms ?? 86400000);
        insertReentryWatch({
          mint: position.mint,
          originalPositionId: position.id,
          entryMcap: Number(position.entry_mcap),
          slMcap: Number(mcap),
          windowMs,
        });
        pruneReentryWatches();
        console.log(`[reentry] ${position.mint.slice(0, 8)} SL exit — watching for re-entry for ${windowMs / 3600000}h`);
      }
    } catch (err) {
      console.log(`[reentry] watch insert failed: ${err.message}`);
    }
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    mcapSample,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    effective_sl_percent: effectiveSlPercent,
    trailing_arm_percent: trailingArmPercent,
    trailing_armed: trailingArmed ? 1 : 0,
    breakeven_armed: breakevenArmed ? 1 : 0,
    breakeven_armed_at_ms: breakevenArmedAtMs,
    breakeven_lock_percent: breakevenLockPercent,
    deferredBreakevenExit,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export function releaseLiveExecutionLockForPosition(position, reason) {
  try {
    if (position?.execution_mode !== 'live') return false;
    const { id } = (liveLockRow(position) || {});
    if (id) releaseLiveExecutionLock(id, `position_closed:${reason || 'closed'}`);
    return Boolean(id);
  } catch (err) {
    console.log(`[live-lock] release failed for position ${position?.id}: ${err.message}`);
    return false;
  }
}

function liveLockRow(position) {
  return getLiveLockDb().prepare(`
    SELECT id FROM live_execution_locks
    WHERE position_id = ?
      AND mint = ?
      AND lane = ?
      AND status = 'open'
    LIMIT 1
  `).get(position.id, position.mint, INSTANCE_ID);
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) {
      const { sendPositionExit } = await import('../telegram/send.js');
      await sendPositionExit(result);
    }
  }
}
