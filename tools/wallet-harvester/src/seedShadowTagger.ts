import fs from "node:fs/promises";
import path from "node:path";

import { loadConfig, PROJECT_ROOT_PATH } from "./config.js";
import { HarvesterStore } from "./store.js";

type JsonObject = Record<string, unknown>;

export type SeedShadowStatus = "tagged_candidates" | "seed_index_ready_no_candidates" | "blocked";

export interface SeedShadowTaggerOptions {
  dbPath: string;
  seedListPath: string;
  cohortDir: string;
  outputDir: string;
  candidateStreamPath?: string;
  generatedAt?: Date;
}

interface SeedWalletInput {
  rank: number;
  walletAddress: string;
  sourceType: "dual" | "gmgn_only" | "okx_only" | "unknown";
  selectionScore: number;
}

interface SeedListInput {
  listId?: string;
  contentHash?: string;
  wallets?: SeedWalletInput[];
  species?: { speciesId?: string; mode?: string };
}

interface SightingRow {
  mint: string;
  wallet_address: string;
  source: string;
  action: string;
  timestamp: number;
}

export interface CandidateSeedTag {
  candidateId: string;
  tokenAddress: string;
  smartWalletSeedHit: boolean;
  seedWalletCount: number;
  seedSightingCount: number;
  bestSeedRank: number | null;
  bestSeedSourceType: SeedWalletInput["sourceType"] | null;
  lastSeedSightingAt: string | null;
}

export interface SeedTokenStat {
  tokenAddress: string;
  seedWalletCount: number;
  seedSightingCount: number;
  bestSeedRank: number;
  bestSeedSourceType: SeedWalletInput["sourceType"];
  gmgnSightings: number;
  okxSightings: number;
  buySightings: number;
  sellSightings: number;
  holdSightings: number;
  lastSeedSightingAt: string;
}

export interface SeedShadowReport {
  schemaVersion: 1;
  source: "smart_wallet_seed_shadow_tagger";
  generatedAt: string;
  status: SeedShadowStatus;
  warning: string;
  inputs: {
    dbPath: string;
    seedListPath: string;
    cohortDir: string;
    sharedCandidateStreamPath: string;
  };
  seedList: {
    listId: string | null;
    contentHash: string | null;
    speciesId: string | null;
    seedWallets: number;
  };
  summary: {
    seedSightedTokens: number;
    candidateRows: number;
    hitCandidates: number;
    hitRate: number | null;
    dualSourceHitCandidates: number;
  };
  candidateTags: CandidateSeedTag[];
  topSeedTokens: SeedTokenStat[];
  guardrails: string[];
  outputs: {
    reportPath: string;
    operatorReportPath: string;
  };
  nextStep: string;
  reasons: string[];
}

export interface SeedShadowTaggerResult {
  report: SeedShadowReport;
  reportPath: string;
  operatorReportPath: string;
}

const DEFAULT_SEED_LIST_PATH = path.resolve(PROJECT_ROOT_PATH, "..", "..", "lab", "smart-wallet-seeds", "smart_wallet_seed_v0.json");
const DEFAULT_COHORT_DIR = path.resolve(PROJECT_ROOT_PATH, "..", "..", "lab", "cohorts", "c001");
const DEFAULT_OUTPUT_DIR = path.resolve(PROJECT_ROOT_PATH, "..", "..", "lab", "smart-wallet-seeds");

const WARNING =
  "Smart-wallet seed shadow tagging is read-only analysis. It does not alter genomes, entries, exits, scorecards, runtime settings, token safety, safetyFloor, or trading authority.";

const GUARDRAILS = [
  "Shadow tags are advisory analysis only.",
  "Full seed wallet addresses are read from the local JSON seed list but are not emitted in the report.",
  "Candidate tags cannot promote a token, approve a strategy, or bypass A/A and scorecard gates.",
  "Missing cohort evidence keeps the lane in seed-index mode until candidate rows exist.",
];

