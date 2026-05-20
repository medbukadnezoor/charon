// ---------------------------------------------------------------------------
// Wallet Harvester — Wallet Profile Enrichment
//
// Dry-run first wallet-level analytics enrichment for GMGN wallet_stats and
// optional OKX portfolio overview. This script does not load dotenv or read
// any env file; live credentials must already exist in the process env.
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { HarvesterConfig } from "./config.js";
import { gmgnGet, isRecord, str } from "./discovery.js";
import { okxGet, OkxRateLimitError } from "./extractors/okx.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SOLANA_CHAIN_INDEX = "501";
const GMGN_WALLET_BATCH_SIZE = 1;

const WALLET_PROFILE_SCHEMA = `
CREATE TABLE IF NOT EXISTS wallet_profiles (
  address                     TEXT PRIMARY KEY,
  gmgn_realized_profit_usd    REAL,
  gmgn_unrealized_profit_usd  REAL,
  gmgn_pnl_ratio              REAL,
  gmgn_winrate                REAL,
  gmgn_total_cost_usd         REAL,
  gmgn_buy_count              INTEGER,
  gmgn_sell_count             INTEGER,
  gmgn_tags                   TEXT NOT NULL DEFAULT '[]',
  gmgn_twitter_username       TEXT,
  gmgn_twitter_name           TEXT,
  gmgn_followers_count        INTEGER,
  gmgn_is_blue_verified       INTEGER,
  gmgn_created_token_count    INTEGER,
  gmgn_wallet_created_at      INTEGER,
  gmgn_period                 TEXT NOT NULL DEFAULT '7d',
  gmgn_snapshot_at            INTEGER NOT NULL,
  okx_realized_pnl_usd        REAL,
  okx_win_rate                REAL,
  okx_buy_tx_count            INTEGER,
  okx_sell_tx_count           INTEGER,
  okx_buy_tx_volume_usd       REAL,
  okx_sell_tx_volume_usd      REAL,
  okx_avg_buy_value_usd       REAL,
  okx_preferred_mcap          TEXT,
  okx_buys_by_mcap_json       TEXT,
  okx_token_count_by_pnl_json TEXT,
  okx_time_frame              TEXT NOT NULL DEFAULT '3',
  okx_snapshot_at             INTEGER
);

CREATE TABLE IF NOT EXISTS owner_labels (
  address        TEXT PRIMARY KEY,
  manual_label   TEXT,
  manual_notes   TEXT,
  labeled_at_ms  INTEGER NOT NULL
);
`;

interface Options {
  dbPath: string;
  dryRun: boolean;
  limit: number;
  okx: boolean;
  okxLimit: number;
  period: string;
  walletAddresses: string[];
}

interface WalletSelection {
  address: string;
  gmgn_snapshot_at: number | null;
  okx_snapshot_at: number | null;
}

interface GmgnProfile {
  address: string;
  gmgn_realized_profit_usd: number | null;
  gmgn_unrealized_profit_usd: number | null;
  gmgn_pnl_ratio: number | null;
  gmgn_winrate: number | null;
  gmgn_total_cost_usd: number | null;
  gmgn_buy_count: number | null;
  gmgn_sell_count: number | null;
  gmgn_tags: string[];
  gmgn_twitter_username: string | null;
  gmgn_twitter_name: string | null;
  gmgn_followers_count: number | null;
  gmgn_is_blue_verified: number | null;
  gmgn_created_token_count: number | null;
  gmgn_wallet_created_at: number | null;
  gmgn_period: string;
  gmgn_snapshot_at: number;
}

interface OkxProfile {
  address: string;
  okx_realized_pnl_usd: number | null;
  okx_win_rate: number | null;
  okx_buy_tx_count: number | null;
  okx_sell_tx_count: number | null;
  okx_buy_tx_volume_usd: number | null;
  okx_sell_tx_volume_usd: number | null;
  okx_avg_buy_value_usd: number | null;
  okx_preferred_mcap: string | null;
  okx_buys_by_mcap_json: string | null;
  okx_token_count_by_pnl_json: string | null;
  okx_time_frame: string;
  okx_snapshot_at: number;
}

