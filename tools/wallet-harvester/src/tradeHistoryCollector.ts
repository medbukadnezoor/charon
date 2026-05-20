// ---------------------------------------------------------------------------
// Wallet Harvester — Trade History Collector CLI Entry Point
//
// Usage:
//   npm run harvest:trades
//
// Reads HELIUS_API_KEY from the local .env file. Exits early with a clear
// message if the key is missing.
// ---------------------------------------------------------------------------

import pino from "pino";
import { loadConfig } from "./config.js";
import { HarvesterStore } from "./store.js";
import { collectTradeHistory } from "./tradeHistory.js";
import type { TradeHistoryConfig } from "./tradeHistory.js";

const logger = pino({ name: "trade-history-collector" });

async function main(): Promise<void> {
  const cfg = loadConfig();

  if (!cfg.heliusApiKey) {
    console.error(
      "ERROR: HELIUS_API_KEY is not set.\n" +
      "Add it to tools/wallet-harvester/.env before running this collector.",
    );
    process.exit(1);
  }

  const store = new HarvesterStore(cfg.dbPath);

  const tradeHistoryCfg: TradeHistoryConfig = {
    heliusApiKey: cfg.heliusApiKey,
    heliusBaseUrl: cfg.heliusBaseUrl,
    lookbackDays: cfg.tradeHistoryLookbackDays,
    rateLimitMs: cfg.tradeHistoryRateLimitMs,
    maxRetries: 5,
    pageSize: 100,
  };

  logger.info(
    {
      wallets: store.getWalletCount(),
      lookbackDays: tradeHistoryCfg.lookbackDays,
      rateLimitMs: tradeHistoryCfg.rateLimitMs,
    },
    "Starting trade history collection",
  );

  try {
    const result = await collectTradeHistory(tradeHistoryCfg, store, logger);

    console.log("\n=== Trade History Collection Complete ===\n");
    console.log(`  Wallets processed : ${result.walletsProcessed}`);
    console.log(`  Wallets skipped   : ${result.walletsSkipped}  (collected < 1h ago)`);
    console.log(`  Wallets failed    : ${result.walletsFailed}`);
    console.log(`  Trades inserted   : ${result.tradesInserted}`);
    console.log(`  Trades skipped    : ${result.tradesSkipped}  (dupes / non-swap)`);
    console.log(`  Duration          : ${(result.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Total trades in DB: ${store.getTradeCount()}`);
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  logger.error(err, "Trade history collection failed");
  process.exit(1);
});
