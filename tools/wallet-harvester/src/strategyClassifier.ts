// ---------------------------------------------------------------------------
// Wallet Harvester — Strategy Classifier (S4)
//
// Classifies each wallet into strategy archetypes and extracts TP/SL params.
// No API calls — all data from local SQLite.
// ---------------------------------------------------------------------------

import type pino from "pino";
import type { HarvesterStore } from "./store.js";
import type { PositionRecord, TradeContextRecord, WalletStrategyRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Config / result types
// ---------------------------------------------------------------------------

export interface ClassifierConfig {
  /** Skip wallets with fewer closed positions than this (default 3) */
  minClosedPositions: number;
  /** Entry within N seconds of timestamp 0-offset = bot signal (default 5) */
  botTimingThresholdS: number;
  /** >N positions/day = bot signal (default 20) */
  botFrequencyPerDay: number;
}

export interface ClassifyResult {
  walletsAnalyzed: number;
  walletsSkipped: number;
  walletsClassified: number;
  durationMs: number;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  minClosedPositions: 3,
  botTimingThresholdS: 5,
  botFrequencyPerDay: 20,
};

// ---------------------------------------------------------------------------
// Pure statistical helpers
// ---------------------------------------------------------------------------

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const frac = rank - lower;
  return sorted[lower]! + frac * (sorted[upper]! - sorted[lower]!);
}