function argValue(name: string, fallback = ""): string {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argNumber(name: string, fallback: number): number {
  const raw = argValue(name, "");
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function argCsv(name: string): string[] {
  return argValue(name, "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function nullableInteger(value: unknown): number | null {
  const n = nullableNumber(value);
  return n === null ? null : Math.trunc(n);
}

function jsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => {
    if (typeof item === "string") return item.trim();
    if (isRecord(item)) return str(item.name) || str(item.label) || str(item.tag);
    return "";
  }).filter(Boolean);
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function defaultDbPath(): string {
  return path.resolve(PROJECT_ROOT, "data", "harvester.db");
}

function loadOptions(): Options {
  return {
    dbPath: path.resolve(argValue("db", process.env.HARVESTER_DB_PATH || defaultDbPath())),
    dryRun: hasFlag("dry-run"),
    limit: Math.floor(argNumber("limit", 10)),
    okx: hasFlag("okx"),
    okxLimit: Math.floor(argNumber("okx-limit", 25)),
    period: argValue("period", "7d"),
    walletAddresses: argCsv("wallet-address"),
  };
}

function runtimeConfig(options: Options): HarvesterConfig {
  return {
    maxTokenAgeDays: 30,
    maxTokensPerRun: 30,
    trendingIntervals: ["1h", "6h", "24h"],
    gmgnHolderLimit: 50,
    gmgnTraderLimit: 50,
    gmgnTags: ["smart_degen", "renowned"],
    gmgnMinIntervalMs: Number(process.env.HARVESTER_GMGN_MIN_INTERVAL_MS || 500),
    okxMinIntervalMs: Number(process.env.HARVESTER_OKX_MIN_INTERVAL_MS || 1200),
    gmgnDailyCallCap: 2000,
    okxDailyCallCap: 500,
    okxMaxCallsPerRun: options.okxLimit,
    runIntervalHours: 4,
    dbPath: options.dbPath,
    reportDir: path.resolve(PROJECT_ROOT, "reports"),
    gmgnApiKey: process.env.GMGN_API_KEY || "",
    gmgnBaseUrl: process.env.GMGN_HOST || "https://openapi.gmgn.ai",
    okxApiKey: process.env.OKX_API_KEY || "",
    okxSecretKey: process.env.OKX_SECRET_KEY || "",
    okxPassphrase: process.env.OKX_PASSPHRASE || "",
    okxProjectId: process.env.OKX_PROJECT_ID || "",
    okxBaseUrl: process.env.OKX_BASE_URL || "https://web3.okx.com",
    heliusApiKey: "",
    heliusBaseUrl: "https://api.helius.xyz",
    tradeHistoryLookbackDays: 30,
    tradeHistoryRateLimitMs: 500,
    birdeyeApiKey: "",
    birdeyeBaseUrl: "https://public-api.birdeye.so",
    birdeyeDailyCuCap: 100000,
    discoverOnly: false,
    enableFullRun: false,
    enableOkxExtraction: options.okx,
    verbose: hasFlag("verbose"),
  };
}

function ensureSchema(db: Database.Database): void {
  db.exec(WALLET_PROFILE_SCHEMA);
}

function hasTable(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return Boolean(row);
}

function selectWallets(db: Database.Database, options: Options): WalletSelection[] {
  const hasProfiles = hasTable(db, "wallet_profiles");
  if (options.walletAddresses.length) {
    const placeholders = options.walletAddresses.map(() => "?").join(",");
    if (!hasProfiles) {
      return db.prepare(`
        SELECT w.address, NULL AS gmgn_snapshot_at, NULL AS okx_snapshot_at
        FROM wallets w
        WHERE w.address IN (${placeholders})
        ORDER BY w.address
      `).all(...options.walletAddresses) as WalletSelection[];
    }
    return db.prepare(`
      SELECT w.address, wp.gmgn_snapshot_at, wp.okx_snapshot_at
      FROM wallets w
      LEFT JOIN wallet_profiles wp ON wp.address = w.address
      WHERE w.address IN (${placeholders})
      ORDER BY w.address
    `).all(...options.walletAddresses) as WalletSelection[];
  }

  if (!hasProfiles) {
    return db.prepare(`
      SELECT w.address, NULL AS gmgn_snapshot_at, NULL AS okx_snapshot_at
      FROM wallets w
      ORDER BY w.token_count DESC, w.last_seen DESC
      LIMIT ?
    `).all(options.limit) as WalletSelection[];
  }

  return db.prepare(`
    SELECT w.address, wp.gmgn_snapshot_at, wp.okx_snapshot_at
    FROM wallets w
    LEFT JOIN wallet_profiles wp ON wp.address = w.address
    ORDER BY
      CASE WHEN wp.gmgn_snapshot_at IS NULL THEN 0 ELSE 1 END,
      wp.gmgn_snapshot_at ASC,
      w.token_count DESC,
      w.last_seen DESC
    LIMIT ?
  `).all(options.limit) as WalletSelection[];
}

function gmgnWalletStatsPath(addresses: string[], period: string): string {
  const params = new URLSearchParams();
  params.set("chain", "sol");
  params.set("period", period);
  for (const address of addresses) params.append("wallet_address", address);
  return `/v1/user/wallet_stats?${params.toString()}`;
}

function extractGmgnRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (!isRecord(data)) return [];
  if (isRecord(data.pnl_stat) || isRecord(data.common)) return [data];
  for (const key of ["list", "rows", "items", "wallets", "result", "results", "data"]) {
    const child = data[key];
    if (Array.isArray(child)) return child.filter(isRecord);
  }
  return Object.entries(data)
    .filter(([, value]) => isRecord(value))
    .map(([address, value]) => ({ address, ...(value as Record<string, unknown>) }));
}

function parseGmgnProfile(row: Record<string, unknown>, fallbackAddress: string | null, period: string, snapshotAt: number): GmgnProfile | null {
  const common = isRecord(row.common) ? row.common : {};
  const stats = isRecord(row.pnl_stat) ? row.pnl_stat : row;
  const address = str(row.address) || str(row.wallet_address) || str(row.walletAddress) || fallbackAddress;
  if (!address) return null;
  return {
    address,
    gmgn_realized_profit_usd: nullableNumber(stats.realized_profit),
    gmgn_unrealized_profit_usd: nullableNumber(stats.unrealized_profit),
    gmgn_pnl_ratio: nullableNumber(stats.pnl),
    gmgn_winrate: nullableNumber(stats.winrate),
    gmgn_total_cost_usd: nullableNumber(stats.total_cost),
    gmgn_buy_count: nullableInteger(stats.buy_count),
    gmgn_sell_count: nullableInteger(stats.sell_count),
    gmgn_tags: jsonArray(common.tags),
    gmgn_twitter_username: str(common.twitter_username) || null,
    gmgn_twitter_name: str(common.twitter_name) || null,
    gmgn_followers_count: nullableInteger(common.followers_count),
    gmgn_is_blue_verified: typeof common.is_blue_verified === "boolean" ? (common.is_blue_verified ? 1 : 0) : nullableInteger(common.is_blue_verified),
    gmgn_created_token_count: nullableInteger(common.created_token_count),
    gmgn_wallet_created_at: nullableInteger(common.created_at),
    gmgn_period: period,
    gmgn_snapshot_at: snapshotAt,
  };
}

function upsertGmgnProfiles(db: Database.Database, profiles: GmgnProfile[]): void {
  const stmt = db.prepare(`
    INSERT INTO wallet_profiles (
      address, gmgn_realized_profit_usd, gmgn_unrealized_profit_usd,
      gmgn_pnl_ratio, gmgn_winrate, gmgn_total_cost_usd, gmgn_buy_count,
      gmgn_sell_count, gmgn_tags, gmgn_twitter_username, gmgn_twitter_name,
      gmgn_followers_count, gmgn_is_blue_verified, gmgn_created_token_count,
      gmgn_wallet_created_at, gmgn_period, gmgn_snapshot_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      gmgn_realized_profit_usd = excluded.gmgn_realized_profit_usd,
      gmgn_unrealized_profit_usd = excluded.gmgn_unrealized_profit_usd,
      gmgn_pnl_ratio = excluded.gmgn_pnl_ratio,
      gmgn_winrate = excluded.gmgn_winrate,
      gmgn_total_cost_usd = excluded.gmgn_total_cost_usd,
      gmgn_buy_count = excluded.gmgn_buy_count,
      gmgn_sell_count = excluded.gmgn_sell_count,
      gmgn_tags = excluded.gmgn_tags,
      gmgn_twitter_username = excluded.gmgn_twitter_username,
      gmgn_twitter_name = excluded.gmgn_twitter_name,
      gmgn_followers_count = excluded.gmgn_followers_count,
      gmgn_is_blue_verified = excluded.gmgn_is_blue_verified,
      gmgn_created_token_count = excluded.gmgn_created_token_count,
      gmgn_wallet_created_at = excluded.gmgn_wallet_created_at,
      gmgn_period = excluded.gmgn_period,
      gmgn_snapshot_at = excluded.gmgn_snapshot_at
  `);
  const txn = db.transaction(() => {
    for (const profile of profiles) {
      stmt.run(
        profile.address,
        profile.gmgn_realized_profit_usd,
        profile.gmgn_unrealized_profit_usd,
        profile.gmgn_pnl_ratio,
        profile.gmgn_winrate,
        profile.gmgn_total_cost_usd,
        profile.gmgn_buy_count,
        profile.gmgn_sell_count,
        JSON.stringify(profile.gmgn_tags),
        profile.gmgn_twitter_username,
        profile.gmgn_twitter_name,
        profile.gmgn_followers_count,
        profile.gmgn_is_blue_verified,
        profile.gmgn_created_token_count,
        profile.gmgn_wallet_created_at,
        profile.gmgn_period,
        profile.gmgn_snapshot_at,
      );
    }
  });
  txn();
}

function okxMcapLabel(value: unknown): string | null {
  const text = String(value ?? "").trim();
  const labels: Record<string, string> = {
    "1": "<100K",
    "2": "100K-1M",
    "3": "1M-10M",
    "4": "10M-100M",
    "5": ">100M",
  };
  return labels[text] ?? (text || null);
}

function okxOverviewPath(address: string): string {
  return `/api/v6/dex/market/portfolio/overview?chainIndex=${SOLANA_CHAIN_INDEX}&walletAddress=${encodeURIComponent(address)}&timeFrame=3`;
}

function parseOkxProfile(address: string, data: unknown, snapshotAt: number): OkxProfile | null {
  const row = Array.isArray(data) ? data.find(isRecord) : data;
  if (!isRecord(row)) return null;
  return {
    address,
    okx_realized_pnl_usd: nullableNumber(row.realizedPnlUsd),
    okx_win_rate: nullableNumber(row.winRate),
    okx_buy_tx_count: nullableInteger(row.buyTxCount),
    okx_sell_tx_count: nullableInteger(row.sellTxCount),
    okx_buy_tx_volume_usd: nullableNumber(row.buyTxVolume),
    okx_sell_tx_volume_usd: nullableNumber(row.sellTxVolume),
    okx_avg_buy_value_usd: nullableNumber(row.avgBuyValueUsd),
    okx_preferred_mcap: okxMcapLabel(row.preferredMarketCap),
    okx_buys_by_mcap_json: row.buysByMarketCap == null ? null : JSON.stringify(row.buysByMarketCap),
    okx_token_count_by_pnl_json: row.tokenCountByPnlPercent == null ? null : JSON.stringify(row.tokenCountByPnlPercent),
    okx_time_frame: "3",
    okx_snapshot_at: snapshotAt,
  };
}

function upsertOkxProfile(db: Database.Database, profile: OkxProfile): void {
  db.prepare(`
    UPDATE wallet_profiles SET
      okx_realized_pnl_usd = ?,
      okx_win_rate = ?,
      okx_buy_tx_count = ?,
      okx_sell_tx_count = ?,
      okx_buy_tx_volume_usd = ?,
      okx_sell_tx_volume_usd = ?,
      okx_avg_buy_value_usd = ?,
      okx_preferred_mcap = ?,
      okx_buys_by_mcap_json = ?,
      okx_token_count_by_pnl_json = ?,
      okx_time_frame = ?,
      okx_snapshot_at = ?
    WHERE address = ?
  `).run(
    profile.okx_realized_pnl_usd,
    profile.okx_win_rate,
    profile.okx_buy_tx_count,
    profile.okx_sell_tx_count,
    profile.okx_buy_tx_volume_usd,
    profile.okx_sell_tx_volume_usd,
    profile.okx_avg_buy_value_usd,
    profile.okx_preferred_mcap,
    profile.okx_buys_by_mcap_json,
    profile.okx_token_count_by_pnl_json,
    profile.okx_time_frame,
    profile.okx_snapshot_at,
    profile.address,
  );
}

async function enrichGmgn(db: Database.Database, cfg: HarvesterConfig, wallets: WalletSelection[], options: Options): Promise<number> {
  let stored = 0;
  for (const [index, batch] of chunk(wallets, GMGN_WALLET_BATCH_SIZE).entries()) {
    const addresses = batch.map(wallet => wallet.address);
    if (options.dryRun) {
      console.log(JSON.stringify({
        provider: "gmgn",
        mode: "dry-run",
        batch: index + 1,
        wallet_count: addresses.length,
        addresses: addresses.map(shortAddress),
        period: options.period,
      }));
      continue;
    }
    if (!cfg.gmgnApiKey) throw new Error("GMGN_API_KEY is not set in the process environment");
    const snapshotAt = Date.now();
    const data = await gmgnGet(cfg, gmgnWalletStatsPath(addresses, options.period));
    const rows = extractGmgnRows(data);
    const profiles = rows
      .map((row, rowIndex) => parseGmgnProfile(row, addresses[rowIndex] ?? null, options.period, snapshotAt))
      .filter((profile): profile is GmgnProfile => profile !== null);
    upsertGmgnProfiles(db, profiles);
    stored += profiles.length;
    console.log(JSON.stringify({
      provider: "gmgn",
      batch: index + 1,
      wallet_count: addresses.length,
      stored: profiles.length,
      snapshot_at: snapshotAt,
    }));
  }
  return stored;
}

function selectOkxWallets(db: Database.Database, wallets: WalletSelection[], okxLimit: number): WalletSelection[] {
  if (!hasTable(db, "wallet_profiles")) return [];
  const addresses = wallets.map(wallet => wallet.address);
  if (!addresses.length) return [];
  const placeholders = addresses.map(() => "?").join(",");
  return db.prepare(`
    SELECT w.address, wp.gmgn_snapshot_at, wp.okx_snapshot_at
    FROM wallets w
    JOIN wallet_profiles wp ON wp.address = w.address
    WHERE w.address IN (${placeholders})
      AND wp.gmgn_snapshot_at IS NOT NULL
    ORDER BY
      CASE WHEN wp.okx_snapshot_at IS NULL THEN 0 ELSE 1 END,
      wp.okx_snapshot_at ASC
    LIMIT ?
  `).all(...addresses, okxLimit) as WalletSelection[];
}

async function enrichOkx(db: Database.Database, cfg: HarvesterConfig, wallets: WalletSelection[], options: Options): Promise<number> {
  const okxWallets = options.dryRun ? wallets.slice(0, options.okxLimit) : selectOkxWallets(db, wallets, options.okxLimit);
  let stored = 0;
  for (const wallet of okxWallets) {
    if (options.dryRun) {
      console.log(JSON.stringify({
        provider: "okx",
        mode: "dry-run",
        wallet: shortAddress(wallet.address),
        time_frame: "3",
      }));
      continue;
    }
    if (!cfg.okxApiKey || !cfg.okxSecretKey || !cfg.okxPassphrase || !cfg.okxProjectId) {
      throw new Error("OKX credentials are not fully set in the process environment");
    }
    try {
      const snapshotAt = Date.now();
      const data = await okxGet(cfg, okxOverviewPath(wallet.address));
      const profile = parseOkxProfile(wallet.address, data, snapshotAt);
      if (profile) {
        upsertOkxProfile(db, profile);
        stored++;
      }
      console.log(JSON.stringify({
        provider: "okx",
        wallet: shortAddress(wallet.address),
        stored: profile ? 1 : 0,
        snapshot_at: snapshotAt,
      }));
    } catch (err) {
      if (err instanceof OkxRateLimitError || String(err).includes("50011") || String(err).includes("429")) {
        console.warn(JSON.stringify({ provider: "okx", stopped: true, reason: "rate_limited" }));
        break;
      }
      throw err;
    }
  }
  return stored;
}

async function main(): Promise<void> {
  const options = loadOptions();
  if (!fs.existsSync(options.dbPath)) throw new Error(`Harvester DB not found: ${options.dbPath}`);
  const cfg = runtimeConfig(options);
  const db = new Database(options.dbPath, options.dryRun ? { readonly: true } : {});
  try {
    if (!options.dryRun) ensureSchema(db);
    const wallets = selectWallets(db, options);
    console.log(JSON.stringify({
      mode: options.dryRun ? "dry-run" : "commit",
      db_path: options.dbPath,
      selected_wallets: wallets.length,
      gmgn_batches: Math.ceil(wallets.length / GMGN_WALLET_BATCH_SIZE),
      okx_enabled: options.okx,
      okx_limit: options.okxLimit,
      period: options.period,
    }));
    const gmgnStored = await enrichGmgn(db, cfg, wallets, options);
    const okxStored = options.okx ? await enrichOkx(db, cfg, wallets, options) : 0;
    console.log(JSON.stringify({ done: true, gmgn_stored: gmgnStored, okx_stored: okxStored }));
  } finally {
    db.close();
  }
}

await main();
