// ---------------------------------------------------------------------------
// Wallet Harvester — GMGN public label backfill
// ---------------------------------------------------------------------------

import { loadConfig } from "./config.js";
import { extractGmgnWallets } from "./extractors/gmgn.js";
import { HarvesterStore } from "./store.js";
import type { HarvesterConfig } from "./config.js";

interface BackfillResult {
  status: "completed" | "blocked";
  dbPath: string;
  tokensSelected: number;
  walletsReturned: number;
  existingWalletsUpdated: number;
  returnedWalletsNotInStore: number;
  errors: number;
}

function argInt(name: string): number | undefined {
  const prefix = `--${name}=`;
  const raw = process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function runBackfill(): Promise<BackfillResult> {
  const cfg = loadConfig();
  if (!cfg.gmgnApiKey) {
    return {
      status: "blocked",
      dbPath: cfg.dbPath,
      tokensSelected: 0,
      walletsReturned: 0,
      existingWalletsUpdated: 0,
      returnedWalletsNotInStore: 0,
      errors: 1,
    };
  }

  const store = new HarvesterStore(cfg.dbPath);
  const limit = argInt("limit");
  const tokens = store.getGmgnRenownedMintContexts(limit);
  const renownedOnlyCfg: HarvesterConfig = { ...cfg, gmgnTags: ["renowned"] };

  let walletsReturned = 0;
  let existingWalletsUpdated = 0;
  let returnedWalletsNotInStore = 0;
  let errorCount = 0;

  try {
    for (const token of tokens) {
      try {
        const wallets = await extractGmgnWallets(renownedOnlyCfg, token);
        walletsReturned += wallets.length;

        for (const wallet of wallets) {
          if (store.updateWalletPublicMetadata(wallet)) {
            existingWalletsUpdated++;
          } else {
            returnedWalletsNotInStore++;
          }
        }
      } catch {
        errorCount++;
      }
    }
  } finally {
    store.close();
  }

  return {
    status: "completed",
    dbPath: cfg.dbPath,
    tokensSelected: tokens.length,
    walletsReturned,
    existingWalletsUpdated,
    returnedWalletsNotInStore,
    errors: errorCount,
  };
}

function printResult(result: BackfillResult): void {
  console.log(`GMGN label backfill status: ${result.status}`);
  console.log(`DB path: ${result.dbPath}`);
  console.log(`Tokens selected: ${result.tokensSelected}`);
  console.log(`Wallet rows returned: ${result.walletsReturned}`);
  console.log(`Existing wallets updated: ${result.existingWalletsUpdated}`);
  console.log(`Returned wallets not already in store: ${result.returnedWalletsNotInStore}`);
  console.log(`Token query errors: ${result.errors}`);
}

if (process.argv[1]?.endsWith("backfillGmgnLabels.ts") || process.argv[1]?.endsWith("backfillGmgnLabels.js")) {
  runBackfill()
    .then(printResult)
    .catch(err => {
      console.error(`GMGN label backfill failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
