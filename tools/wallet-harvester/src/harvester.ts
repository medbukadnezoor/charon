// ---------------------------------------------------------------------------
// Wallet Harvester — Main Orchestrator
//
// Usage:
//   npm run harvest:run:gmgn         # bounded GMGN-only extraction + store
//   npm run harvest:run              # disabled unless explicitly enabled
//   npm run harvest:discover         # discovery only (prints tokens, no DB write)
//   npm run harvest:run -- --status  # print DB status and exit
//   npm run harvest:run -- --verbose # verbose logging
//
// Flow:
//   1. Discover trending meme tokens from GMGN
//   2. For each token, extract smart wallets from GMGN (per-token)
//   3. Optionally extract smart wallets from OKX (later phase)
//   4. Store all wallets + sightings in SQLite
//   5. Generate run report
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { loadConfig, validateConfig } from "./config.js";
import { discoverTokens } from "./discovery.js";
import { extractGmgnWallets } from "./extractors/gmgn.js";
import { extractOkxWallets } from "./extractors/okx.js";
import { HarvesterStore } from "./store.js";
import { generateReport, writeReport } from "./report.js";
import type { ExtractedWallet, RunRecord } from "./types.js";
import pino from "pino";

const logger = pino({
  name: "harvester",
  level: process.argv.includes("--verbose") ? "debug" : "info",
});

// ---------------------------------------------------------------------------
// Status command
// ---------------------------------------------------------------------------

function printStatus(store: HarvesterStore): void {
  console.log("\n=== Wallet Harvester Status ===\n");
  console.log(`Wallets:    ${store.getWalletCount()}`);
  console.log(`Sightings:  ${store.getSightingCount()}`);
  console.log(`Tokens:     ${store.getTokenCount()}`);
  console.log(`Runs:       ${store.getRunCount()}`);

  const lastRun = store.getLastRun();
  if (lastRun) {
    console.log(`\nLast run:   ${lastRun.runId}`);
    console.log(`  Status:   ${lastRun.status}`);
    console.log(`  Started:  ${new Date(lastRun.startedAt).toISOString()}`);
    console.log(`  Tokens:   ${lastRun.tokensDiscovered} discovered → ${lastRun.tokensHarvested} harvested`);
    console.log(`  Wallets:  ${lastRun.walletsNew} new, ${lastRun.walletsUpdated} updated`);
    console.log(`  Sightings: ${lastRun.sightingsAdded}`);
    if (lastRun.errors.length > 0) {
      console.log(`  Errors:   ${lastRun.errors.length}`);
    }
  } else {
    console.log("\nNo runs yet.");
  }

  const providerMetrics = store.getLatestProviderRunMetrics();
  if (providerMetrics.length > 0) {
    console.log("\nProvider tracking:");
    for (const metric of providerMetrics) {
      console.log(`  ${metric.provider}: calls=${metric.callsUsed} rateLimitHits=${metric.rateLimitHits} stoppedEarly=${metric.stoppedEarly} wallets=${metric.walletsExtracted} sightings=${metric.sightingsExtracted}`);
    }
  }

  const dualSource = store.getDualSourceWallets();
  const walletSources = store.getWalletSourceCounts();
  const sightingSources = store.getSightingSourceCounts();
  console.log(`\nDual-source wallets: ${dualSource.length}`);
  console.log(`Wallet sources: gmgn_only=${walletSources.gmgnOnly} okx_only=${walletSources.okxOnly} dual=${walletSources.dualSource}`);
  console.log(`Sighting sources: gmgn=${sightingSources.gmgn} okx=${sightingSources.okx}`);

  store.close();
}