export async function runSeedShadowTagger(options: SeedShadowTaggerOptions): Promise<SeedShadowTaggerResult> {
  const sharedCandidateStreamPath = path.resolve(options.candidateStreamPath ?? path.join(options.cohortDir, "evidence", "shared_candidate_stream.jsonl"));
  const reportPath = path.join(options.outputDir, "smart_wallet_seed_shadow_report.json");
  const operatorReportPath = path.join(options.outputDir, "smart_wallet_seed_shadow_report.md");
  const reasons: string[] = [];

  await fs.mkdir(options.outputDir, { recursive: true });

  const seedList = await readSeedList(options.seedListPath);
  const seedWallets = seedList.wallets ?? [];
  if (seedWallets.length === 0) {
    reasons.push("Seed list has zero wallets. Run lab:smart-wallet-seed-list first.");
  }

  const tokenStats = seedWallets.length > 0
    ? await buildSeedTokenStats(options.dbPath, seedWallets)
    : [];
  if (tokenStats.length === 0 && seedWallets.length > 0) {
    reasons.push("No wallet-harvester sightings were found for the seed wallets.");
  }

  const candidateRows = await readCandidateRows(sharedCandidateStreamPath);
  if (candidateRows.errors.length > 0) reasons.push(...candidateRows.errors);
  const tokenStatsByMint = new Map(tokenStats.map((stat) => [stat.tokenAddress, stat]));
  const candidateTags = candidateRows.rows.map((row) => toCandidateTag(row, tokenStatsByMint));
  const hitCandidates = candidateTags.filter((tag) => tag.smartWalletSeedHit);
  const status: SeedShadowStatus = reasons.some((reason) => reason.startsWith("Seed list has zero"))
    ? "blocked"
    : candidateRows.rows.length === 0
      ? "seed_index_ready_no_candidates"
      : "tagged_candidates";

  const report: SeedShadowReport = {
    schemaVersion: 1,
    source: "smart_wallet_seed_shadow_tagger",
    generatedAt: options.generatedAt?.toISOString() ?? new Date().toISOString(),
    status,
    warning: WARNING,
    inputs: {
      dbPath: options.dbPath,
      seedListPath: options.seedListPath,
      cohortDir: options.cohortDir,
      sharedCandidateStreamPath,
    },
    seedList: {
      listId: asString(seedList.listId) ?? null,
      contentHash: asString(seedList.contentHash) ?? null,
      speciesId: asString(seedList.species?.speciesId) ?? null,
      seedWallets: seedWallets.length,
    },
    summary: {
      seedSightedTokens: tokenStats.length,
      candidateRows: candidateRows.rows.length,
      hitCandidates: hitCandidates.length,
      hitRate: candidateRows.rows.length === 0 ? null : round(hitCandidates.length / candidateRows.rows.length, 4),
      dualSourceHitCandidates: hitCandidates.filter((tag) => tag.bestSeedSourceType === "dual").length,
    },
    candidateTags,
    topSeedTokens: tokenStats.slice(0, 50),
    guardrails: GUARDRAILS,
    outputs: {
      reportPath,
      operatorReportPath,
    },
    nextStep: nextStep(status),
    reasons: reasons.length > 0 ? reasons : ["Shadow report generated without mutating runtime or scorecard artifacts."],
  };

  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(operatorReportPath, renderOperatorReport(report), "utf8");
  return { report, reportPath, operatorReportPath };
}

async function buildSeedTokenStats(dbPath: string, seedWallets: readonly SeedWalletInput[]): Promise<SeedTokenStat[]> {
  const seedByWallet = new Map(seedWallets.map((wallet) => [wallet.walletAddress, wallet]));
  const placeholders = seedWallets.map(() => "?").join(", ");
  const store = new HarvesterStore(dbPath);
  try {
    const rows = store.query<SightingRow>(
      `
        SELECT mint, wallet_address, source, action, timestamp
        FROM sightings
        WHERE wallet_address IN (${placeholders})
          AND mint IS NOT NULL
          AND mint != ''
        ORDER BY timestamp DESC
      `,
      seedWallets.map((wallet) => wallet.walletAddress),
    );
    const aggregated = new Map<string, MutableTokenStat>();
    for (const row of rows) {
      const seed = seedByWallet.get(row.wallet_address);
      if (!seed) continue;
      const current = aggregated.get(row.mint) ?? newMutableTokenStat(row.mint, seed);
      current.seedWalletAddresses.add(row.wallet_address);
      current.seedSightingCount += 1;
      if (row.source === "gmgn") current.gmgnSightings += 1;
      if (row.source === "okx") current.okxSightings += 1;
      if (row.action === "buy") current.buySightings += 1;
      if (row.action === "sell") current.sellSightings += 1;
      if (row.action === "hold") current.holdSightings += 1;
      if (seed.rank < current.bestSeedRank) {
        current.bestSeedRank = seed.rank;
        current.bestSeedSourceType = seed.sourceType;
      }
      if (row.timestamp > current.lastSeedSightingAtMs) current.lastSeedSightingAtMs = row.timestamp;
      aggregated.set(row.mint, current);
    }
    return [...aggregated.values()]
      .map(finalizeTokenStat)
      .sort((a, b) => {
        if (b.seedWalletCount !== a.seedWalletCount) return b.seedWalletCount - a.seedWalletCount;
        if (b.seedSightingCount !== a.seedSightingCount) return b.seedSightingCount - a.seedSightingCount;
        return a.bestSeedRank - b.bestSeedRank;
      });
  } finally {
    store.close();
  }
}

