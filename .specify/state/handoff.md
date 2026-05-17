# Handoff

Updated: 2026-05-13 18:00 +0700

## Current Objective

Plan the next Charon payload-scaling fix after confirming the LLM request body is
still too large when many candidates include up to 100 holder rows each.

Primary next ticket:

- `tickets/WP-M7-1-HOLDER-SUMMARY-BUDGET.md` (coder ticket, ready for implementation)

Older monitoring objective remains relevant after the payload plan is accepted:
monitor the deployed WP-M5 broad smart-wallet universe rollout on `moonbags` and
decide whether to run the optional batched Jupiter PnL refresh.

## Confirmed Local State

- Active plan: `SMART_WALLET_ARCH_PLAN.md`.
- Tickets present under `tickets/`:
  - `WP-M5-1-SAVED-WALLETS-SYNC.md`
  - `WP-M5-2-INMEMORY-CACHE.md`
  - `WP-M5-3-LLM-DECISION-LOG.md`
  - `WP-M5-4-JUPITER-BATCHING.md`
  - `WP-M5-5-RUNTIME-INTEGRATION.md`
- `src/db/connection.js` adds the M5 `saved_wallets` cached-intelligence columns.
- `scripts/sync_saved_wallets.js` syncs MoonBags harvester wallets into Charon `saved_wallets`, dry-run by default and `--commit` for writes.
- `src/enrichment/wallets.js` uses a module-level wallet cache and returns compact evidence while keeping `holderCount`, `checked`, `wallets`, and `matchedWallets`.
- `src/pipeline/llm.js` sends compact wallet exposure to the LLM.
- `src/db/decisions.js` writes compact wallet evidence to decision logs.
- `scripts/refresh_wallet_pnl.js` supports batched Jupiter PnL refresh and Charon `jup_*` write-back.
- `src/app.js` calls `loadWalletCache()` after `initDb()` and before `initLiveExecution()`, then logs `[bot] wallet cache loaded`.

## Local Gate Results From Coder

- M5-5 dry-run sync preview:
  - 908 harvester wallets.
  - 850 new harvester inserts.
  - 58 manual wallets protected.
  - Tier distribution: 206 A, 80 B, 165 C, 457 universe.
  - Stale Jupiter: 908.
  - Stale GMGN: 0.
- M5-5 commit:
  - 850 harvester rows written to local `charon.sqlite`.
  - Local total pool: 908 wallets.
  - Manual rows preserved: 58.
- Static check run in this session:
  - `node --check src/app.js`
  - `node --check src/db/connection.js`
  - `node --check src/enrichment/wallets.js`
  - `node --check src/pipeline/llm.js`
  - `node --check src/db/decisions.js`
  - `node --check scripts/sync_saved_wallets.js`
  - `node --check scripts/refresh_wallet_pnl.js`
  - All passed with no output.

## VPS State

- Host alias: `moonbags`.
- Runtime path: `/home/opc/charon`.
- PM2 process name: `charon`.
- Data paths:
  - `/opt/trading-data/charon.sqlite`
  - `/opt/trading-data/harvester.db`
- Existing shortcuts:
  - `ssh moonbags chs`
  - `ssh moonbags chstop`
  - `ssh moonbags chstart`
  - `ssh moonbags chr`
- Code/docs/scripts/tickets were synced to `/home/opc/charon`, excluding `.env`, keys, DBs, reports, backups, and node_modules.
- M5 schema migration was applied to `/opt/trading-data/charon.sqlite` with `CHARON_SKIP_DOTENV=true`.
- `scripts/sync_saved_wallets.js --commit` was run on VPS against `/opt/trading-data/harvester.db` and `/opt/trading-data/charon.sqlite`.
- VPS `saved_wallets` count is 908:
  - harvester A: 152
  - harvester B: 76
  - harvester C: 165
  - harvester universe: 457
  - manual universe: 58
- Read-only settings check showed `trading_mode=dry_run`.
- PM2 `charon` was restarted, is online, and startup logs include `[bot] wallet cache loaded`.
- PM2 state was saved after restart.

## Safety Boundaries

Allowed by current owner request already completed:

- Update WFM v2 continuity docs.
- Synced safe repo code/artifacts to `/home/opc/charon`.
- Ran secret-safe DB migration/sync commands against `/opt/trading-data/charon.sqlite`.
- Restarted only PM2 `charon`.

Do not:

- Print or inspect `.env`, API keys, wallet/private keys, Telegram tokens, or raw secret-bearing config.
- Start, stop, or mutate unrelated PM2 processes.
- Run live trading, confirm trading, wallet signing, swaps, or Telegram command flows.
- Run broad raw logs. If checking logs, keep the window narrow and summarize.

## What to do next

1. Run the Planner / Architect pass for `tickets/WP-M7-LLM-PAYLOAD-BUDGET-PLANNER.md`.
2. Produce a budgeted LLM payload architecture before any coder trims fields.
3. Then continue monitoring candidate filters for improved wallet overlap rates.
4. Decide whether to run `scripts/refresh_wallet_pnl.js --limit=908 --commit` on VPS to populate stale Jupiter `jup_*` fields.
5. If monitoring logs, use narrow windows and summarize; do not dump broad raw logs.

## Expected Result

VPS `charon` is running in dry-run guarded mode with the broad wallet cache loaded. Candidate payloads should report `savedWalletExposure.checked` near 908 instead of the old 58-wallet set.
