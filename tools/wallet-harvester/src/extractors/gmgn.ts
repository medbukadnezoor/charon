// ---------------------------------------------------------------------------
// Wallet Harvester — GMGN Smart Wallet Extractor
//
// For each discovered token, calls:
//   1. /v1/market/token_top_holders?tag=smart_degen  (weight 5)
//   2. /v1/market/token_top_holders?tag=renowned      (weight 5)
//   3. /v1/market/token_top_traders?tag=smart_degen   (weight 5)
//   4. /v1/market/token_top_traders?tag=renowned      (weight 5)
//
// Extracts wallet addresses, PnL, tags, and action metadata.
// ---------------------------------------------------------------------------

import type { HarvesterConfig } from "../config.js";
import type { DiscoveredToken, ExtractedWallet } from "../types.js";
import { gmgnGet, extractRows, num, str, isRecord } from "../discovery.js";
import pino from "pino";

const logger = pino({ name: "extractor:gmgn" });
const CLASSIFICATION_TAGS = new Set(["smart_degen", "renowned"]);

export function nullableGmgnNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNullableGmgnNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const n = nullableGmgnNumber(value);
    if (n !== null) return n;
  }
  return null;
}

export function gmgnHolderAmountUsd(row: Record<string, unknown>): number | null {
  const amount = firstNullableGmgnNumber(row.usd_value, row.amount_usd, row.value_usd);
  return amount !== null && amount > 0 ? amount : null;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .flatMap(item => {
        if (typeof item === "string") return [item];
        if (isRecord(item)) {
          const label = str(item.name) || str(item.label) || str(item.tag);
          return label ? [label] : [];
        }
        return [];
      })
      .map(item => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(/[,\|]/)
      .map(item => item.trim())
      .filter(Boolean);
  }

  return [];
}

function publicMetadataFromRow(row: Record<string, unknown>, tag: string): Pick<
  ExtractedWallet,
  "walletLabel" | "twitterUsername" | "twitterName" | "avatarUrl" | "providerTags" | "tokenTags" | "metadataSnapshotAt"
> {
  const providerTags = toStringArray(row.tags).filter(
    providerTag => providerTag !== tag && !CLASSIFICATION_TAGS.has(providerTag),
  );
  const tokenTags = toStringArray(row.maker_token_tags);
  const walletLabel = str(row.name) || null;
  const twitterUsername = str(row.twitter_username) || null;
  const twitterName = str(row.twitter_name) || null;
  const avatarUrl = str(row.avatar) || null;
  const hasMetadata = Boolean(
    walletLabel ||
    twitterUsername ||
    twitterName ||
    avatarUrl ||
    providerTags.length > 0 ||
    tokenTags.length > 0
  );

  return {
    walletLabel,
    twitterUsername,
    twitterName,
    avatarUrl,
    providerTags,
    tokenTags,
    metadataSnapshotAt: hasMetadata ? Date.now() : null,
  };
}

function mergeWalletMetadata(existing: ExtractedWallet, incoming: ExtractedWallet): void {
  existing.tags = [...new Set([...existing.tags, ...incoming.tags])];
  existing.providerTags = [...new Set([...(existing.providerTags ?? []), ...(incoming.providerTags ?? [])])];
  existing.tokenTags = [...new Set([...(existing.tokenTags ?? []), ...(incoming.tokenTags ?? [])])];

  existing.walletLabel = existing.walletLabel || incoming.walletLabel || null;
  existing.twitterUsername = existing.twitterUsername || incoming.twitterUsername || null;
  existing.twitterName = existing.twitterName || incoming.twitterName || null;
  existing.avatarUrl = existing.avatarUrl || incoming.avatarUrl || null;
  existing.metadataSnapshotAt = Math.max(existing.metadataSnapshotAt ?? 0, incoming.metadataSnapshotAt ?? 0) || null;
}

// ---------------------------------------------------------------------------
// Per-token extraction
// ---------------------------------------------------------------------------

