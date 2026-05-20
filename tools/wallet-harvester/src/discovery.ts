// ---------------------------------------------------------------------------
// Wallet Harvester — Token Discovery
//
// Discovers trending meme tokens from GMGN that match the harvester filters:
//   - Solana only
//   - Market cap recorded as enrichment, not used as a gate
//   - Created within maxTokenAgeDays
//   - Sorted by volume
//
// Discovery sources:
//   1. GMGN /v1/market/rank (trending by volume across intervals)
//   2. GMGN /v1/trenches (new tokens sorted by smart_degen_count)
//   3. GMGN /v1/market/token_signal (smart money buy signals, type 12)
// ---------------------------------------------------------------------------

import type { HarvesterConfig } from "./config.js";
import type { DiscoveredToken } from "./types.js";
import { randomUUID } from "node:crypto";
import pino from "pino";

const logger = pino({ name: "discovery" });

// ---------------------------------------------------------------------------
// GMGN HTTP client (minimal, self-contained)
// ---------------------------------------------------------------------------

let nextGmgnSlot = 0;

async function gmgnPace(minIntervalMs: number): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextGmgnSlot - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  nextGmgnSlot = Date.now() + minIntervalMs;
}

async function gmgnGet(cfg: HarvesterConfig, pathname: string): Promise<unknown> {
  await gmgnPace(cfg.gmgnMinIntervalMs);
  const url = new URL(pathname, cfg.gmgnBaseUrl);
  addGmgnNormalAuthQuery(url);

  const res = await fetch(url.toString(), {
    headers: {
      "Content-Type": "application/json",
      "X-APIKEY": cfg.gmgnApiKey,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GMGN ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as Record<string, unknown>;
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`GMGN error: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return unwrapGmgnPayload(json);
}

async function gmgnPost(cfg: HarvesterConfig, pathname: string, body: unknown): Promise<unknown> {
  await gmgnPace(cfg.gmgnMinIntervalMs);
  const url = new URL(pathname, cfg.gmgnBaseUrl);
  addGmgnNormalAuthQuery(url);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-APIKEY": cfg.gmgnApiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GMGN POST ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json() as Record<string, unknown>;
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(`GMGN error: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return unwrapGmgnPayload(json);
}

function addGmgnNormalAuthQuery(url: URL): void {
  url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000)));
  url.searchParams.set("client_id", randomUUID());
}