export function stddev(values: number[]): number | null {
  if (values.length < 2) return null;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Archetype classification
// ---------------------------------------------------------------------------

interface StrategyProfile {
  avgEntriesPerPos: number | null;
  singleEntryPct: number | null;
  dcaPct: number | null;
  medianHoldS: number | null;
  winRate: number | null;
  avgPnlPct: number | null;
  isLikelyBot: number;
  closedPositions: number;
  openPositions: number;
  tradeContexts: TradeContextRecord[];
}

function classifyArchetype(profile: StrategyProfile): string {
  const {
    avgEntriesPerPos,
    singleEntryPct,
    dcaPct,
    medianHoldS,
    winRate,
    avgPnlPct,
    isLikelyBot,
    closedPositions,
    openPositions,
    tradeContexts,
  } = profile;

  // 1. sniper_bot
  if (isLikelyBot === 1 && medianHoldS !== null && medianHoldS < 1800) {
    return "sniper_bot";
  }

  // 2. pump_dumper
  if (
    medianHoldS !== null && medianHoldS < 900 &&
    winRate !== null && winRate > 0.5 &&
    avgPnlPct !== null && avgPnlPct > 50
  ) {
    return "pump_dumper";
  }

  // 3. momentum_scalper
  if (
    singleEntryPct !== null && singleEntryPct > 0.7 &&
    medianHoldS !== null && medianHoldS < 3600 &&
    isLikelyBot === 0
  ) {
    return "momentum_scalper";
  }

  // 4. dca_accumulator
  if (
    dcaPct !== null && dcaPct > 0.5 &&
    medianHoldS !== null && medianHoldS > 3600
  ) {
    return "dca_accumulator";
  }

  // 5. dip_buyer — requires trade context
  if (tradeContexts.length >= 3) {
    const rsiValues = tradeContexts
      .map(tc => tc.rsi14)
      .filter((v): v is number => v !== null);
    if (rsiValues.length >= 3) {
      const belowForty = rsiValues.filter(r => r < 40).length;
      if (belowForty / rsiValues.length > 0.5) {
        return "dip_buyer";
      }
    }

    // 6. trend_follower
    const trendValues = tradeContexts
      .map(tc => tc.emaTrend)
      .filter((v): v is string => v !== null);
    if (trendValues.length >= 3) {
      const bullish = trendValues.filter(t => t === "bullish").length;
      if (bullish / trendValues.length > 0.5) {
        return "trend_follower";
      }
    }
  }

  // 7. diamond_hands
  if (
    openPositions > closedPositions &&
    medianHoldS !== null && medianHoldS > 86400
  ) {
    return "diamond_hands";
  }

  // 8. copy_trader — reserved
  // 9. default
  return "unknown";
}

// ---------------------------------------------------------------------------
// Per-wallet analysis
// ---------------------------------------------------------------------------

function analyzeWallet(
  walletAddress: string,
  positions: PositionRecord[],
  tradeContexts: TradeContextRecord[],
  cfg: ClassifierConfig,
): WalletStrategyRecord | null {
  const closed = positions.filter(p => p.status === "closed");
  const open = positions.filter(p => p.status === "open");

  if (closed.length < cfg.minClosedPositions) return null;

  const total = positions.length;

  // --- Entry style ---
  const singleEntryCount = positions.filter(p => p.entryCount === 1).length;
  const dcaCount = positions.filter(p => p.isDca === 1).length;
  const scaleInCount = positions.filter(p => p.isScaleIn === 1).length;
  const singleEntryPct = total > 0 ? singleEntryCount / total : null;
  const dcaPct = total > 0 ? dcaCount / total : null;
  const scaleInPct = total > 0 ? scaleInCount / total : null;
  const avgEntriesPerPos = mean(positions.map(p => p.entryCount));

  // --- Exit style ---
  const singleExitCount = closed.filter(p => p.exitCount === 1).length;
  const partialTpCount = closed.filter(p => p.isPartialTp === 1).length;
  const trailingExitCount = closed.filter(p => p.isTrailingLike === 1).length;
  const singleExitPct = closed.length > 0 ? singleExitCount / closed.length : null;
  const partialTpPct = closed.length > 0 ? partialTpCount / closed.length : null;
  const trailingExitPct = closed.length > 0 ? trailingExitCount / closed.length : null;
  const avgExitsPerPos = closed.length > 0 ? mean(closed.map(p => p.exitCount)) : null;

  // --- TP/SL parameters (closed positions only) ---
  const winners = closed.filter(p => p.realizedPct !== null && p.realizedPct > 0);
  const losers = closed.filter(p => p.realizedPct !== null && p.realizedPct < 0);
  const winnerPcts = winners.map(p => p.realizedPct as number);
  const loserPcts = losers.map(p => p.realizedPct as number);

  const medianTpPct = median(winnerPcts);
  const p25TpPct = percentile(winnerPcts, 25);
  const p75TpPct = percentile(winnerPcts, 75);
  const medianSlPct = median(loserPcts);
  const p25SlPct = percentile(loserPcts, 25);
  const p75SlPct = percentile(loserPcts, 75);

  // --- Timing ---
  const holdTimes = closed
    .map(p => p.holdDurationS)
    .filter((v): v is number => v !== null);
  const medianHoldS = median(holdTimes);
  const avgHoldS = mean(holdTimes);

  const entryHours = positions.map(p =>
    Math.floor((p.firstEntryTs % 86400) / 3600)
  );
  const medianEntryHour = median(entryHours);

  // --- Token selection ---
  const mcapValues = positions
    .map(p => p.entryMcapUsd)
    .filter((v): v is number => v !== null);
  const medianEntryMcap = median(mcapValues);
  const avgEntryMcap = mean(mcapValues);

  const positionsWithMcap = positions.filter(p => p.entryMcapUsd !== null);
  const under200k = positionsWithMcap.filter(p => (p.entryMcapUsd as number) < 200000).length;
  const pctUnder200k = positionsWithMcap.length > 0 ? under200k / positionsWithMcap.length : null;

  // --- Performance ---
  const pnlPcts = closed
    .map(p => p.realizedPct)
    .filter((v): v is number => v !== null);
  const winRate = closed.length > 0 ? winners.length / closed.length : null;
  const avgPnlPct = mean(pnlPcts);
  const medianPnlPct = median(pnlPcts);

  let sharpeLike: number | null = null;
  if (pnlPcts.length >= 2) {
    const m = mean(pnlPcts)!;
    const s = stddev(pnlPcts);
    if (s !== null && s > 0) {
      sharpeLike = m / s;
    }
  }

  // --- Bot detection ---
  let botScore = 0.0;

  // +0.3 sniper pattern
  if (
    avgEntriesPerPos !== null && avgEntriesPerPos < 1.05 &&
    singleEntryPct !== null && singleEntryPct > 0.95 &&
    medianHoldS !== null && medianHoldS < 3600
  ) {
    botScore += 0.3;
  }

  // +0.2 high frequency
  const allTs = positions.map(p => p.firstEntryTs);
  if (allTs.length >= 2) {
    const minTs = Math.min(...allTs);
    const maxTs = Math.max(...allTs);
    const observedDays = Math.max(1, (maxTs - minTs) / 86400);
    const posPerDay = closed.length / observedDays;
    if (posPerDay > cfg.botFrequencyPerDay) {
      botScore += 0.2;
    }
  }

  // +0.2 fast and consistently profitable
  if (
    medianHoldS !== null && medianHoldS < 300 &&
    winRate !== null && winRate > 0.6
  ) {
    botScore += 0.2;
  }

  // +0.1 exact same entry count every time
  const entryCounts = positions.map(p => p.entryCount);
  const entryCountStddev = stddev(entryCounts);
  if (entryCountStddev !== null && entryCountStddev < 0.1) {
    botScore += 0.1;
  } else if (entryCounts.length < 2) {
    // single position — perfect "consistency"
    botScore += 0.1;
  }

  // +0.2 sub-second timing offset
  const hasSubSecondEntry = positions.some(
    p => (p.firstEntryTs % 86400) < cfg.botTimingThresholdS
  );
  if (hasSubSecondEntry) {
    botScore += 0.2;
  }

  const isLikelyBot = botScore >= 0.5 ? 1 : 0;
  const confidence = Math.min(1, botScore);

  // --- Archetype ---
  const archetype = classifyArchetype({
    avgEntriesPerPos,
    singleEntryPct,
    dcaPct,
    medianHoldS,
    winRate,
    avgPnlPct,
    isLikelyBot,
    closedPositions: closed.length,
    openPositions: open.length,
    tradeContexts,
  });

  return {
    walletAddress,
    totalPositions: total,
    closedPositions: closed.length,
    openPositions: open.length,
    singleEntryPct,
    dcaPct,
    scaleInPct,
    avgEntriesPerPos,
    singleExitPct,
    partialTpPct,
    trailingExitPct,
    avgExitsPerPos,
    medianTpPct,
    p25TpPct,
    p75TpPct,
    medianSlPct,
    p25SlPct,
    p75SlPct,
    trailingDetected: 0,
    trailingDropPct: null,
    medianHoldS: medianHoldS !== null ? Math.round(medianHoldS) : null,
    avgHoldS: avgHoldS !== null ? Math.round(avgHoldS) : null,
    medianEntryHour: medianEntryHour !== null ? Math.round(medianEntryHour) : null,
    medianEntryMcap,
    avgEntryMcap,
    pctUnder200k,
    winRate,
    avgPnlPct,
    medianPnlPct,
    sharpeLike,
    archetype,
    isLikelyBot,
    confidence,
    analyzedAtMs: Date.now(),
    analysisVersion: 1,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function classifyWallets(
  cfg: ClassifierConfig,
  store: HarvesterStore,
  logger: pino.Logger,
): Promise<ClassifyResult> {
  const startMs = Date.now();

  const wallets = store.getAllWalletAddressesWithPositions();

  let walletsAnalyzed = 0;
  let walletsSkipped = 0;
  let walletsClassified = 0;

  for (const walletAddress of wallets) {
    walletsAnalyzed++;
    const positions = store.getPositionsForWallet(walletAddress);

    const closed = positions.filter(p => p.status === "closed");
    if (closed.length < cfg.minClosedPositions) {
      walletsSkipped++;
      logger.debug({ wallet: walletAddress.slice(0, 12), closed: closed.length }, "skipped — too few closed positions");
      continue;
    }

    // Collect all entry trade IDs across all positions
    const entryTradeIds: number[] = [];
    for (const pos of positions) {
      const ids = JSON.parse(pos.tradeIdsJson) as number[];
      for (const id of ids) {
        entryTradeIds.push(id);
      }
    }

    const tradeContexts = store.getTradeContextForTrades(entryTradeIds);

    const record = analyzeWallet(walletAddress, positions, tradeContexts, cfg);
    if (!record) {
      walletsSkipped++;
      continue;
    }

    store.upsertWalletStrategy(record);
    walletsClassified++;

    logger.debug(
      { wallet: walletAddress.slice(0, 12), archetype: record.archetype, bot: record.isLikelyBot },
      "classified",
    );
  }

  return {
    walletsAnalyzed,
    walletsSkipped,
    walletsClassified,
    durationMs: Date.now() - startMs,
  };
}
