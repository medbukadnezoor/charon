// ---------------------------------------------------------------------------
// Wallet Harvester — Trade Context Collector CLI Entry Point (S3)
//
// Usage:
//   npm run harvest:context
//
// Reads BIRDEYE_API_KEY from the local .env file. Exits early with a clear
// message if the key is missing.
// ---------------------------------------------------------------------------

import pino from "pino";
import { loadConfig } from "./config.js";
import { HarvesterStore } from "./store.js";
import { enrichTradeContext } from "./tradeContext.js";
import type { TradeContextConfig } from "./tradeContext.js";

const logger = pino({ name: "trade-context-collector" });

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.birdeyeApiKey) {
    console.error(
      "ERROR: BIRDEYE_API_KEY is not set.\n" +
      "Add it to tools/wallet-harvester/.env before running this collector.",
    );
    process.exit(1);
  }

  const store = new HarvesterStore(cfg.dbPath);

  const tradeContextCfg: TradeContextConfig = {
    birdeyeApiKey: cfg.birdeyeApiKey,
    birdeyeBaseUrl: cfg.birdeyeBaseUrl,
    birdeyeDailyCuCap: cfg.birdeyeDailyCuCap,
    recentDaysThreshold: 7,
    candlesBefore: 60,
    candlesAfter: 30,
    rateLimitMs: 1000,
  };

  logger.info(
    {
      trades: store.getTradeCount(),
      tradesWithoutContext: store.getTradesWithoutContext().length,
      birdeyeBaseUrl: cfg.birdeyeBaseUrl,
    },
    "Starting trade context enrichment",
  );

  try {
    const result = await enrichTradeContext(tradeContextCfg, store, logger);

    console.log("\n=== Trade Context Enrichment Complete ===\n");
    console.log(`  Trades processed  : ${result.tradesProcessed}`);
    console.log(`  Trades enriched   : ${result.tradesEnriched}`);
    console.log(`  Trades skipped    : ${result.tradesSkipped}  (missing OHLCV / no matching candle)`);
    console.log(`  CU consumed       : ${result.cuConsumed}`);
    console.log(`  Duration          : ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Total context rows: ${store.getTradeContextCount()}`);
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  logger.error(err, "Trade context enrichment failed");
  process.exit(1);
});
