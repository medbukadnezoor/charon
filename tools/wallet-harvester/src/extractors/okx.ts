// ---------------------------------------------------------------------------
// Wallet Harvester — OKX OnchainOS Smart Wallet Extractor
//
// Uses two OKX endpoints:
//   1. GET /api/v6/dex/market/leaderboard/list
//      - walletType=1 (KOL), walletType=3 (Smart Money)
//      - Provides wallet addresses + PnL + win rate
//
//   2. GET /api/v6/dex/market/address-tracker/trades
//      - trackerType=1 (smart_money), trackerType=2 (kol)
//      - Provides recent trades with token addresses
//
// OKX signed REST requires:
// OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, OKX_PROJECT_ID
// ---------------------------------------------------------------------------

import crypto from "node:crypto";
import type { HarvesterConfig } from "../config.js";
import type { ExtractedWallet, DiscoveredToken } from "../types.js";
import pino from "pino";

const logger = pino({ name: "extractor:okx" });

const SOLANA_CHAIN_INDEX = "501";

export interface OkxExtractionResult {
  wallets: ExtractedWallet[];
  callsUsed: number;
  rateLimitHits: number;
  stoppedEarly: boolean;
}

export class OkxRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxRateLimitError";
  }
}

class OkxCallCapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxCallCapError";
  }
}

const okxRunState = {
  callsUsed: 0,
  rateLimitHits: 0,
  stoppedEarly: false,
};

// ---------------------------------------------------------------------------
// OKX signed request helper
// ---------------------------------------------------------------------------

let nextOkxSlot = 0;

async function okxPace(minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextOkxSlot - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  nextOkxSlot = Date.now() + minIntervalMs;
}

function okxSign(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
  secretKey: string,
): string {
  const prehash = timestamp + method.toUpperCase() + requestPath + body;
  return crypto.createHmac("sha256", secretKey).update(prehash).digest("base64");
}

