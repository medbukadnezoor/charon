// ---------------------------------------------------------------------------
// Wallet Harvester — Helius Trade History Collector
//
// Pulls complete swap history for every wallet in the DB from the Helius
// Enhanced Transactions API and stores results in the `trades` table.
// ---------------------------------------------------------------------------

import type { Logger } from "pino";
import type { HarvesterStore } from "./store.js";
import type { TradeRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Config / result types
// ---------------------------------------------------------------------------

export interface TradeHistoryConfig {
  heliusApiKey: string;
  heliusBaseUrl: string;
  lookbackDays: number;
  rateLimitMs: number;
  maxRetries: number;
  pageSize: number;
}

export interface TradeHistoryResult {
  walletsProcessed: number;
  walletsSkipped: number;
  walletsFailed: number;
  tradesInserted: number;
  tradesSkipped: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SOL_MINT = "So11111111111111111111111111111111111111111";
const WSOL_MINT = "So11111111111111111111111111111111111111112";
const SKIP_MINTS = new Set([SOL_MINT, WSOL_MINT]);
const ONE_HOUR_MS = 60 * 60 * 1_000;
const MAX_BACKOFF_MS = 30_000;

// ---------------------------------------------------------------------------
// Helius API types (minimal)
// ---------------------------------------------------------------------------

interface HeliusTokenTransfer {
  mint: string;
  tokenAmount: number;
  fromUserAccount: string;
  toUserAccount: string;
}

interface HeliusNativeTransfer {
  amount: number;
  fromUserAccount: string;
  toUserAccount: string;
}

interface HeliusTransaction {
  signature: string;
  timestamp: number;
  slot: number;
  type: string;
  source: string;
  tokenTransfers: HeliusTokenTransfer[];
  nativeTransfers: HeliusNativeTransfer[];
  feePayer: string;
}

// ---------------------------------------------------------------------------
// Fetch abstraction (injectable for testing)
// ---------------------------------------------------------------------------

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  await new Promise(r => setTimeout(r, ms));
}

function mapSource(source: string): string {
  const s = source.toUpperCase();
  if (s === "JUPITER") return "jupiter";
  if (s === "RAYDIUM") return "raydium";
  if (s === "ORCA") return "orca";
  if (s === "PUMP_FUN") return "pump";
  const lower = source.toLowerCase();
  return lower || "unknown";
}

/** Parse a single Helius transaction into a TradeRecord, or null if it should be skipped. */
function parseSwapTx(
  tx: HeliusTransaction,
  walletAddress: string,
  collectedAtMs: number,
): TradeRecord | null {
  if (tx.type !== "SWAP") return null;

  // Find the non-SOL/WSOL token transfer involving this wallet
  const relevantTransfer = tx.tokenTransfers.find(
    t =>
      !SKIP_MINTS.has(t.mint) &&
      (t.fromUserAccount === walletAddress || t.toUserAccount === walletAddress),
  );

  if (!relevantTransfer) return null;
  if (relevantTransfer.tokenAmount <= 0) return null;

  const side: "buy" | "sell" =
    relevantTransfer.toUserAccount === walletAddress ? "buy" : "sell";

  // Sum native (SOL) transfers involving this wallet
  let solLamports = 0;
  for (const nt of tx.nativeTransfers) {
    if (nt.fromUserAccount === walletAddress || nt.toUserAccount === walletAddress) {
      solLamports += nt.amount;
    }
  }
  const solAmount = solLamports / 1e9;
  const tokenAmount = relevantTransfer.tokenAmount;
  const priceSol = solAmount > 0 && tokenAmount > 0 ? solAmount / tokenAmount : null;

  return {
    walletAddress,
    signature: tx.signature,
    mint: relevantTransfer.mint,
    side,
    tokenAmount,
    solAmount,
    usdAmount: null,
    priceUsd: null,
    priceSol,
    timestamp: tx.timestamp,
    program: mapSource(tx.source),
    slot: tx.slot,
    rawJson: JSON.stringify(tx),
    collectedAtMs,
  };
}

// ---------------------------------------------------------------------------
// Per-wallet collector
// ---------------------------------------------------------------------------

async function collectWalletTrades(
  walletAddress: string,
  cfg: TradeHistoryConfig,
  store: HarvesterStore,
  logger: Logger,
  fetchFn: FetchFn,
): Promise<{ inserted: number; skipped: number }> {
  const lookbackCutoff =
    Math.floor(Date.now() / 1000) - cfg.lookbackDays * 24 * 60 * 60;

  let inserted = 0;
  let skipped = 0;
  let before: string | undefined;
  let currentDelay = cfg.rateLimitMs;
  const collectedAtMs = Date.now();
  const shortAddr = walletAddress.slice(0, 12);

  page: while (true) {
    const url =
      `${cfg.heliusBaseUrl}/v0/addresses/${walletAddress}/transactions` +
      `?api-key=${cfg.heliusApiKey}&type=SWAP&limit=${cfg.pageSize}` +
      (before ? `&before=${before}` : "");

    // Rate limit delay
    await sleep(currentDelay);

    // Fetch with retry on 429
    let res: Awaited<ReturnType<FetchFn>>;
    let retries = 0;
    let retryDelay = currentDelay;
    while (true) {
      res = await fetchFn(url);
      if (res.status === 429) {
        if (retries >= cfg.maxRetries) {
          logger.warn({ addr: shortAddr }, "Max retries exceeded on 429, giving up on wallet");
          return { inserted, skipped };
        }
        retryDelay = Math.min(retryDelay * 2, MAX_BACKOFF_MS);
        logger.warn({ addr: shortAddr, retryDelay }, "429 rate limited, backing off");
        await sleep(retryDelay);
        retries++;
        continue;
      }
      break;
    }
    // Reset delay after successful page
    currentDelay = cfg.rateLimitMs;

    if (!res.ok) {
      logger.warn({ addr: shortAddr, status: res.status }, "Helius request failed");
      return { inserted, skipped };
    }

    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length === 0) break;

    const txs = raw as HeliusTransaction[];

    for (const tx of txs) {
      // Stop if older than lookback cutoff
      if (tx.timestamp < lookbackCutoff) break page;

      const trade = parseSwapTx(tx, walletAddress, collectedAtMs);
      if (!trade) {
        skipped++;
        continue;
      }

      const wasInserted = store.upsertTrade(trade);
      if (wasInserted) inserted++;
      else skipped++;
    }

    // Paginate: set `before` to the last tx signature
    const lastTx = txs[txs.length - 1];
    if (!lastTx) break;

    // Check if oldest tx on this page is already past the cutoff
    if (lastTx.timestamp < lookbackCutoff) break;

    // If we got fewer than pageSize, we've exhausted results
    if (txs.length < cfg.pageSize) break;

    before = lastTx.signature;
  }

  logger.info({ addr: shortAddr, inserted, skipped }, "wallet trades collected");
  return { inserted, skipped };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function collectTradeHistory(
  cfg: TradeHistoryConfig,
  store: HarvesterStore,
  logger: Logger,
  fetchFn: FetchFn = (url) => fetch(url),
): Promise<TradeHistoryResult> {
  const startMs = Date.now();
  const addresses = store.getAllWalletAddresses();

  let walletsProcessed = 0;
  let walletsSkipped = 0;
  let walletsFailed = 0;
  let tradesInserted = 0;
  let tradesSkipped = 0;

  for (const address of addresses) {
    const state = store.getWalletTradeCollectionState(address);
    if (
      state.lastCollectedAt !== null &&
      Date.now() - state.lastCollectedAt < ONE_HOUR_MS
    ) {
      walletsSkipped++;
      logger.debug({ addr: address.slice(0, 12) }, "skipping — collected within last hour");
      continue;
    }

    try {
      const { inserted, skipped } = await collectWalletTrades(
        address,
        cfg,
        store,
        logger,
        fetchFn,
      );
      tradesInserted += inserted;
      tradesSkipped += skipped;
      walletsProcessed++;
    } catch (err: unknown) {
      walletsFailed++;
      logger.error({ addr: address.slice(0, 12), err }, "wallet trade collection failed");
    }
  }

  return {
    walletsProcessed,
    walletsSkipped,
    walletsFailed,
    tradesInserted,
    tradesSkipped,
    durationMs: Date.now() - startMs,
  };
}