interface MutableTokenStat {
  tokenAddress: string;
  seedWalletAddresses: Set<string>;
  seedSightingCount: number;
  bestSeedRank: number;
  bestSeedSourceType: SeedWalletInput["sourceType"];
  gmgnSightings: number;
  okxSightings: number;
  buySightings: number;
  sellSightings: number;
  holdSightings: number;
  lastSeedSightingAtMs: number;
}

function newMutableTokenStat(tokenAddress: string, seed: SeedWalletInput): MutableTokenStat {
  return {
    tokenAddress,
    seedWalletAddresses: new Set<string>(),
    seedSightingCount: 0,
    bestSeedRank: seed.rank,
    bestSeedSourceType: seed.sourceType,
    gmgnSightings: 0,
    okxSightings: 0,
    buySightings: 0,
    sellSightings: 0,
    holdSightings: 0,
    lastSeedSightingAtMs: 0,
  };
}

function finalizeTokenStat(stat: MutableTokenStat): SeedTokenStat {
  return {
    tokenAddress: stat.tokenAddress,
    seedWalletCount: stat.seedWalletAddresses.size,
    seedSightingCount: stat.seedSightingCount,
    bestSeedRank: stat.bestSeedRank,
    bestSeedSourceType: stat.bestSeedSourceType,
    gmgnSightings: stat.gmgnSightings,
    okxSightings: stat.okxSightings,
    buySightings: stat.buySightings,
    sellSightings: stat.sellSightings,
    holdSightings: stat.holdSightings,
    lastSeedSightingAt: new Date(stat.lastSeedSightingAtMs).toISOString(),
  };
}

function toCandidateTag(row: JsonObject, tokenStatsByMint: Map<string, SeedTokenStat>): CandidateSeedTag {
  const candidateId = asString(row.candidateId) ?? "unknown_candidate";
  const tokenAddress = asString(row.tokenAddress) ?? "";
  const stat = tokenStatsByMint.get(tokenAddress);
  return {
    candidateId,
    tokenAddress,
    smartWalletSeedHit: stat !== undefined,
    seedWalletCount: stat?.seedWalletCount ?? 0,
    seedSightingCount: stat?.seedSightingCount ?? 0,
    bestSeedRank: stat?.bestSeedRank ?? null,
    bestSeedSourceType: stat?.bestSeedSourceType ?? null,
    lastSeedSightingAt: stat?.lastSeedSightingAt ?? null,
  };
}

async function readSeedList(seedListPath: string): Promise<SeedListInput> {
  const parsed = JSON.parse(await fs.readFile(seedListPath, "utf8")) as unknown;
  if (!isObject(parsed)) return {};
  const wallets = Array.isArray(parsed.wallets)
    ? parsed.wallets.map(parseSeedWallet).filter((wallet): wallet is SeedWalletInput => wallet !== null)
    : [];
  return {
    listId: asString(parsed.listId),
    contentHash: asString(parsed.contentHash),
    species: isObject(parsed.species) ? { speciesId: asString(parsed.species.speciesId), mode: asString(parsed.species.mode) } : undefined,
    wallets,
  };
}

function parseSeedWallet(value: unknown): SeedWalletInput | null {
  if (!isObject(value)) return null;
  const rank = asNumber(value.rank);
  const walletAddress = asString(value.walletAddress);
  const sourceType = asSourceType(value.sourceType);
  const selectionScore = asNumber(value.selectionScore) ?? 0;
  if (rank === undefined || walletAddress === undefined || sourceType === undefined) return null;
  return { rank, walletAddress, sourceType, selectionScore };
}

