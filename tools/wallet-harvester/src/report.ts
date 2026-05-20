// ---------------------------------------------------------------------------
// Wallet Harvester — Post-Run Report Generator
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { HarvesterStore } from "./store.js";
import { loadConfig } from "./config.js";
import type { RunRecord } from "./types.js";
import pino from "pino";

const logger = pino({ name: "report" });

export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  tokensDiscovered: number;
  tokensHarvested: number;
  walletsNew: number;
  walletsUpdated: number;
  sightingsAdded: number;
  errors: string[];
  providerMetrics: Array<{
    provider: string;
    callsUsed: number;
    rateLimitHits: number;
    stoppedEarly: boolean;
    walletsExtracted: number;
    sightingsExtracted: number;
    metadata: Record<string, unknown>;
  }>;

  // Cumulative stats
  totalWallets: number;
  totalSightings: number;
  totalTokens: number;
  totalRuns: number;
  dualSourceWallets: number;
  walletSourceCounts: {
    gmgnOnly: number;
    okxOnly: number;
    dualSource: number;
  };
  sightingSourceCounts: {
    gmgn: number;
    okx: number;
  };
  topWalletsByTokenCount: Array<{
    address: string;
    tokenCount: number;
    sources: string[];
    tags: string[];
    pnlUsd: number | null;
  }>;
}

export function generateReport(store: HarvesterStore, run: RunRecord): RunReport {
  const topWallets = store.getTopWalletsByTokenCount(20);
  const dualSource = store.getDualSourceWallets();
  const walletSourceCounts = store.getWalletSourceCounts();
  const sightingSourceCounts = store.getSightingSourceCounts();
  const providerMetrics = store.getProviderRunMetrics(run.runId);

  return {
    runId: run.runId,
    startedAt: new Date(run.startedAt).toISOString(),
    finishedAt: run.finishedAt ? new Date(run.finishedAt).toISOString() : null,
    status: run.status,
    tokensDiscovered: run.tokensDiscovered,
    tokensHarvested: run.tokensHarvested,
    walletsNew: run.walletsNew,
    walletsUpdated: run.walletsUpdated,
    sightingsAdded: run.sightingsAdded,
    errors: run.errors,
    providerMetrics: providerMetrics.map(m => ({
      provider: m.provider,
      callsUsed: m.callsUsed,
      rateLimitHits: m.rateLimitHits,
      stoppedEarly: m.stoppedEarly,
      walletsExtracted: m.walletsExtracted,
      sightingsExtracted: m.sightingsExtracted,
      metadata: m.metadata,
    })),

    totalWallets: store.getWalletCount(),
    totalSightings: store.getSightingCount(),
    totalTokens: store.getTokenCount(),
    totalRuns: store.getRunCount(),
    dualSourceWallets: dualSource.length,
    walletSourceCounts,
    sightingSourceCounts,
    topWalletsByTokenCount: topWallets.map(w => ({
      address: w.address,
      tokenCount: w.tokenCount,
      sources: w.sources,
      tags: w.tags,
      pnlUsd: w.pnlUsd,
    })),
  };
}

export function writeReport(report: RunReport, reportDir: string): string {
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `run-${timestamp}.json`;
  const filepath = path.resolve(reportDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  logger.info({ filepath }, "report written");
  return filepath;
}

// ---------------------------------------------------------------------------
// CLI: npm run harvest:report
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith("report.ts") || process.argv[1]?.endsWith("report.js")) {
  const cfg = loadConfig();
  const store = new HarvesterStore(cfg.dbPath);

  const lastRun = store.getLastRun();
  if (!lastRun) {
    console.log("No runs found. Run the harvester first: npm run harvest:run");
    process.exit(0);
  }

  const report = generateReport(store, lastRun);

  console.log("\n=== Wallet Harvester Report ===\n");
  console.log(`Run:         ${report.runId}`);
  console.log(`Status:      ${report.status}`);
  console.log(`Started:     ${report.startedAt}`);
  console.log(`Finished:    ${report.finishedAt ?? "n/a"}`);
  console.log(`Tokens:      ${report.tokensDiscovered} discovered → ${report.tokensHarvested} harvested`);
  console.log(`Wallets:     ${report.walletsNew} new, ${report.walletsUpdated} updated`);
  console.log(`Sightings:   ${report.sightingsAdded} added`);
  console.log(`Errors:      ${report.errors.length}`);
  if (report.providerMetrics.length > 0) {
    for (const m of report.providerMetrics) {
      console.log(`${m.provider.toUpperCase()}:         calls=${m.callsUsed} rateLimitHits=${m.rateLimitHits} stoppedEarly=${m.stoppedEarly} wallets=${m.walletsExtracted} sightings=${m.sightingsExtracted}`);
    }
  }
  console.log();
  console.log("--- Cumulative ---");
  console.log(`Total wallets:      ${report.totalWallets}`);
  console.log(`Total sightings:    ${report.totalSightings}`);
  console.log(`Total tokens:       ${report.totalTokens}`);
  console.log(`Total runs:         ${report.totalRuns}`);
  console.log(`Dual-source wallets: ${report.dualSourceWallets}`);
  console.log(`Wallet sources:     gmgn_only=${report.walletSourceCounts.gmgnOnly} okx_only=${report.walletSourceCounts.okxOnly} dual=${report.walletSourceCounts.dualSource}`);
  console.log(`Sighting sources:   gmgn=${report.sightingSourceCounts.gmgn} okx=${report.sightingSourceCounts.okx}`);
  console.log();

  if (report.topWalletsByTokenCount.length > 0) {
    console.log("--- Top Wallets by Token Count ---");
    for (const w of report.topWalletsByTokenCount.slice(0, 10)) {
      const pnl = w.pnlUsd != null ? `$${w.pnlUsd.toFixed(2)}` : "n/a";
      console.log(`  ${w.address.slice(0, 8)}...  tokens=${w.tokenCount}  pnl=${pnl}  sources=${w.sources.join(",")}  tags=${w.tags.join(",")}`);
    }
  }

  if (report.errors.length > 0) {
    console.log("\n--- Errors ---");
    for (const e of report.errors) {
      console.log(`  - ${e}`);
    }
  }

  store.close();
}
