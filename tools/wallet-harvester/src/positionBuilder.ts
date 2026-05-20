// ---------------------------------------------------------------------------
// Wallet Harvester — Position Builder (S2)
//
// Groups trade records into coherent positions for each (wallet, mint) pair.
// No API calls are made — all data comes from the local trades table.
// ---------------------------------------------------------------------------

import type pino from "pino";
import type { HarvesterStore } from "./store.js";
import type { TradeRecord, PositionRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Config / result types
// ---------------------------------------------------------------------------

export interface BuildPositionsConfig {
  /** Delay between wallet-mint pairs in ms (default: 10ms — no API calls in S2) */
  rateLimitMs: number;
}

export interface BuildPositionsResult {
  walletsProcessed: number;
  positionsBuilt: number;
  positionsUpdated: number;
  tradesAssigned: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Position state used during the walk-forward algorithm
// ---------------------------------------------------------------------------

interface PositionState {
  walletAddress: string;
  mint: string;
  tradeIds: number[];
  // Buys
  buyTrades: Array<{ id: number; tokenAmount: number; solAmount: number; timestamp: number; priceSol: number }>;
  // Sells
  sellTrades: Array<{ id: number; tokenAmount: number; solAmount: number; timestamp: number; priceSol: number }>;
  // Running totals
  totalTokenIn: number;
  totalTokenOut: number;
}

// ---------------------------------------------------------------------------
// Core walk-forward algorithm
// ---------------------------------------------------------------------------

function reconstructPositions(
  walletAddress: string,
  mint: string,
  trades: TradeRecord[],
): PositionRecord[] {
  const positions: PositionRecord[] = [];
  let current: PositionState | null = null;

  for (const trade of trades) {
    const tradeId = (trade as TradeRecord & { id?: number }).id;

    if (trade.side === "buy") {
      // If no current position, open one
      if (!current) {
        current = {
          walletAddress,
          mint,
          tradeIds: [],
          buyTrades: [],
          sellTrades: [],
          totalTokenIn: 0,
          totalTokenOut: 0,
        };
      }
      const priceSol = trade.tokenAmount > 0 ? trade.solAmount / trade.tokenAmount : 0;
      current.buyTrades.push({
        id: tradeId ?? 0,
        tokenAmount: trade.tokenAmount,
        solAmount: trade.solAmount,
        timestamp: trade.timestamp,
        priceSol,
      });
      if (tradeId !== undefined) current.tradeIds.push(tradeId);
      current.totalTokenIn += trade.tokenAmount;

    } else {
      // side === "sell"
      if (!current) {
        // Sells exceed buys — wallet received tokens via transfer/airdrop.
        // Open a synthetic position with zero buys so we can still track the sell.
        current = {
          walletAddress,
          mint,
          tradeIds: [],
          buyTrades: [],
          sellTrades: [],
          totalTokenIn: 0,
          totalTokenOut: 0,
        };
      }
      const priceSol = trade.tokenAmount > 0 ? trade.solAmount / trade.tokenAmount : 0;
      current.sellTrades.push({
        id: tradeId ?? 0,
        tokenAmount: trade.tokenAmount,
        solAmount: trade.solAmount,
        timestamp: trade.timestamp,
        priceSol,
      });
      if (tradeId !== undefined) current.tradeIds.push(tradeId);
      current.totalTokenOut += trade.tokenAmount;

      // Check if position is fully closed (≥95% of tokens sold)
      const isFullExit =
        current.totalTokenIn <= 0 ||
        current.totalTokenOut >= 0.95 * current.totalTokenIn;

      if (isFullExit) {
        positions.push(finalizePosition(current, true));
        current = null;
      }
    }
  }

  // Any remaining open position
  if (current !== null) {
    positions.push(finalizePosition(current, false));
  }

  return positions;
}

function finalizePosition(state: PositionState, forceClose: boolean): PositionRecord {
  const { walletAddress, mint, buyTrades, sellTrades, totalTokenIn, totalTokenOut } = state;

  // --- Entry stats ---
  const entryCount = buyTrades.length;
  const firstEntryTs = buyTrades.length > 0 ? buyTrades[0]!.timestamp : 0;
  const lastEntryTs = buyTrades.length > 0 ? buyTrades[buyTrades.length - 1]!.timestamp : 0;

  let totalSolIn = 0;
  for (const b of buyTrades) totalSolIn += b.solAmount;

  const avgEntryPrice =
    totalTokenIn > 0 ? totalSolIn / totalTokenIn : null;

  const entrySpreadS = buyTrades.length > 1
    ? lastEntryTs - firstEntryTs
    : 0;

  // is_dca: >1 entry AND all prices within 20% of each other
  let isDca = 0;
  if (entryCount > 1 && buyTrades.length > 1) {
    const prices = buyTrades.map(b => b.priceSol).filter(p => p > 0);
    if (prices.length > 1) {
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);
      isDca = maxP <= minP * 1.2 ? 1 : 0;
    }
  }

  // is_scale_in: >1 entry AND each price strictly higher than previous
  let isScaleIn = 0;
  if (entryCount > 1 && buyTrades.length > 1) {
    let strictlyAscending = true;
    for (let i = 1; i < buyTrades.length; i++) {
      if (buyTrades[i]!.priceSol <= buyTrades[i - 1]!.priceSol) {
        strictlyAscending = false;
        break;
      }
    }
    // Also require second price to be more than 20% higher than first for meaningful scale-in
    // (spec says "strictly higher prices" — we follow spec literally)
    isScaleIn = strictlyAscending ? 1 : 0;
  }

  // --- Exit stats ---
  const exitCount = sellTrades.length;
  const firstExitTs = sellTrades.length > 0 ? sellTrades[0]!.timestamp : null;
  const lastExitTs = sellTrades.length > 0 ? sellTrades[sellTrades.length - 1]!.timestamp : null;

  let totalSolOut = 0;
  for (const s of sellTrades) totalSolOut += s.solAmount;

  const avgExitPrice =
    totalTokenOut > 0 && exitCount > 0 ? totalSolOut / totalTokenOut : null;

  const exitSpreadS =
    exitCount > 1 ? lastExitTs! - firstExitTs! :
    exitCount === 1 ? 0 : null;

  const isPartialTp = exitCount > 1 ? 1 : 0;

  const isFullExitFlag =
    (totalTokenIn <= 0 && exitCount > 0) ||
    (totalTokenIn > 0 && totalTokenOut >= 0.95 * totalTokenIn)
      ? 1 : 0;

  const status: 'open' | 'closed' = (forceClose || isFullExitFlag === 1) ? 'closed' : 'open';

  // --- PnL ---
  const realizedSol = totalSolOut - totalSolIn;
  const realizedPct =
    totalSolIn > 0 ? (realizedSol / totalSolIn) * 100 : null;

  // --- Durations ---
  const holdDurationS =
    firstExitTs !== null ? lastExitTs! - firstEntryTs : null;

  return {
    walletAddress,
    mint,
    status,
    entryCount,
    firstEntryTs,
    lastEntryTs,
    avgEntryPrice,
    totalSolIn,
    totalTokenIn,
    entryMcapUsd: null,
    exitCount,
    firstExitTs,
    lastExitTs,
    avgExitPrice,
    totalSolOut,
    totalTokenOut,
    realizedSol,
    realizedUsd: null,
    realizedPct,
    holdDurationS,
    entrySpreadS,
    exitSpreadS,
    isDca,
    isScaleIn,
    isPartialTp,
    isFullExit: isFullExitFlag,
    isTrailingLike: 0,
    tradeIdsJson: JSON.stringify(state.tradeIds),
    builtAtMs: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise(r => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function buildPositions(
  cfg: BuildPositionsConfig,
  store: HarvesterStore,
  logger: pino.Logger,
): Promise<BuildPositionsResult> {
  const startMs = Date.now();

  const pairs = store.getDistinctWalletMintPairs();
  const walletsSeen = new Set<string>();

  let positionsBuilt = 0;
  let positionsUpdated = 0;
  let tradesAssigned = 0;

  for (const pair of pairs) {
    const { wallet_address, mint } = pair;
    walletsSeen.add(wallet_address);

    const trades = store.getTradesForWalletMint(wallet_address, mint);
    if (trades.length === 0) continue;

    const reconstructed = reconstructPositions(wallet_address, mint, trades);

    for (const pos of reconstructed) {
      const tradeCount = (JSON.parse(pos.tradeIdsJson) as number[]).length;
      const isNew = store.upsertPosition(pos);
      if (isNew) {
        positionsBuilt++;
      } else {
        positionsUpdated++;
      }
      tradesAssigned += tradeCount;
    }

    logger.debug(
      { wallet: wallet_address.slice(0, 12), mint: mint.slice(0, 12), positions: reconstructed.length },
      "positions built for wallet-mint pair",
    );

    await sleep(cfg.rateLimitMs);
  }

  return {
    walletsProcessed: walletsSeen.size,
    positionsBuilt,
    positionsUpdated,
    tradesAssigned,
    durationMs: Date.now() - startMs,
  };
}
