import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { PROJECT_ROOT_PATH } from "./config.js";

type JsonObject = Record<string, unknown>;

export type SeedShadowCandidateBackfillStatus = "shadow_candidates_written" | "blocked";

export interface SeedShadowCandidateBackfillOptions {
  shadowReportPath: string;
  outputDir: string;
  candidateStreamPath: string;
  cohortId?: string;
  generatedAt?: Date;
  limit?: number;
}

interface ShadowTokenInput {
  tokenAddress: string;
  seedWalletCount: number;
  seedSightingCount: number;
  bestSeedRank: number;
  bestSeedSourceType: string;
  lastSeedSightingAt: string;
}

export interface SeedShadowCandidateBackfillReport {
  schemaVersion: 1;
  source: "smart_wallet_seed_shadow_candidate_backfill";
  generatedAt: string;
  status: SeedShadowCandidateBackfillStatus;
  warning: string;
  inputs: {
    shadowReportPath: string;
    candidateStreamPath: string;
    limit: number;
  };
  summary: {
    sourceTokens: number;
    candidateRowsWritten: number;
    candidateStreamId: string | null;
  };
  guardrails: string[];
  outputs: {
    candidateStreamPath: string;
    reportPath: string;
    operatorReportPath: string;
  };
  reasons: string[];
  nextStep: string;
}

export interface SeedShadowCandidateBackfillResult {
  report: SeedShadowCandidateBackfillReport;
  reportPath: string;
  operatorReportPath: string;
  candidateStreamPath: string;
}

const DEFAULT_OUTPUT_DIR = path.resolve(PROJECT_ROOT_PATH, "..", "..", "lab", "smart-wallet-seeds");
const DEFAULT_SHADOW_REPORT_PATH = path.join(DEFAULT_OUTPUT_DIR, "smart_wallet_seed_shadow_report.json");
const DEFAULT_CANDIDATE_STREAM_PATH = path.join(DEFAULT_OUTPUT_DIR, "smart_wallet_seed_shadow_candidates.jsonl");
const DEFAULT_LIMIT = 50;

const WARNING =
  "Smart-wallet seed shadow candidate backfill creates derived analysis candidates only. It is not official cohort evidence and must not be copied into lab/cohorts/<id>/evidence/shared_candidate_stream.jsonl.";

const GUARDRAILS = [
  "Writes under lab/smart-wallet-seeds, not the official cohort evidence directory.",
  "Uses seed-sighted token metadata only; no wallet addresses are emitted.",
  "Does not alter genomes, runtime settings, scorecards, state, logs, or provider credentials.",
  "Useful for shadow hit/miss plumbing only; outcome evidence is still required before promotion.",
];

