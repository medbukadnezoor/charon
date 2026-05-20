import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig, PROJECT_ROOT_PATH } from "./config.js";
import { HarvesterStore } from "./store.js";
import type { Source, WalletTag } from "./types.js";

export type SeedSpeciesMode = "shadow_candidate_feature";

export interface ExportSeedListOptions {
  dbPath: string;
  outputDir: string;
  limit?: number;
  minTokenCount?: number;
  minSightings?: number;
  generatedAt?: Date;
  listId?: string;
}

interface SeedWalletQueryRow {
  address: string;
  sources: string;
  tags: string;
  token_count: number;
  pnl_usd: number | null;
  win_rate: number | null;
  avg_buy_usd: number | null;
  first_seen: number;
  last_seen: number;
  total_sightings: number;
  gmgn_sightings: number | null;
  okx_sightings: number | null;
  distinct_mints: number;
  buy_sightings: number | null;
  sell_sightings: number | null;
  hold_sightings: number | null;
}

export interface SeedWallet {
  rank: number;
  walletAddress: string;
  sourceType: "dual" | "gmgn_only" | "okx_only" | "unknown";
  sources: Source[];
  tags: WalletTag[];
  tokenCount: number;
  totalSightings: number;
  distinctMints: number;
  gmgnSightings: number;
  okxSightings: number;
  buySightings: number;
  sellSightings: number;
  holdSightings: number;
  pnlUsd: number | null;
  winRate: number | null;
  avgBuyUsd: number | null;
  firstSeen: string;
  lastSeen: string;
  selectionScore: number;
}

export interface SmartWalletSeedList {
  schemaVersion: 1;
  listId: string;
  generatedAt: string;
  status: "shadow_only";
  species: {
    speciesId: "smart-wallet-seed-shadow";
    mode: SeedSpeciesMode;
    edgeChannel: "entry_selection";
    promotionEligible: false;
    hotPathAllowed: false;
    requiresOperatorReview: true;
  };
  source: {
    dbPath: string;
    tool: "tools/wallet-harvester";
    selectionPolicy: {
      limit: number;
      minTokenCount: number;
      minSightings: number;
      ranking: string[];
    };
  };
  counts: {
    walletsSelected: number;
    dualSourceWallets: number;
    gmgnOnlyWallets: number;
    okxOnlyWallets: number;
  };
  guardrails: string[];
  contentHash: string;
  wallets: SeedWallet[];
}

export interface ExportSeedListResult {
  jsonPath: string;
  markdownPath: string;
  seedList: SmartWalletSeedList;
}

const DEFAULT_LIST_ID = "smart_wallet_seed_v0";
const DEFAULT_LIMIT = 75;
const DEFAULT_MIN_TOKEN_COUNT = 1;
const DEFAULT_MIN_SIGHTINGS = 1;
const DEFAULT_OUTPUT_DIR = path.resolve(PROJECT_ROOT_PATH, "..", "..", "lab", "smart-wallet-seeds");

const RANKING_POLICY = [
  "dual-source wallets first",
  "higher token_count",
  "higher total sightings",
  "higher win rate",
  "higher realized pnl_usd",
  "newer last_seen",
];

const GUARDRAILS = [
  "Shadow-only seed species artifact; not loaded by MVP genome runner.",
  "Does not call providers, mutate runtime settings, or place trades.",
  "Does not bypass token safety pre-screening, safetyFloor, or A/A scorecard gates.",
  "Full wallet addresses stay in the local JSON artifact and should not be pasted into LLM prompts.",
  "Promotion requires a separate owner-approved ticket plus evidence that wallet signals beat control.",
];