// ---------------------------------------------------------------------------
// Main harvest loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cfg = loadConfig();

  // --status: print DB status and exit. This is local-only and does not call providers.
  if (process.argv.includes("--status")) {
    if (!fs.existsSync(cfg.dbPath)) {
      console.log("\n=== Wallet Harvester Status ===\n");
      console.log("No harvester database found yet.");
      console.log(`DB path: ${cfg.dbPath}`);
      return;
    }
    const store = new HarvesterStore(cfg.dbPath);
    printStatus(store);
    return;
  }

  if (!cfg.discoverOnly && !cfg.enableFullRun) {
    console.error("Full harvest is disabled for H0 safety.");
    console.error("Run `npm run harvest:discover` for read-only discovery.");
    console.error("Use `npm run harvest:run:gmgn` for the approved GMGN-only H1 path.");
    process.exit(1);
  }

  // Validate config
  const errors = validateConfig(cfg);
  if (errors.length > 0) {
    console.error("Configuration errors:");
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  const runId = randomUUID().slice(0, 8);
  logger.info({ runId, discoverOnly: cfg.discoverOnly }, "starting harvest run");

  // -----------------------------------------------------------------------
  // Phase 1: Discover
  // -----------------------------------------------------------------------
  const tokens = await discoverTokens(cfg);

  if (tokens.length === 0) {
    logger.warn("no tokens discovered, exiting");
    return;
  }

  // --discover-only: print tokens and exit
  if (cfg.discoverOnly) {
    console.log(`\nDiscovered ${tokens.length} tokens:\n`);
    for (const t of tokens) {
      const mcap = t.marketCapUsd >= 1_000_000
        ? `$${(t.marketCapUsd / 1_000_000).toFixed(2)}M`
        : `$${(t.marketCapUsd / 1_000).toFixed(0)}K`;
      const vol = t.volume24hUsd >= 1_000_000
        ? `$${(t.volume24hUsd / 1_000_000).toFixed(2)}M`
        : `$${(t.volume24hUsd / 1_000).toFixed(0)}K`;
      console.log(`  ${t.symbol.padEnd(12)} method=${t.discoveryMethod.padEnd(9)} mcap=${mcap.padEnd(10)} vol=${vol.padEnd(10)} smart=${t.smartWalletCount} kol=${t.kolCount}  ${t.mint.slice(0, 12)}...`);
    }
    return;
  }

  // -----------------------------------------------------------------------
  // Phase 2 & 3: Extract + Store
  // -----------------------------------------------------------------------
  const store = new HarvesterStore(cfg.dbPath);
  store.createRun(runId);

  let totalNew = 0;
  let totalUpdated = 0;
  let totalSightings = 0;
  let tokensHarvested = 0;
  let gmgnWalletsExtracted = 0;
  let gmgnSightingsAdded = 0;
  let gmgnCallsUsed = 0;
  let okxCallsUsed = 0;
  let okxRateLimitHits = 0;
  let okxStoppedEarly = false;
  const runErrors: string[] = [];

  // Store discovered tokens
  for (const token of tokens) {
    store.upsertToken(token);
  }

  // GMGN extraction: per-token
  for (const token of tokens) {
    try {
      const wallets = await extractGmgnWallets(cfg, token);
      gmgnCallsUsed += cfg.gmgnTags.length * 2;
      gmgnWalletsExtracted += wallets.length;
      if (wallets.length > 0) {
        const result = store.ingestWallets(wallets, runId);
        totalNew += result.newCount;
        totalUpdated += result.updatedCount;
        totalSightings += result.sightingCount;
        gmgnSightingsAdded += result.sightingCount;
        tokensHarvested++;
        logger.info({
          mint: token.mint,
          symbol: token.symbol,
          wallets: wallets.length,
          new: result.newCount,
          sightings: result.sightingCount,
        }, "token harvested (GMGN)");
      }
    } catch (err) {
      const msg = `GMGN extraction failed for ${token.symbol} (${token.mint}): ${String(err)}`;
      logger.error(msg);
      runErrors.push(msg);
    }
  }

  store.upsertProviderRunMetric({
    runId,
    provider: "gmgn",
    callsUsed: gmgnCallsUsed,
    rateLimitHits: 0,
    stoppedEarly: false,
    walletsExtracted: gmgnWalletsExtracted,
    sightingsExtracted: gmgnSightingsAdded,
    metadata: {
      tokensAttempted: tokens.length,
      tokensHarvested,
      tags: cfg.gmgnTags,
      minIntervalMs: cfg.gmgnMinIntervalMs,
      holderLimit: cfg.gmgnHolderLimit,
      traderLimit: cfg.gmgnTraderLimit,
    },
  });

  // OKX extraction: global (leaderboard + tracker). Disabled until H2.
  if (cfg.enableOkxExtraction) {
    try {
      const okxResult = await extractOkxWallets(cfg, tokens);
      const okxWallets = okxResult.wallets;
      okxCallsUsed = okxResult.callsUsed;
      okxRateLimitHits = okxResult.rateLimitHits;
      okxStoppedEarly = okxResult.stoppedEarly;
      const okxWithMint = okxWallets.filter(w => w.mint);
      const okxWithoutMint = okxWallets.length - okxWithMint.length;
      store.upsertProviderRunMetric({
        runId,
        provider: "okx",
        callsUsed: okxCallsUsed,
        rateLimitHits: okxRateLimitHits,
        stoppedEarly: okxStoppedEarly,
        walletsExtracted: okxWallets.length,
        sightingsExtracted: okxWithMint.length,
        metadata: {
          maxCallsPerRun: cfg.okxMaxCallsPerRun,
          minIntervalMs: cfg.okxMinIntervalMs,
          tokenContextWallets: okxWithMint.length,
          leaderboardOnlyWallets: okxWithoutMint,
        },
      });
      if (okxWallets.length > 0) {
        // OKX leaderboard wallets have no token context (mint="")
        // Split: wallets with mint go to ingestWallets, wallets without mint
        // get stored as wallet-only (no sighting)
        const withMint = okxWithMint;
        const withoutMint = okxWallets.filter(w => !w.mint);

        if (withMint.length > 0) {
          const result = store.ingestWallets(withMint, runId);
          totalNew += result.newCount;
          totalUpdated += result.updatedCount;
          totalSightings += result.sightingCount;
        }

        // For leaderboard wallets (no mint), just upsert the wallet record
        for (const w of withoutMint) {
          const { isNew } = store.upsertWallet(w);
          if (isNew) totalNew++;
          else totalUpdated++;
        }

        logger.info({
          total: okxWallets.length,
          withMint: withMint.length,
          leaderboardOnly: withoutMint.length,
          callsUsed: okxCallsUsed,
          rateLimitHits: okxRateLimitHits,
          stoppedEarly: okxStoppedEarly,
        }, "OKX extraction ingested");
      }
      if (okxStoppedEarly && okxRateLimitHits > 0) {
        runErrors.push(`OKX scan stopped early (calls=${okxCallsUsed}, rateLimitHits=${okxRateLimitHits})`);
      }
    } catch (err) {
      const msg = `OKX extraction failed: ${String(err)}`;
      logger.error(msg);
      runErrors.push(msg);
    }
  } else {
    logger.info("OKX extraction disabled for this run");
  }

  // -----------------------------------------------------------------------
  // Phase 4: Complete run + report
  // -----------------------------------------------------------------------
  const runRecord: Partial<RunRecord> = {
    tokensDiscovered: tokens.length,
    tokensHarvested,
    walletsNew: totalNew,
    walletsUpdated: totalUpdated,
    sightingsAdded: totalSightings,
    errors: runErrors,
    status: runErrors.length > 0 ? "completed" : "completed",  // completed even with partial errors
  };

  store.completeRun(runId, runRecord);

  // Generate report
  const lastRun = store.getLastRun();
  if (lastRun) {
    const report = generateReport(store, lastRun);
    const reportPath = writeReport(report, cfg.reportDir);
    logger.info({ reportPath }, "run complete");

    console.log(`\nHarvest run ${runId} complete:`);
    console.log(`  Tokens:    ${tokens.length} discovered → ${tokensHarvested} harvested`);
    console.log(`  Wallets:   ${totalNew} new, ${totalUpdated} updated`);
    console.log(`  Sightings: ${totalSightings} added`);
    console.log(`  Errors:    ${runErrors.length}`);
    if (cfg.enableOkxExtraction) {
      console.log(`  OKX:       ${okxCallsUsed} calls, ${okxRateLimitHits} rate-limit hits, stoppedEarly=${okxStoppedEarly}`);
    }
    console.log(`  Report:    ${reportPath}`);
    console.log(`  DB total:  ${store.getWalletCount()} wallets, ${store.getSightingCount()} sightings`);
  }

  store.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch(err => {
  logger.fatal({ err: String(err) }, "harvester crashed");
  process.exit(1);
});
