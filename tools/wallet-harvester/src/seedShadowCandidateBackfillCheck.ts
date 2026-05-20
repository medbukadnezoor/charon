import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSeedShadowCandidateBackfill } from "./seedShadowCandidateBackfill.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "charon-seed-shadow-candidates-"));
  const reportPath = path.join(tempRoot, "shadow_report.json");
  const outputDir = path.join(tempRoot, "out");
  const candidateStreamPath = path.join(outputDir, "shadow_candidates.jsonl");
  try {
    await fs.writeFile(reportPath, `${JSON.stringify({
      schemaVersion: 1,
      topSeedTokens: [
        token("MintHit1111111111111111111111111111111111", 4, "dual"),
        token("MintHit2222222222222222222222222222222222", 7, "gmgn_only"),
      ],
    }, null, 2)}\n`, "utf8");

    const result = await runSeedShadowCandidateBackfill({
      shadowReportPath: reportPath,
      outputDir,
      candidateStreamPath,
      cohortId: "fixture-shadow",
      generatedAt: new Date(Date.UTC(2026, 4, 8, 10, 0, 0)),
    });
    const rows = (await fs.readFile(candidateStreamPath, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as Record<string, unknown>);
    const markdown = await fs.readFile(result.operatorReportPath, "utf8");

    assert(result.report.status === "shadow_candidates_written", "writes shadow candidates");
    assert(rows.length === 2, "writes one row per token");
    assert(rows[0]?.recordType === "candidate", "row is candidate-shaped");
    assert(rows[0]?.cohortId === "fixture-shadow", "uses provided cohort id");
    assert(typeof rows[0]?.candidateStreamId === "string", "writes candidate stream id");
    assert(!markdown.includes("walletAddress"), "operator report does not expose wallet fields");

    console.log("Smart wallet seed shadow candidate backfill check passed.");
    console.log(`Fixture candidate rows: ${rows.length}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function token(tokenAddress: string, bestSeedRank: number, bestSeedSourceType: string): unknown {
  return {
    tokenAddress,
    seedWalletCount: 2,
    seedSightingCount: 3,
    bestSeedRank,
    bestSeedSourceType,
    lastSeedSightingAt: "2026-05-08T10:00:00.000Z",
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
