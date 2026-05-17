<!-- workflow-generated:version=workflow-managed-v1;tool=CLAUDE.md;source=AGENTS.md -->
# Claude Code context — Charon Agent Contract
# Generated from AGENTS.md by `workflow sync`.
# Do not edit the managed section below.

<!-- workflow-managed:start -->
# Charon Agent Contract

## Global Workflow

The global workflow standard, golden rules, and ticket formats live in `~/AGENTS.md`.
The canonical Architect / Coder / Verifier role definitions, plus the reserved Tester slot, live in `~/ROLES.md`.
Do not redefine those roles in this repo; follow the global contracts and treat this file as the Charon-specific overlay.

## Project Identity

Charon is an early-trenching Telegram trench agent for Pump-token flow.
It screens noisy Pump-token signals with overlap data, strategy gates, LLM selection, and dry-run / confirm / live execution paths.

Repo path: `.`
Fork posture:
- `origin`: `medbukadnezoor/charon`
- `upstream`: `yunus-0x/charon`

## Safety Boundaries

Current approved scope is Workflow Manager v2 continuity plus wallet-pipeline tooling for smartwallet prioritization/import.

Until a future owner-approved ticket explicitly permits it:
- Do not run live trading, confirm trading, wallet signing, swap execution, or Telegram command flows.
- Do not set, read, print, copy, validate, or modify `.env`.
- Do not read or print wallet/private keys, Telegram tokens, provider keys, API keys, credentials, SQLite runtime state, runtime logs, or other secrets.
- Do not install dependencies.
- Do not start services, PM2, bot processes, app runtime, or runtime checks.
- Do not assume dry-run mode is safe to run without a separate owner-approved ticket.

Owner-approved wallet-pipeline exceptions:
- Local-only wallet harvester status/report reads are allowed.
- Public Jupiter PnL enrichment for public wallet addresses is allowed when paced and bounded.
- Charon `saved_wallets` reads/writes are allowed for owner-approved priority-wallet import only.

`.env.example`, README, package metadata, git metadata, and workflow-manager metadata may be read for inventory purposes.

## Current Task

WP-M5 and WP-M6 wallet pipeline fully landed and live on VPS (moonbags, 140.245.38.133).

### Landed milestones

| Milestone | Status | Description |
|-----------|--------|-------------|
| M5-1 | ✅ Live | `saved_wallets` schema extended (21 cached intelligence columns), `sync_saved_wallets.js` |
| M5-2 | ✅ Live | In-memory address cache + compact `evidence` in `fetchSavedWalletExposure` |
| M5-3 | ✅ Live | Compact wallet evidence in LLM payload and decision logs |
| M5-4 | ✅ Live | Jupiter PnL batching (5 addr/req, 2 req/sec, priority queue, Charon write-back) |
| M5-5 | ✅ Live | `loadWalletCache()` at Charon startup; 908 wallets synced to `/opt/trading-data/charon.sqlite` |
| M6-1 | ✅ Live | `--new-only` + `--require-enriched` flags on sync script, exit code 2 for no-op |
| M6-2 | ✅ Live | `scripts/safe_restart_charon.js` — position-safe PM2 restart |
| M6-3 | ✅ Live | `scripts/auto_sync_wallets.sh` — full harvest→enrich→sync→restart pipeline |
| M6-4 | ✅ Live | `charon-auto-sync` PM2 cron process in `ecosystem.config.cjs` (every 6h) |

### VPS layout

| Path | Description |
|------|-------------|
| `/opt/trading-data/charon.sqlite` | Charon DB (908 wallets in `saved_wallets`) |
| `/opt/trading-data/harvester.db` | Harvester DB |
| `/opt/trading-data/logs/auto-sync-YYYY-MM-DD.log` | Auto-sync pipeline logs |
| `~/charon/` | Charon repo |
| `~/moonbags/` | MoonBags repo (harvester source) |

### PM2 processes

| Name | Description |
|------|-------------|
| `charon` | Main bot (dry_run mode) |
| `charon-auto-sync` | Wallet auto-sync pipeline, runs every 6h via PM2 cron |

### Owner-approved exceptions (expanded)

In addition to the original wallet-pipeline exceptions:
- `scripts/sync_saved_wallets.js` may read/write `saved_wallets` with `--commit`
- `scripts/safe_restart_charon.js` may run `pm2 restart charon` when 0 open positions
- `scripts/auto_sync_wallets.sh` may run the full harvest→enrich→sync→restart pipeline
- `scripts/refresh_wallet_pnl.js` may call Jupiter PnL endpoint (paced, bounded)
- `ecosystem.config.cjs` may be updated for PM2 process management

## Next Safe Action

Monitor `charon-auto-sync` logs at `/opt/trading-data/logs/`. After the first enrichment
cycle populates OKX profiles, the 840 currently-unenriched wallets will start flowing
through `--require-enriched`. Run `pm2 logs charon-auto-sync` on VPS to watch.

## Charon Intelligence Consultation Access

For Charon strategy review, agents and IDEs running inside this repo may use the
separate Charon Intelligence consultation suite:

```bash
cd "../charon-intelligence"
```

Follow `../charon-intelligence/AGENTS.md` for the consultation workflow and
safety posture. Use that suite to read reports, query the knowledge base, and
produce data-backed Charon config recommendations. It is analysis-only and must
not trade, sign, send Telegram commands, read secrets, or auto-apply Charon
config changes.
<!-- workflow-managed:end -->

<!-- workflow-unmanaged:start -->
No unmanaged notes.
Add tool-specific notes here only when they cannot live in `AGENTS.md`.
<!-- workflow-unmanaged:end -->
