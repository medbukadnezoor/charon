// ---------------------------------------------------------------------------
// Wallet Harvester — Position Builder CLI Entry Point
//
// Usage:
//   npm run harvest:positions
//
// Reads DB path from the local .env file (or defaults). Builds positions from
// all trades in the trades table with no external API calls.
// ---------------------------------------------------------------------------

import pino from "pino";
import { loadConfig } from "./config.js";
import { HarvesterStore } from "./store.js";
import { buildPositions } from "./positionBuilder.js";
import type { BuildPositionsConfig } from "./positionBuilder.js";

const logger = pino({ name: "position-builder" });

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new HarvesterStore(cfg.dbPath);

  const positionsCfg: BuildPositionsConfig = {
    rateLimitMs: 10,
  };

  const tradeCount = store.getTradeCount();
  logger.info({ trades: tradeCount }, "Starting position builder");

  try {
    const result = await buildPositions(positionsCfg, store, logger);

    const totalPositions = store.getPositionCount();
    const openCount = store.query<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM positions WHERE status = 'open'",
    )[0]?.cnt ?? 0;
    const closedCount = store.query<{ cnt: number }>(
      "SELECT COUNT(*) AS cnt FROM positions WHERE status = 'closed'",
    )[0]?.cnt ?? 0;

    console.log(`\nBuilt ${result.positionsBuilt} positions from ${result.walletsProcessed} wallets (${openCount} open, ${closedCount} closed)`);
    console.log(`\n=== Position Builder Complete ===\n`);
    console.log(`  Wallets processed : ${result.walletsProcessed}`);
    console.log(`  Positions built   : ${result.positionsBuilt}  (new)`);
    console.log(`  Positions updated : ${result.positionsUpdated}`);
    console.log(`  Trades assigned   : ${result.tradesAssigned}`);
    console.log(`  Duration          : ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Total positions   : ${totalPositions}  (${openCount} open, ${closedCount} closed)`);
  } catch (err: unknown) {
    logger.error(err, "Position builder failed");
    process.exit(1);
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  logger.error(err, "Position builder failed");
  process.exit(1);
});