export async function runSeedShadowCandidateBackfill(
  options: SeedShadowCandidateBackfillOptions,
): Promise<SeedShadowCandidateBackfillResult> {
  const outputDir = path.resolve(options.outputDir);
  const reportPath = path.join(outputDir, "smart_wallet_seed_shadow_candidate_backfill.json");
  const operatorReportPath = path.join(outputDir, "smart_wallet_seed_shadow_candidate_backfill.md");
  const candidateStreamPath = path.resolve(options.candidateStreamPath);
  const limit = normalizePositiveInt(options.limit, DEFAULT_LIMIT);
  const generatedAt = options.generatedAt ?? new Date();
  const cohortId = cleanId(options.cohortId ?? "smart-wallet-seed-shadow");
  const candidateStreamId = `stream_${cohortId}_${generatedAt.toISOString().replace(/\.\d{3}Z$/, "z").replace(/[-:]/g, "").toLowerCase()}`;

  await fs.mkdir(outputDir, { recursive: true });
  await fs.mkdir(path.dirname(candidateStreamPath), { recursive: true });

  const reasons: string[] = [];
  const tokens = await readShadowTokens(options.shadowReportPath);
  if (tokens.length === 0) reasons.push("Shadow report has zero seed-sighted tokens. Run lab:smart-wallet-seed-shadow first.");
  const selected = tokens.slice(0, limit);
  const rows = selected.map((token, index) => candidateRow(token, index + 1, cohortId, candidateStreamId, generatedAt));
  const status: SeedShadowCandidateBackfillStatus = rows.length === 0 ? "blocked" : "shadow_candidates_written";

  if (rows.length > 0) {
    await fs.writeFile(candidateStreamPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    reasons.push(`Wrote ${rows.length} shadow candidate row(s) from seed-sighted tokens.`);
    reasons.push("Rows are derived analysis candidates and are not official cohort evidence.");
  }

  const report: SeedShadowCandidateBackfillReport = {
    schemaVersion: 1,
    source: "smart_wallet_seed_shadow_candidate_backfill",
    generatedAt: generatedAt.toISOString(),
    status,
    warning: WARNING,
    inputs: {
      shadowReportPath: options.shadowReportPath,
      candidateStreamPath,
      limit,
    },
    summary: {
      sourceTokens: tokens.length,
      candidateRowsWritten: rows.length,
      candidateStreamId: rows.length === 0 ? null : candidateStreamId,
    },
    guardrails: GUARDRAILS,
    outputs: {
      candidateStreamPath,
      reportPath,
      operatorReportPath,
    },
    reasons,
    nextStep: status === "shadow_candidates_written"
      ? "Run SMART_WALLET_SHADOW_CANDIDATE_STREAM_PATH against lab:smart-wallet-seed-shadow to prove tag plumbing on the shadow candidate stream."
      : "Regenerate the seed shadow report after seed wallets have sightings, then rerun this backfill.",
  };

  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await fs.writeFile(operatorReportPath, renderOperatorReport(report), "utf8");
  return { report, reportPath, operatorReportPath, candidateStreamPath };
}

async function readShadowTokens(reportPath: string): Promise<ShadowTokenInput[]> {
  const parsed = JSON.parse(await fs.readFile(reportPath, "utf8")) as unknown;
  if (!isObject(parsed) || !Array.isArray(parsed.topSeedTokens)) return [];
  return parsed.topSeedTokens.map(parseShadowToken).filter((token): token is ShadowTokenInput => token !== null);
}

function parseShadowToken(value: unknown): ShadowTokenInput | null {
  if (!isObject(value)) return null;
  const tokenAddress = asString(value.tokenAddress);
  const seedWalletCount = asNumber(value.seedWalletCount);
  const seedSightingCount = asNumber(value.seedSightingCount);
  const bestSeedRank = asNumber(value.bestSeedRank);
  const bestSeedSourceType = asString(value.bestSeedSourceType);
  const lastSeedSightingAt = asString(value.lastSeedSightingAt);
  if (
    tokenAddress === undefined ||
    seedWalletCount === undefined ||
    seedSightingCount === undefined ||
    bestSeedRank === undefined ||
    bestSeedSourceType === undefined ||
    lastSeedSightingAt === undefined
  ) return null;
  return { tokenAddress, seedWalletCount, seedSightingCount, bestSeedRank, bestSeedSourceType, lastSeedSightingAt };
}

function candidateRow(
  token: ShadowTokenInput,
  sequence: number,
  cohortId: string,
  candidateStreamId: string,
  generatedAt: Date,
): JsonObject {
  return {
    schemaVersion: 1,
    recordType: "candidate",
    cohortId,
    candidateId: `shadow_seed_${sequence}_${hashToken(token.tokenAddress)}`,
    candidateStreamId,
    tokenAddress: token.tokenAddress,
    chain: "solana",
    discoveredAt: normalizeIso(token.lastSeedSightingAt, generatedAt),
    metadata: {
      source: "smart_wallet_seed_shadow",
      seedWalletCount: token.seedWalletCount,
      seedSightingCount: token.seedSightingCount,
      bestSeedRank: token.bestSeedRank,
      bestSeedSourceType: token.bestSeedSourceType,
    },
  };
}

function renderOperatorReport(report: SeedShadowCandidateBackfillReport): string {
  return [
    "# Smart Wallet Seed Shadow Candidate Backfill",
    "",
    "## Status",
    report.status,
    "",
    "## Summary",
    `- Source tokens: ${report.summary.sourceTokens}`,
    `- Candidate rows written: ${report.summary.candidateRowsWritten}`,
    `- Candidate stream ID: ${report.summary.candidateStreamId ?? "not written"}`,
    `- Candidate stream path: ${report.outputs.candidateStreamPath}`,
    "",
    "## Guardrails",
    ...report.guardrails.map((guardrail) => `- ${guardrail}`),
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

function hashToken(tokenAddress: string): string {
  return createHash("sha256").update(tokenAddress).digest("hex").slice(0, 12);
}

function normalizeIso(value: string, fallback: Date): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function cleanId(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "smart_wallet_seed_shadow";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function main(): Promise<void> {
  const result = await runSeedShadowCandidateBackfill({
    shadowReportPath: process.env.SMART_WALLET_SHADOW_REPORT_PATH ?? DEFAULT_SHADOW_REPORT_PATH,
    outputDir: process.env.SMART_WALLET_SHADOW_OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR,
    candidateStreamPath: process.env.SMART_WALLET_SHADOW_CANDIDATE_STREAM_PATH ?? DEFAULT_CANDIDATE_STREAM_PATH,
    cohortId: process.env.SMART_WALLET_SHADOW_COHORT_ID,
    limit: envInt("SMART_WALLET_SHADOW_CANDIDATE_LIMIT"),
  });

  console.log("Smart wallet seed shadow candidates generated.");
  console.log(`status: ${result.report.status}`);
  console.log(`source tokens: ${result.report.summary.sourceTokens}`);
  console.log(`candidate rows written: ${result.report.summary.candidateRowsWritten}`);
  console.log(`candidate stream: ${result.candidateStreamPath}`);
  console.log(`report: ${result.reportPath}`);
  console.log(`operator report: ${result.operatorReportPath}`);
  if (result.report.status === "blocked") process.exitCode = 1;
}

if (process.argv[1]?.endsWith("seedShadowCandidateBackfill.ts") || process.argv[1]?.endsWith("seedShadowCandidateBackfill.js")) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
