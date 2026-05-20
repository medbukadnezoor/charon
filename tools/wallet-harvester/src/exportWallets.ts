// ---------------------------------------------------------------------------
// Wallet Harvester — Wallet Review CSV Export
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { HarvesterStore } from "./store.js";

const GMGN_SOL_ADDRESS_BASE = "https://gmgn.ai/sol/address";

function csvCell(value: unknown): string {
  if (value == null) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function argInt(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function writeWalletCsv(): string {
  const cfg = loadConfig();
  const store = new HarvesterStore(cfg.dbPath);
  const limit = argInt("limit", 2000);
  const rows = store.getWalletReviewRows(limit);

  if (!fs.existsSync(cfg.reportDir)) fs.mkdirSync(cfg.reportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filepath = path.resolve(cfg.reportDir, `wallet-review-${timestamp}.csv`);
  const header = [
    "wallet_address",
    "gmgn_url",
    "wallet_label",
    "twitter_username",
    "twitter_name",
    "avatar_url",
    "provider_tags",
    "token_tags",
    "metadata_snapshot_at_iso",
    "source_type",
    "sources",
    "tags",
    "token_count",
    "total_sightings",
    "gmgn_sightings",
    "okx_sightings",
    "pnl_usd",
    "win_rate",
    "avg_buy_usd",
    "first_seen_iso",
    "last_seen_iso",
    "review_status",
    "review_notes",
  ];

  const lines = [
    header.join(","),
    ...rows.map(row => [
      row.address,
      `${GMGN_SOL_ADDRESS_BASE}/${row.address}`,
      row.walletLabel,
      row.twitterUsername,
      row.twitterName,
      row.avatarUrl,
      row.providerTags.join("|"),
      row.tokenTags.join("|"),
      row.metadataSnapshotAt ? new Date(row.metadataSnapshotAt).toISOString() : "",
      row.sourceType,
      row.sources.join("|"),
      row.tags.join("|"),
      row.tokenCount,
      row.totalSightings,
      row.gmgnSightings,
      row.okxSightings,
      row.pnlUsd,
      row.winRate,
      row.avgBuyUsd,
      new Date(row.firstSeen).toISOString(),
      new Date(row.lastSeen).toISOString(),
      "",
      "",
    ].map(csvCell).join(",")),
  ];

  fs.writeFileSync(filepath, `${lines.join("\n")}\n`);
  store.close();
  return filepath;
}

const filepath = writeWalletCsv();
console.log(`Wallet review CSV written: ${filepath}`);