export async function okxGet(cfg: HarvesterConfig, path: string): Promise<unknown> {
  if (okxRunState.callsUsed >= cfg.okxMaxCallsPerRun) {
    okxRunState.stoppedEarly = true;
    throw new OkxCallCapError(`OKX call cap reached (${cfg.okxMaxCallsPerRun})`);
  }

  await okxPace(cfg.okxMinIntervalMs);
  okxRunState.callsUsed++;

  const timestamp = new Date().toISOString();
  const sign = okxSign(timestamp, "GET", path, "", cfg.okxSecretKey);

  const url = `${cfg.okxBaseUrl}${path}`;
  const res = await fetch(url, {
    headers: {
      "OK-ACCESS-KEY": cfg.okxApiKey,
      "OK-ACCESS-SIGN": sign,
      "OK-ACCESS-PASSPHRASE": cfg.okxPassphrase,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PROJECT": cfg.okxProjectId,
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 429 || text.includes("50011")) {
      okxRunState.rateLimitHits++;
      okxRunState.stoppedEarly = true;
      throw new OkxRateLimitError(`OKX rate limited (${res.status})`);
    }
    throw new Error(`OKX ${res.status}: ${text.slice(0, 120)}`);
  }

  const json = await res.json() as Record<string, unknown>;
  if (json.code !== "0" && json.code !== 0) {
    if (json.code === "50011" || json.code === 50011) {
      okxRunState.rateLimitHits++;
      okxRunState.stoppedEarly = true;
      throw new OkxRateLimitError("OKX rate limited (50011)");
    }
    const msg = typeof json.msg === "string" ? json.msg : "unknown provider error";
    throw new Error(`OKX error ${String(json.code)}: ${msg.slice(0, 120)}`);
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Leaderboard extraction (global, not per-token)
// ---------------------------------------------------------------------------

async function extractLeaderboard(
  cfg: HarvesterConfig,
  walletType: number,
  label: string,
): Promise<ExtractedWallet[]> {
  const wallets: ExtractedWallet[] = [];

  // Query across multiple timeframes and sort orders for broader coverage.
  for (const timeFrame of ["1", "2", "3", "4"]) {
    for (const sortBy of ["1", "2", "4", "5"]) {
      if (okxRunState.stoppedEarly) break;

      try {
        const path = `/api/v6/dex/market/leaderboard/list` +
          `?chainIndex=${SOLANA_CHAIN_INDEX}` +
          `&timeFrame=${timeFrame}` +
          `&sortBy=${sortBy}` +
          `&walletType=${walletType}`;

        const data = await okxGet(cfg, path);
        const rows = Array.isArray(data) ? data : [];

        for (const row of rows) {
          if (!isRecord(row)) continue;
          const address = str(row.walletAddress);
          if (!address) continue;

          wallets.push({
            address,
            source: "okx",
            tags: [label as ExtractedWallet["tags"][number]],
            pnlUsd: isFinite(num(row.realizedPnlUsd)) ? num(row.realizedPnlUsd) : null,
            winRate: isFinite(num(row.winRatePercent)) ? num(row.winRatePercent) / 100 : null,
            avgBuyUsd: isFinite(num(row.avgBuyValueUsd)) ? num(row.avgBuyValueUsd) : null,
            // Leaderboard is global — no specific token context
            mint: "",
            action: "buy",
            amountUsd: isFinite(num(row.txVolume)) ? num(row.txVolume) : null,
            tokenMcapUsd: null,
            timestamp: num(row.lastActiveTimestamp) || Date.now(),
            signalType: `${label}_leaderboard`,
          });
        }

        logger.debug({ walletType, timeFrame, sortBy, count: rows.length }, "leaderboard page");
      } catch (err) {
        if (err instanceof OkxRateLimitError || err instanceof OkxCallCapError) {
          logger.warn({ walletType, timeFrame, sortBy, err: err.message }, "leaderboard scan stopped");
          okxRunState.stoppedEarly = true;
          break;
        }
        logger.warn({ walletType, timeFrame, sortBy, err: String(err) }, "leaderboard query failed");
      }
    }
  }

  // Deduplicate by address (same wallet may appear in multiple timeframes)
  const seen = new Map<string, ExtractedWallet>();
  for (const w of wallets) {
    if (!seen.has(w.address)) {
      seen.set(w.address, w);
    }
  }

  const result = [...seen.values()];
  logger.info({ walletType, label, count: result.length }, "leaderboard extraction complete");
  return result;
}

// ---------------------------------------------------------------------------
// Address tracker trades (recent SM/KOL trades, maps back to tokens)
// ---------------------------------------------------------------------------

async function extractTrackerTrades(
  cfg: HarvesterConfig,
  trackerType: number,
  label: string,
  discoveredMints: Set<string>,
  tradeType?: "1" | "2",
): Promise<ExtractedWallet[]> {
  const wallets: ExtractedWallet[] = [];

  try {
    const path = `/api/v6/dex/market/address-tracker/trades` +
      `?trackerType=${trackerType}` +
      `&chainIndex=${SOLANA_CHAIN_INDEX}` +
      (tradeType ? `&tradeType=${tradeType}` : "");

    const data = await okxGet(cfg, path);

    // Response shape: { trades: [...] }, { transactionList: [...] }, or array.
    let trades: unknown[] = [];
    if (isRecord(data) && Array.isArray(data.trades)) {
      trades = data.trades;
    } else if (isRecord(data) && Array.isArray(data.transactionList)) {
      trades = data.transactionList;
    } else if (Array.isArray(data)) {
      trades = data;
    }

    for (const trade of trades) {
      if (!isRecord(trade)) continue;
      const address = str(trade.walletAddress);
      const mint = str(trade.tokenContractAddress);
      if (!address || !mint) continue;

      // Optionally filter to only tokens we discovered (for targeted extraction)
      // If discoveredMints is empty, accept all
      if (discoveredMints.size > 0 && !discoveredMints.has(mint)) continue;

      const tradeType = str(trade.tradeType);
      const action = tradeType === "2" ? "sell" as const : "buy" as const;

      wallets.push({
        address,
        source: "okx",
        tags: [label as ExtractedWallet["tags"][number]],
        pnlUsd: isFinite(num(trade.realizedPnlUsd)) ? num(trade.realizedPnlUsd) : null,
        winRate: null,
        avgBuyUsd: null,
        mint,
        action,
        amountUsd: isFinite(num(trade.valueUsd)) ? num(trade.valueUsd) : null,
        tokenMcapUsd: isFinite(num(trade.marketCap)) ? num(trade.marketCap) : null,
        timestamp: num(trade.tradeTime) || Date.now(),
        signalType: `${label}_trade`,
      });
    }

    logger.info({ trackerType, tradeType, label, count: wallets.length }, "tracker trades extracted");
  } catch (err) {
    if (err instanceof OkxRateLimitError || err instanceof OkxCallCapError) {
      logger.warn({ trackerType, tradeType, label, err: err.message }, "tracker trades scan stopped");
      okxRunState.stoppedEarly = true;
    } else {
      logger.warn({ trackerType, tradeType, label, err: String(err) }, "tracker trades failed");
    }
  }

  return wallets;
}

// ---------------------------------------------------------------------------
// Main OKX extractor
// ---------------------------------------------------------------------------

/**
 * Extract OKX smart wallet data. Unlike GMGN, OKX extraction is mostly global
 * (leaderboard) or stream-based (tracker trades), not per-token. We call it
 * once per run, not once per discovered token.
 */
export async function extractOkxWallets(
  cfg: HarvesterConfig,
  discoveredTokens: DiscoveredToken[],
): Promise<OkxExtractionResult> {
  okxRunState.callsUsed = 0;
  okxRunState.rateLimitHits = 0;
  okxRunState.stoppedEarly = false;

  if (!cfg.okxApiKey || !cfg.okxSecretKey || !cfg.okxPassphrase || !cfg.okxProjectId) {
    logger.warn("OKX credentials not configured, skipping OKX extraction");
    return { wallets: [], callsUsed: 0, rateLimitHits: 0, stoppedEarly: false };
  }

  const discoveredMints = new Set(discoveredTokens.map(t => t.mint));
  const allWallets: ExtractedWallet[] = [];

  // 1. Leaderboard: Smart Money (walletType=3) and KOL (walletType=1)
  const smartMoneyLeaderboard = await extractLeaderboard(cfg, 3, "smart_money");
  allWallets.push(...smartMoneyLeaderboard);

  const kolLeaderboard = await extractLeaderboard(cfg, 1, "kol");
  allWallets.push(...kolLeaderboard);

  const pumpSmartMoneyLeaderboard = await extractLeaderboard(cfg, 10, "pump_smart_money");
  allWallets.push(...pumpSmartMoneyLeaderboard);

  // 2. Tracker trades: smart_money (trackerType=1) and kol (trackerType=2)
  const smartMoneyTrades: ExtractedWallet[] = [];
  const kolTrades: ExtractedWallet[] = [];

  for (const tradeType of ["1", "2"] as const) {
    if (okxRunState.stoppedEarly) break;
    smartMoneyTrades.push(...await extractTrackerTrades(cfg, 1, "smart_money", discoveredMints, tradeType));
  }

  for (const tradeType of ["1", "2"] as const) {
    if (okxRunState.stoppedEarly) break;
    kolTrades.push(...await extractTrackerTrades(cfg, 2, "kol", discoveredMints, tradeType));
  }

  allWallets.push(...smartMoneyTrades, ...kolTrades);

  // Deduplicate by address+mint+source
  const seen = new Set<string>();
  const deduped: ExtractedWallet[] = [];
  for (const w of allWallets) {
    const key = `${w.address}:${w.mint}:${w.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(w);
    }
  }

  logger.info({
    leaderboard: smartMoneyLeaderboard.length + kolLeaderboard.length + pumpSmartMoneyLeaderboard.length,
    trades: smartMoneyTrades.length + kolTrades.length,
    deduped: deduped.length,
    callsUsed: okxRunState.callsUsed,
    rateLimitHits: okxRunState.rateLimitHits,
    stoppedEarly: okxRunState.stoppedEarly,
  }, "OKX extraction complete");

  return {
    wallets: deduped,
    callsUsed: okxRunState.callsUsed,
    rateLimitHits: okxRunState.rateLimitHits,
    stoppedEarly: okxRunState.stoppedEarly,
  };
}