export async function exportSmartWalletSeedList(
  options: ExportSeedListOptions,
): Promise<ExportSeedListResult> {
  const limit = normalizePositiveInt(options.limit, DEFAULT_LIMIT);
  const minTokenCount = normalizePositiveInt(options.minTokenCount, DEFAULT_MIN_TOKEN_COUNT);
  const minSightings = normalizePositiveInt(options.minSightings, DEFAULT_MIN_SIGHTINGS);
  const generatedAt = options.generatedAt ?? new Date();
  const listId = options.listId ?? DEFAULT_LIST_ID;

  const store = new HarvesterStore(options.dbPath);
  try {
    const rows = store.query<SeedWalletQueryRow>(
      `
        WITH wallet_stats AS (
          SELECT
            w.address,
            w.sources,
            w.tags,
            w.token_count,
            w.pnl_usd,
            w.win_rate,
            w.avg_buy_usd,
            w.first_seen,
            w.last_seen,
            COUNT(s.id) AS total_sightings,
            SUM(CASE WHEN s.source = 'gmgn' THEN 1 ELSE 0 END) AS gmgn_sightings,
            SUM(CASE WHEN s.source = 'okx' THEN 1 ELSE 0 END) AS okx_sightings,
            COUNT(DISTINCT CASE WHEN s.mint != '' THEN s.mint END) AS distinct_mints,
            SUM(CASE WHEN s.action = 'buy' THEN 1 ELSE 0 END) AS buy_sightings,
            SUM(CASE WHEN s.action = 'sell' THEN 1 ELSE 0 END) AS sell_sightings,
            SUM(CASE WHEN s.action = 'hold' THEN 1 ELSE 0 END) AS hold_sightings
          FROM wallets w
          LEFT JOIN sightings s ON s.wallet_address = w.address
          GROUP BY w.address
        )
        SELECT *
        FROM wallet_stats
        WHERE token_count >= ? AND total_sightings >= ?
        ORDER BY
          CASE WHEN gmgn_sightings > 0 AND okx_sightings > 0 THEN 1 ELSE 0 END DESC,
          token_count DESC,
          total_sightings DESC,
          COALESCE(win_rate, -1) DESC,
          COALESCE(pnl_usd, -999999999) DESC,
          last_seen DESC
        LIMIT ?
      `,
      [minTokenCount, minSightings, limit],
    );

    const wallets = rows.map((row, index) => toSeedWallet(row, index + 1));
    const seedList: SmartWalletSeedList = {
      schemaVersion: 1,
      listId,
      generatedAt: generatedAt.toISOString(),
      status: "shadow_only",
      species: {
        speciesId: "smart-wallet-seed-shadow",
        mode: "shadow_candidate_feature",
        edgeChannel: "entry_selection",
        promotionEligible: false,
        hotPathAllowed: false,
        requiresOperatorReview: true,
      },
      source: {
        dbPath: options.dbPath,
        tool: "tools/wallet-harvester",
        selectionPolicy: {
          limit,
          minTokenCount,
          minSightings,
          ranking: RANKING_POLICY,
        },
      },
      counts: countWallets(wallets),
      guardrails: GUARDRAILS,
      contentHash: hashWallets(wallets),
      wallets,
    };

    await fs.mkdir(options.outputDir, { recursive: true });
    const jsonPath = path.join(options.outputDir, `${listId}.json`);
    const markdownPath = path.join(options.outputDir, `${listId}.md`);
    await fs.writeFile(jsonPath, `${JSON.stringify(seedList, null, 2)}\n`, "utf8");
    await fs.writeFile(markdownPath, renderMarkdown(seedList), "utf8");
    return { jsonPath, markdownPath, seedList };
  } finally {
    store.close();
  }
}

function toSeedWallet(row: SeedWalletQueryRow, rank: number): SeedWallet {
  const sources = parseJsonArray<Source>(row.sources);
  const tags = parseJsonArray<WalletTag>(row.tags);
  const gmgnSightings = normalizeCount(row.gmgn_sightings);
  const okxSightings = normalizeCount(row.okx_sightings);
  const totalSightings = normalizeCount(row.total_sightings);
  const wallet: SeedWallet = {
    rank,
    walletAddress: row.address,
    sourceType: getSourceType(gmgnSightings, okxSightings, sources),
    sources,
    tags,
    tokenCount: normalizeCount(row.token_count),
    totalSightings,
    distinctMints: normalizeCount(row.distinct_mints),
    gmgnSightings,
    okxSightings,
    buySightings: normalizeCount(row.buy_sightings),
    sellSightings: normalizeCount(row.sell_sightings),
    holdSightings: normalizeCount(row.hold_sightings),
    pnlUsd: normalizeNullableNumber(row.pnl_usd),
    winRate: normalizeNullableNumber(row.win_rate),
    avgBuyUsd: normalizeNullableNumber(row.avg_buy_usd),
    firstSeen: new Date(row.first_seen).toISOString(),
    lastSeen: new Date(row.last_seen).toISOString(),
    selectionScore: 0,
  };
  wallet.selectionScore = scoreWallet(wallet);
  return wallet;
}

function getSourceType(
  gmgnSightings: number,
  okxSightings: number,
  sources: Source[],
): SeedWallet["sourceType"] {
  const hasGmgn = gmgnSightings > 0 || sources.includes("gmgn");
  const hasOkx = okxSightings > 0 || sources.includes("okx");
  if (hasGmgn && hasOkx) return "dual";
  if (hasGmgn) return "gmgn_only";
  if (hasOkx) return "okx_only";
  return "unknown";
}