async function readCandidateRows(filePath: string): Promise<{ rows: JsonObject[]; errors: string[] }> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const rows: JsonObject[] = [];
    const errors: string[] = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isObject(parsed)) rows.push(parsed);
        else errors.push(`shared_candidate_stream row ${index + 1}: expected JSON object`);
      } catch {
        errors.push(`shared_candidate_stream row ${index + 1}: invalid JSON`);
      }
    }
    return { rows, errors };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { rows: [], errors: ["Shared candidate stream is missing; shadow report generated seed-token index only."] };
    }
    throw err;
  }
}

function renderOperatorReport(report: SeedShadowReport): string {
  return [
    "# Smart Wallet Seed Shadow Report",
    "",
    "## Status",
    report.status,
    "",
    "## Summary",
    `- Seed wallets: ${report.seedList.seedWallets}`,
    `- Seed-sighted tokens: ${report.summary.seedSightedTokens}`,
    `- Candidate rows: ${report.summary.candidateRows}`,
    `- Hit candidates: ${report.summary.hitCandidates}`,
    `- Hit rate: ${report.summary.hitRate === null ? "not available" : `${round(report.summary.hitRate * 100, 2)}%`}`,
    `- Dual-source hit candidates: ${report.summary.dualSourceHitCandidates}`,
    "",
    "## Guardrails",
    ...report.guardrails.map((guardrail) => `- ${guardrail}`),
    "",
    "## Top Seed-Sighted Tokens",
    "",
    "Token | Seed wallets | Sightings | Best rank | Best source | Last seen",
    "--- | ---: | ---: | ---: | --- | ---",
    ...report.topSeedTokens.slice(0, 25).map((token) => [
      token.tokenAddress,
      token.seedWalletCount,
      token.seedSightingCount,
      token.bestSeedRank,
      token.bestSeedSourceType,
      token.lastSeedSightingAt,
    ].join(" | ")),
    "",
    "## Candidate Tags",
    "",
    "Candidate | Token | Hit | Seed wallets | Sightings | Best rank | Best source",
    "--- | --- | --- | ---: | ---: | ---: | ---",
    ...report.candidateTags.slice(0, 50).map((tag) => [
      tag.candidateId,
      tag.tokenAddress,
      tag.smartWalletSeedHit ? "yes" : "no",
      tag.seedWalletCount,
      tag.seedSightingCount,
      tag.bestSeedRank ?? "",
      tag.bestSeedSourceType ?? "",
    ].join(" | ")),
    "",
    "## Reasons",
    ...report.reasons.map((reason) => `- ${reason}`),
    "",
    "## Next Step",
    `- ${report.nextStep}`,
    "",
    "## Warning",
    `- ${report.warning}`,
    "",
  ].join("\n");
}

function nextStep(status: SeedShadowStatus): string {
  if (status === "tagged_candidates") {
    return "Review hit versus non-hit outcomes after paired evidence closes; do not promote until the shadow signal beats Control after friction and A/A gates.";
  }
  if (status === "seed_index_ready_no_candidates") {
    return "Keep collecting candidate stream evidence, then rerun this report to compute hit candidates.";
  }
  return "Regenerate the seed list, then rerun the shadow report.";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asSourceType(value: unknown): SeedWalletInput["sourceType"] | undefined {
  if (value === "dual" || value === "gmgn_only" || value === "okx_only" || value === "unknown") return value;
  return undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const result = await runSeedShadowTagger({
    dbPath: process.env.SMART_WALLET_SHADOW_DB_PATH ?? config.dbPath,
    seedListPath: process.env.SMART_WALLET_SHADOW_SEED_LIST_PATH ?? DEFAULT_SEED_LIST_PATH,
    cohortDir: process.env.SMART_WALLET_SHADOW_COHORT_DIR ?? DEFAULT_COHORT_DIR,
    outputDir: process.env.SMART_WALLET_SHADOW_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR,
    candidateStreamPath: process.env.SMART_WALLET_SHADOW_CANDIDATE_STREAM_PATH,
  });

  console.log("Smart wallet seed shadow report generated.");
  console.log(`status: ${result.report.status}`);
  console.log(`seed-sighted tokens: ${result.report.summary.seedSightedTokens}`);
  console.log(`candidate rows: ${result.report.summary.candidateRows}`);
  console.log(`hit candidates: ${result.report.summary.hitCandidates}`);
  console.log(`report: ${result.reportPath}`);
  console.log(`operator report: ${result.operatorReportPath}`);
  if (result.report.status === "blocked") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("seedShadowTagger.ts") || process.argv[1]?.endsWith("seedShadowTagger.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