async function extractHoldersByTag(
  cfg: HarvesterConfig,
  token: DiscoveredToken,
  tag: string,
): Promise<ExtractedWallet[]> {
  const wallets: ExtractedWallet[] = [];

  try {
    const data = await gmgnGet(
      cfg,
      `/v1/market/token_top_holders?chain=sol` +
      `&address=${encodeURIComponent(token.mint)}` +
      `&limit=${cfg.gmgnHolderLimit}` +
      `&order_by=amount_percentage&direction=desc` +
      `&tag=${encodeURIComponent(tag)}`,
    );
    const rows = extractRows(data);

    for (const row of rows) {
      const address = str(row.address) || str(row.wallet_address) || str(row.maker);
      if (!address) continue;

      wallets.push({
        address,
        source: "gmgn",
        tags: [tag as ExtractedWallet["tags"][number]],
        ...publicMetadataFromRow(row, tag),
        pnlUsd: nullableGmgnNumber(row.realized_profit),
        winRate: nullableGmgnNumber(row.win_rate),
        avgBuyUsd: nullableGmgnNumber(row.avg_cost),
        mint: token.mint,
        action: "hold",
        amountUsd: gmgnHolderAmountUsd(row),
        tokenMcapUsd: token.marketCapUsd,
        timestamp: (num(row.last_active_timestamp) * 1000) || token.createdAt || Date.now(),
        signalType: `${tag}_holder`,
      });
    }

    logger.debug({ mint: token.mint, tag, count: wallets.length }, "holders extracted");
  } catch (err) {
    logger.warn({ mint: token.mint, tag, err: String(err) }, "holder extraction failed");
  }

  return wallets;
}

async function extractTradersByTag(
  cfg: HarvesterConfig,
  token: DiscoveredToken,
  tag: string,
): Promise<ExtractedWallet[]> {
  const wallets: ExtractedWallet[] = [];

  try {
    const data = await gmgnGet(
      cfg,
      `/v1/market/token_top_traders?chain=sol` +
      `&address=${encodeURIComponent(token.mint)}` +
      `&limit=${cfg.gmgnTraderLimit}` +
      `&order_by=profit&direction=desc` +
      `&tag=${encodeURIComponent(tag)}`,
    );
    const rows = extractRows(data);

    for (const row of rows) {
      const address = str(row.address) || str(row.wallet_address) || str(row.maker);
      if (!address) continue;

      // Determine action from buy/sell volumes
      const buyVol = firstNullableGmgnNumber(row.buy_volume_cur, row.total_cost) ?? 0;
      const sellVol = firstNullableGmgnNumber(row.sell_volume_cur, row.total_revenue) ?? 0;
      const action = sellVol > buyVol ? "sell" as const : "buy" as const;

      wallets.push({
        address,
        source: "gmgn",
        tags: [tag as ExtractedWallet["tags"][number]],
        ...publicMetadataFromRow(row, tag),
        pnlUsd: nullableGmgnNumber(row.realized_profit),
        winRate: nullableGmgnNumber(row.win_rate),
        avgBuyUsd: nullableGmgnNumber(row.avg_cost),
        mint: token.mint,
        action,
        amountUsd: Math.max(buyVol, sellVol) || null,
        tokenMcapUsd: token.marketCapUsd,
        timestamp: (num(row.last_active_timestamp) * 1000) || Date.now(),
        signalType: `${tag}_trader`,
      });
    }

    logger.debug({ mint: token.mint, tag, count: wallets.length }, "traders extracted");
  } catch (err) {
    logger.warn({ mint: token.mint, tag, err: String(err) }, "trader extraction failed");
  }

  return wallets;
}

// ---------------------------------------------------------------------------
// Main GMGN extractor
// ---------------------------------------------------------------------------

export async function extractGmgnWallets(
  cfg: HarvesterConfig,
  token: DiscoveredToken,
): Promise<ExtractedWallet[]> {
  const allWallets: ExtractedWallet[] = [];

  // Run each tag query sequentially to respect rate limits (weight 5 each)
  for (const tag of cfg.gmgnTags) {
    const holders = await extractHoldersByTag(cfg, token, tag);
    allWallets.push(...holders);

    const traders = await extractTradersByTag(cfg, token, tag);
    allWallets.push(...traders);
  }

  // Deduplicate: same address on same token from same source → keep first
  const seen = new Set<string>();
  const deduped: ExtractedWallet[] = [];
  for (const w of allWallets) {
    const key = `${w.address}:${w.mint}:${w.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(w);
    } else {
      const existing = deduped.find(candidate => `${candidate.address}:${candidate.mint}:${candidate.source}` === key);
      if (existing) mergeWalletMetadata(existing, w);
    }
  }

  logger.info({
    mint: token.mint,
    symbol: token.symbol,
    raw: allWallets.length,
    deduped: deduped.length,
  }, "GMGN extraction complete");

  return deduped;
}
