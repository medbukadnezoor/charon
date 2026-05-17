# Active State

Updated: 2026-05-13 18:00 +0700

## Current task
WP-M5 broad smart-wallet universe runtime rollout.

## Active spec/task pointer
Active plan: `SMART_WALLET_ARCH_PLAN.md`.
Current bounded task pointer: monitor the restarted VPS `charon` broad-wallet rollout and decide whether to run the optional batched Jupiter PnL refresh.

## Current focus
Use the MoonBags harvester as the broad wallet source while keeping Charon's hot path local: `saved_wallets` now carries cached GMGN/OKX/Jupiter/owner fields, `fetchSavedWalletExposure` uses an in-memory address cache, LLM/decision logs receive compact wallet evidence, and Jupiter PnL refresh is a separate batched/background script.

## Notes
- This repo is using `.specify/*` as the primary continuity layer.
- WP-M5 tickets M5-1 through M5-5 are code-complete and deployed to `/home/opc/charon` on `moonbags`.
- Local M5-5 Gate 1 dry-run reported 908 harvester wallets, 850 new inserts, 58 manual protected, tiers 206 A / 80 B / 165 C / 457 universe, stale Jupiter 908, stale GMGN 0.
- Local M5-5 Gate 2 committed 850 harvester rows into `saved_wallets`; local total is 908 wallets.
- `src/app.js` calls `loadWalletCache()` after `initDb()` and before `initLiveExecution()`.
- Static syntax checks passed for `src/app.js`, `src/db/connection.js`, `src/enrichment/wallets.js`, `src/pipeline/llm.js`, `src/db/decisions.js`, `scripts/sync_saved_wallets.js`, and `scripts/refresh_wallet_pnl.js`.
- VPS `/opt/trading-data/charon.sqlite` now has 908 saved wallets: 850 harvester rows plus 58 protected manual rows.
- PM2 `charon` was restarted and is online; startup logs include `[bot] wallet cache loaded`.
- PM2 state was saved after restart.
- Continue to avoid printing `.env`, secrets, wallet/private keys, raw logs, or broad runtime state.
