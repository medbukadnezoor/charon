import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { exportSmartWalletSeedList } from "./exportSeedList.js";
import { HarvesterStore } from "./store.js";
import type { ExtractedWallet } from "./types.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "charon-smart-wallet-seed-"));
  const dbPath = path.join(tempRoot, "harvester.db");
  const outputDir = path.join(tempRoot, "seed-output");
  const now = Date.UTC(2026, 4, 8, 8, 0, 0);
  const store = new HarvesterStore(dbPath);

  try {
    const runId = "seed-list-fixture";
    store.createRun(runId);
    store.ingestWallets(buildFixtureWallets(now), runId);
    store.completeRun(runId, {
      status: "completed",
      tokensDiscovered: 5,
      tokensHarvested: 5,
      walletsNew: 4,
      walletsUpdated: 1,
      sightingsAdded: 5,
      errors: [],
    });
  } finally {
    store.close();
  }

  try {
    const result = await exportSmartWalletSeedList({
      dbPath,
      outputDir,
      listId: "fixture_seed_wallets",
      limit: 10,
      minTokenCount: 1,
      minSightings: 1,
      generatedAt: new Date(now),
    });

    const json = JSON.parse(await fs.readFile(result.jsonPath, "utf8")) as {
      species?: { speciesId?: string; promotionEligible?: boolean; hotPathAllowed?: boolean };
      wallets?: Array<{ sourceType?: string; walletAddress?: string }>;
      guardrails?: string[];
    };
    const markdown = await fs.readFile(result.markdownPath, "utf8");

    assert(json.species?.speciesId === "smart-wallet-seed-shadow", "exports shadow species id");
    assert(json.species?.promotionEligible === false, "shadow species is not promotion eligible");
    assert(json.species?.hotPathAllowed === false, "shadow species is not hot-path eligible");
    assert(Array.isArray(json.wallets) && json.wallets.length >= 3, "exports seed wallet rows");
    assert(json.wallets[0]?.sourceType === "dual", "dual-source wallet ranks first");
    assert(markdown.includes("Full wallet addresses are stored in the JSON artifact only"), "markdown explains masking");
    assert(!markdown.includes("DualWallet111111111111111111111111111111"), "markdown masks wallet addresses");
    assert(!JSON.stringify(json).includes("privateKey"), "output does not contain private key fields");

    console.log("Smart wallet seed list check passed.");
    console.log(`Fixture selected wallets: ${json.wallets.length}`);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function buildFixtureWallets(now: number): ExtractedWallet[] {
  return [
    {
      address: "DualWallet111111111111111111111111111111",
      source: "gmgn",
      tags: ["smart_degen"],
      mint: "MintAlpha111111111111111111111111111111111",
      action: "buy",
      amountUsd: 1200,
      tokenMcapUsd: 1_000_000,
      pnlUsd: 500,
      winRate: 0.7,
      avgBuyUsd: 400,
      timestamp: now - 1000,
      signalType: "fixture_gmgn_buy",
    },
    {
      address: "DualWallet111111111111111111111111111111",
      source: "okx",
      tags: ["smart_money"],
      mint: "MintBeta1111111111111111111111111111111111",
      action: "buy",
      amountUsd: 900,
      tokenMcapUsd: 900_000,
      pnlUsd: 250,
      winRate: 0.65,
      avgBuyUsd: 350,
      timestamp: now,
      signalType: "fixture_okx_buy",
    },
    {
      address: "GmgnWallet222222222222222222222222222222",
      source: "gmgn",
      tags: ["renowned"],
      mint: "MintGamma111111111111111111111111111111111",
      action: "hold",
      amountUsd: 200,
      tokenMcapUsd: 500_000,
      pnlUsd: 50,
      winRate: 0.55,
      avgBuyUsd: 200,
      timestamp: now - 500,
      signalType: "fixture_gmgn_hold",
    },
    {
      address: "OkxWallet3333333333333333333333333333333",
      source: "okx",
      tags: ["smart_money"],
      mint: "MintDelta111111111111111111111111111111111",
      action: "buy",
      amountUsd: 350,
      tokenMcapUsd: 700_000,
      pnlUsd: 80,
      winRate: 0.6,
      avgBuyUsd: 175,
      timestamp: now - 250,
      signalType: "fixture_okx_buy",
    },
    {
      address: "FilteredWallet444444444444444444444444444",
      source: "gmgn",
      tags: ["smart_degen"],
      mint: "",
      action: "hold",
      amountUsd: null,
      tokenMcapUsd: null,
      pnlUsd: null,
      winRate: null,
      avgBuyUsd: null,
      timestamp: now - 2000,
      signalType: "fixture_gmgn_hold",
    },
  ];
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
