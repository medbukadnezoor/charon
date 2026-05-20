// ---------------------------------------------------------------------------
// Wallet Harvester — Strategy Classifier CLI Entry Point
//
// Usage:
//   npm run harvest:classify
//
// Reads DB path from the local .env file (or defaults). Classifies wallets
// using positions and trade_context — no external API calls.
// ---------------------------------------------------------------------------

import pino from "pino";
import { loadConfig } from "./config.js";
import { HarvesterStore } from "./store.js";
import { classifyWallets, DEFAULT_CLASSIFIER_CONFIG } from "./strategyClassifier.js";

const logger = pino({ name: "strategy-classifier" });

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new HarvesterStore(cfg.dbPath);

  const positionCount = store.getPositionCount();
  logger.info({ positions: positionCount }, "Starting strategy classifier");

  try {
    const result = await classifyWallets(DEFAULT_CLASSIFIER_CONFIG, store, logger);

    const botCount = store.query<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM wallet_strategies WHERE is_likely_bot = 1",
    )[0]?.cnt ?? 0;

    const archetypeRows = store.query<{ archetype: string; cnt: number }>(
      "SELECT archetype, COUNT(*) AS cnt FROM wallet_strategies GROUP BY archetype ORDER BY cnt DESC",
    );

    console.log(`\nClassified ${result.walletsClassified} wallets (${botCount} bots detected, ${result.walletsClassified} archetypes assigned)`);
    console.log(`\n=== Strategy Classifier Complete ===\n`);
    console.log(`  Wallets analyzed  : ${result.walletsAnalyzed}`);
    console.log(`  Wallets skipped   : ${result.walletsSkipped}  (too few closed positions)`);
    console.log(`  Wallets classified: ${result.walletsClassified}`);
    console.log(`  Bots detected     : ${botCount}`);
    console.log(`  Duration          : ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`\n  Archetype breakdown:`);
    for (const row of archetypeRows) {
      console.log(`    ${row.archetype.padEnd(20)} ${row.cnt}`);
    }
  } catch (err: unknown) {
    logger.error(err, "Strategy classifier failed");
    process.exit(1);
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  logger.error(err, "Strategy classifier failed");
  process.exit(1);
});