function unwrapGmgnPayload(payload: unknown): unknown {
  let current = payload;
  while (
    isRecord(current) &&
    current.code === 0 &&
    isRecord(current.data) &&
    "code" in current.data &&
    "data" in current.data
  ) {
    current = current.data;
  }

  if (isRecord(current) && "data" in current) {
    return current.data;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Parsing helpers
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

/** Extract rows from a typical GMGN response shape (data.rank / data.list / array) */
function extractRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  for (const key of ["rank", "list", "items", "rows", "tokens", "trends", "result", "results", "data"]) {
    const child = data[key];
    if (Array.isArray(child)) return child.filter(isRecord);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Discovery sources
// ---------------------------------------------------------------------------

async function discoverTrending(cfg: HarvesterConfig): Promise<DiscoveredToken[]> {
  const allTokens: DiscoveredToken[] = [];

  for (const interval of cfg.trendingIntervals) {
    try {
      const data = await gmgnGet(
        cfg,
        `/v1/market/rank?chain=sol&interval=${interval}&limit=50&order_by=volume&direction=desc`,
      );
      const rows = extractRows(data);
      for (const row of rows) {
        const token = rowToToken(row, "trending");
        if (token && passesFilters(token, cfg)) {
          allTokens.push(token);
        }
      }
      logger.info({ interval, count: rows.length }, "trending scan complete");
    } catch (err) {
      logger.error({ interval, err: String(err) }, "trending scan failed");
    }
  }

  return allTokens;
}

async function discoverTrenches(cfg: HarvesterConfig): Promise<DiscoveredToken[]> {
  const tokens: DiscoveredToken[] = [];

  try {
    const data = await gmgnPost(cfg, `/v1/trenches?chain=sol`, {
      chain: "sol",
      type: ["new_creation", "near_completion", "completed"],
      launchpad_platform: [],
      limit: 50,
      filter_preset: "safe",
      min_smart_degen_count: 1,
      sort_by: "smart_degen_count",
    });
    const rows = extractRows(data);
    for (const row of rows) {
      const token = rowToToken(row, "trenches");
      if (token && passesFilters(token, cfg)) {
        tokens.push(token);
      }
    }
    logger.info({ count: rows.length }, "trenches scan complete");
  } catch (err) {
    logger.error({ err: String(err) }, "trenches scan failed");
  }

  return tokens;
}

async function discoverSignals(cfg: HarvesterConfig): Promise<DiscoveredToken[]> {
  const tokens: DiscoveredToken[] = [];

  try {
    const data = await gmgnPost(cfg, "/v1/market/token_signal", {
      chain: "sol",
      groups: [{ signal_type: [12] }],  // SignalTypeSmartDegenBuy
      limit: 50,
    });
    const rows = extractRows(data);
    for (const row of rows) {
      // Signal rows have different shape — token_address instead of address
      const mint = str(row.token_address) || str(row.address) || str(row.mint);
      if (!mint) continue;

      const token: DiscoveredToken = {
        mint,
        symbol: str(row.symbol) || str(row.token_symbol) || "?",
        name: str(row.name) || str(row.token_name) || "",
        chain: "sol",
        marketCapUsd: num(row.market_cap) || num(row.marketCap),
        volume24hUsd: num(row.volume_24h) || num(row.volume),
        holderCount: num(row.holder_count) || num(row.holderCount),
        smartWalletCount: 0,
        kolCount: 0,
        createdAt: (num(row.open_timestamp) || num(row.created_at) || num(row.createTime)) * 1000 || 0,
        discoverySource: "gmgn",
        discoveryMethod: "signal",
      };

      // Populate wallet stats from cur_data if present
      if (isRecord(row.cur_data)) {
        token.holderCount = num(row.cur_data.holder_count) || token.holderCount;
      }

      if (passesFilters(token, cfg)) {
        tokens.push(token);
      }
    }
    logger.info({ count: rows.length }, "signal scan complete");
  } catch (err) {
    logger.error({ err: String(err) }, "signal scan failed");
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Row parser + filters
// ---------------------------------------------------------------------------

function rowToToken(row: Record<string, unknown>, method: string): DiscoveredToken | null {
  const mint = str(row.address) || str(row.mint) || str(row.token_address);
  if (!mint) return null;

  // wallet_tags_stat for smart/kol counts
  const walletTags = isRecord(row.wallet_tags_stat) ? row.wallet_tags_stat : {};

  return {
    mint,
    symbol: str(row.symbol) || "?",
    name: str(row.name) || "",
    chain: "sol",
    marketCapUsd: num(row.market_cap) || num(row.marketCap) || num(row.usd_market_cap),
    volume24hUsd: num(row.volume_24h) || num(row.volume) || num(row.volumeUsd),
    holderCount: num(row.holder_count) || num(row.holderCount),
    smartWalletCount: num(walletTags.smart_wallets) || num(row.smart_degen_count),
    kolCount: num(walletTags.renowned_wallets) || num(row.renowned_count),
    createdAt: (num(row.open_timestamp) || num(row.creation_timestamp) || num(row.created_at)) * 1000 || 0,
    discoverySource: "gmgn",
    discoveryMethod: method,
  };
}

function passesFilters(token: DiscoveredToken, cfg: HarvesterConfig): boolean {
  // Market cap is data enrichment, not a filter — if it's trending, harvest it.
  // Age filter only (skip if createdAt is unknown)
  if (token.createdAt > 0) {
    const ageDays = (Date.now() - token.createdAt) / (1000 * 60 * 60 * 24);
    if (ageDays > cfg.maxTokenAgeDays) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main discovery function
// ---------------------------------------------------------------------------

export async function discoverTokens(cfg: HarvesterConfig): Promise<DiscoveredToken[]> {
  logger.info("starting token discovery");

  const [trending, trenches, signals] = await Promise.all([
    discoverTrending(cfg),
    discoverTrenches(cfg),
    discoverSignals(cfg),
  ]);

  // Deduplicate by mint address (keep first occurrence which has richer data)
  const seen = new Map<string, DiscoveredToken>();
  for (const token of [...trending, ...trenches, ...signals]) {
    if (!seen.has(token.mint)) {
      seen.set(token.mint, token);
    } else {
      // Merge: upgrade volume/mcap if the duplicate has better data
      const existing = seen.get(token.mint)!;
      if (token.volume24hUsd > existing.volume24hUsd) {
        existing.volume24hUsd = token.volume24hUsd;
      }
      if (token.smartWalletCount > existing.smartWalletCount) {
        existing.smartWalletCount = token.smartWalletCount;
      }
      if (token.kolCount > existing.kolCount) {
        existing.kolCount = token.kolCount;
      }
    }
  }

  // Sort by volume descending, cap at maxTokensPerRun
  const result = [...seen.values()]
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, cfg.maxTokensPerRun);

  logger.info({
    trending: trending.length,
    trenches: trenches.length,
    signals: signals.length,
    deduplicated: seen.size,
    final: result.length,
  }, "discovery complete");

  return result;
}

/** Re-export for use in extractors */
export { gmgnGet, gmgnPost, gmgnPace, extractRows, num, str, isRecord };
