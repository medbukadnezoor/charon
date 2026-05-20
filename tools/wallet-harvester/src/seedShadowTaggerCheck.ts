import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSeedShadowTagger } from "./seedShadowTagger.js";
import { HarvesterStore } from "./store.js";
import type { ExtractedWallet } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "charon-seed-shadow-"));
  const dbPath = path.join(tempRoot, "harvester.db");
  const seedListPath = path.join(tempRoot, "seed.json");
  const cohortDir = path.join(tempRoot, "cohorts", "c001");
  const evidenceDir = path.join(cohortDir, "evidence");
  const outputDir = path.join(tempRoot, "out");
  const now = Date.UTC(2026, 4, 8, 9, 0, 0);

  try {
    const store = new HarvesterStore(dbPath);
    try {
      const runId = "seed-shadow-fixture";
      store.createRun(runId);
      store.ingestWallets(buildFixtureWallets(now), runId);
      store.completeRun(runId, {
        status: "completed",
        tokensDiscovered: 2,
        tokensHarvested: 2,
        walletsNew: 2,
        walletsUpdated: 1,
        sightingsAdded: 3,
        errors: [],
      });
    } finally {
      store.close();
    }

    await fs.mkdir(evidenceDir, { recursive: true });
    await fs.writeFile(seedListPath, `${JSON.stringify(buildSeedList(), null, 2)}\n`, "utf8");
    await fs.writeFile(path.join(evidenceDir, "shared_candidate_stream.jsonl"), [
      JSON.stringify(candidate("candidate-hit", "MintHit1111111111111111111111111111111111")),
      JSON.stringify(candidate("candidate-miss", "MintMiss111111111111111111111111111111111")),
      "",
    ].join("\n"), "utf8");

    const result = await runSeedShadowTagger({
      dbPath,
      seedListPath,
      cohortDir,
      outputDir,
      generatedAt: new Date(now),
    });
    const markdown = await fs.readFile(result.operatorReportPath, "utf8");

    assert(result.report.status === "tagged_candidates", "report tags candidate rows");
    assert(result.report.summary.candidateRows === 2, "reads candidate stream");
    assert(result.report.summary.hitCandidates === 1, "finds one seed hit");
    assert(result.report.candidateTags[0]?.smartWalletSeedHit === true, "hit candidate is tagged");
    assert(result.report.candidateTags[1]?.smartWalletSeedHit === false, "miss candidate is tagged false");
    assert(!markdown.includes("DualWallet111111111111111111111111111111"), "operator report does not expose seed wallet addresses");

    console.log("Smart wallet seed shadow tagger check passed.");
    console.log(`Fixture hit candidates: ${result.report.summary.hitCandidates}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function buildSeedList(): unknown {
  return {
    schemaVersion: 1,
    listId: "fixture_seed",
    contentHash: "fixture",
    species: {
      speciesId: "smart-wallet-seed-shadow",
      mode: "shadow_candidate_feature",
    },
    wallets: [
      {
        rank: 1,
        walletAddress: "DualWallet111111111111111111111111111111",
        sourceType: "dual",
        selectionScore: 90,
      },
      {
        rank: 2,
        walletAddress: "GmgnWallet222222222222222222222222222222",
        sourceType: "gmgn_only",
        selectionScore: 50,
      },
    ],
  };
}

function buildFixtureWallets(now: number): ExtractedWallet[] {
  return [
    {
      address: "DualWallet111111111111111111111111111111",
      source: "gmgn",
      tags: ["smart_degen"],
      mint: "MintHit1111111111111111111111111111111111",
      action: "buy",
      amountUsd: 1000,
      tokenMcapUsd: 500_000,
      pnlUsd: 100,
      winRate: 0.7,
      avgBuyUsd: 250,
      timestamp: now - 1000,
      signalType: "fixture_buy",
    },
    {
      address: "DualWallet111111111111111111111111111111",
      source: "okx",
      tags: ["smart_money"],
      mint: "MintHit1111111111111111111111111111111111",
      action: "buy",
      amountUsd: 800,
      tokenMcapUsd: 500_000,
      pnlUsd: 90,
      winRate: 0.65,
      avgBuyUsd: 200,
      timestamp: now,
      signalType: "fixture_buy",
    },
    {
      address: "GmgnWallet222222222222222222222222222222",
      source: "gmgn",
      tags: ["renowned"],
      mint: "OtherMint111111111111111111111111111111111",
      action: "hold",
      amountUsd: 200,
      tokenMcapUsd: 300_000,
      pnlUsd: null,
      winRate: null,
      avgBuyUsd: null,
      timestamp: now - 500,
      signalType: "fixture_hold",
    },
  ];
}

function candidate(candidateId: string, tokenAddress: string): unknown {
  return {
    schemaVersion: 1,
    recordType: "candidate",
    cohortId: "c001",
    candidateId,
    candidateStreamId: "fixture_stream",
    tokenAddress,
    chain: "solana",
    discoveredAt: "2026-05-08T09:00:00.000Z",
  };
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