function scoreWallet(wallet: SeedWallet): number {
  const sourceScore = wallet.sourceType === "dual" ? 40 : 0;
  const recurrenceScore = Math.min(wallet.tokenCount, 12) * 5;
  const sightingScore = Math.min(wallet.totalSightings, 30) * 1.5;
  const winRateScore = wallet.winRate == null ? 0 : clamp(wallet.winRate, 0, 1) * 20;
  const pnlScore = wallet.pnlUsd == null ? 0 : clamp(wallet.pnlUsd / 1_000, 0, 20);
  return round(sourceScore + recurrenceScore + sightingScore + winRateScore + pnlScore, 2);
}

function countWallets(wallets: SeedWallet[]): SmartWalletSeedList["counts"] {
  return {
    walletsSelected: wallets.length,
    dualSourceWallets: wallets.filter((wallet) => wallet.sourceType === "dual").length,
    gmgnOnlyWallets: wallets.filter((wallet) => wallet.sourceType === "gmgn_only").length,
    okxOnlyWallets: wallets.filter((wallet) => wallet.sourceType === "okx_only").length,
  };
}

function renderMarkdown(seedList: SmartWalletSeedList): string {
  const rows = seedList.wallets.slice(0, 25).map((wallet) => {
    return [
      wallet.rank,
      maskWallet(wallet.walletAddress),
      wallet.sourceType,
      wallet.tokenCount,
      wallet.totalSightings,
      wallet.selectionScore,
      wallet.lastSeen,
    ].join(" | ");
  });

  return [
    "# Smart Wallet Seed Species List",
    "",
    `Generated: ${seedList.generatedAt}`,
    `Status: ${seedList.status}`,
    `Species: ${seedList.species.speciesId}`,
    `Selected wallets: ${seedList.counts.walletsSelected}`,
    `Dual-source wallets: ${seedList.counts.dualSourceWallets}`,
    `Content hash: ${seedList.contentHash}`,
    "",
    "## Guardrails",
    "",
    ...seedList.guardrails.map((guardrail) => `- ${guardrail}`),
    "",
    "## Selection Policy",
    "",
    ...seedList.source.selectionPolicy.ranking.map((item) => `- ${item}`),
    "",
    "## Top Seed Wallets",
    "",
    "Full wallet addresses are stored in the JSON artifact only. The table below is masked for operator-safe review.",
    "",
    "Rank | Wallet | Source type | Tokens | Sightings | Score | Last seen",
    "--- | --- | --- | ---: | ---: | ---: | ---",
    ...rows,
    "",
  ].join("\n");
}

function hashWallets(wallets: SeedWallet[]): string {
  const payload = wallets.map((wallet) => ({
    rank: wallet.rank,
    walletAddress: wallet.walletAddress,
    score: wallet.selectionScore,
  }));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function parseJsonArray<T extends string>(value: string): T[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is T => typeof item === "string");
  } catch {
    return [];
  }
}

function normalizeNullableNumber(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value;
}

function normalizeCount(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function maskWallet(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function parseIntArg(name: string): number | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (!match) return undefined;
  const value = Number.parseInt(match.slice(prefix.length), 10);
  return Number.isFinite(value) ? value : undefined;
}

function parseStringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match?.slice(prefix.length);
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const outputDir =
    parseStringArg("output-dir") ?? process.env.SMART_WALLET_SEED_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR;
  const result = await exportSmartWalletSeedList({
    dbPath: parseStringArg("db") ?? config.dbPath,
    outputDir,
    listId: parseStringArg("list-id") ?? DEFAULT_LIST_ID,
    limit: parseIntArg("limit") ?? envInt("SMART_WALLET_SEED_LIMIT"),
    minTokenCount: parseIntArg("min-token-count") ?? envInt("SMART_WALLET_SEED_MIN_TOKEN_COUNT"),
    minSightings: parseIntArg("min-sightings") ?? envInt("SMART_WALLET_SEED_MIN_SIGHTINGS"),
  });

  console.log("Smart wallet seed list exported.");
  console.log(`Selected wallets: ${result.seedList.counts.walletsSelected}`);
  console.log(`Dual-source wallets: ${result.seedList.counts.dualSourceWallets}`);
  console.log(`JSON: ${result.jsonPath}`);
  console.log(`Markdown: ${result.markdownPath}`);
}

if (process.argv[1]?.endsWith("exportSeedList.ts") || process.argv[1]?.endsWith("exportSeedList.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
