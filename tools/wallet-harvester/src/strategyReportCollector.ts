// ---------------------------------------------------------------------------
// Wallet Harvester — Strategy Report CLI Entry Point (S5)
//
// Usage:
//   npm run harvest:report:strategy
//
// Reads DB path from the local .env file (or defaults). Generates 5 strategy
// reports into the reports/ directory. No external API calls.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { loadConfig } from "./config.js";
import { HarvesterStore } from "./store.js";
import { generateStrategyReports, DEFAULT_REPORT_CONFIG } from "./strategyReport.js";

const logger = pino({ name: "strategy-report" });

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new HarvesterStore(cfg.dbPath);

  // Resolve output dir relative to CWD
  const outputDir = path.resolve(process.cwd(), DEFAULT_REPORT_CONFIG.outputDir);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    logger.info({ outputDir }, "Created reports directory");
  }

  const strategyCount = store.getWalletStrategyCount();
  logger.info({ strategies: strategyCount, outputDir }, "Starting strategy report generation");

  try {
    const result = await generateStrategyReports(
      { ...DEFAULT_REPORT_CONFIG, outputDir },
      store,
      logger,
    );

    console.log(`\n=== Strategy Report Generation Complete ===\n`);
    console.log(`  Wallet profiles written : ${result.walletProfilesWritten}`);
    console.log(`  Duration                : ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`\n  Files written:`);
    for (const f of result.reportsWritten) {
      console.log(`    ${f}`);
    }
    console.log("");
  } catch (err: unknown) {
    logger.error(err, "Strategy report generation failed");
    process.exit(1);
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  logger.error(err, "Strategy report generation failed");
  process.exit(1);
});
