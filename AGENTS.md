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

Until a future owner-approved ticket explicitly permits it:
- Do not run live trading, confirm trading, wallet signing, or swap execution.
- Do not set, read, print, copy, validate, or modify `.env`.
- Do not read or print wallet/private keys, Telegram tokens, provider keys, API keys, credentials, or other secrets.
- Do not install dependencies.
- Do not assume dry-run mode is safe to run without a separate owner-approved ticket.

Owner-approved exceptions (cumulative):
- `scripts/sync_saved_wallets.js` may read/write `saved_wallets` with `--commit`
- `scripts/safe_restart_charon.js` may run `pm2 restart charon` when 0 open positions
- `scripts/auto_sync_wallets.sh` may run the full harvest→enrich→sync→restart pipeline
- `scripts/refresh_wallet_pnl.js` may call Jupiter PnL endpoint (paced, bounded)
- `scripts/deploy_runner_capture_config.js` may write strategy config_json and global settings to primary DB
- `scripts/shadow_config.js set` may write SHADOW-LIVE-1 approved params (see below)
- `ecosystem.config.cjs` may be updated for PM2 process management
- PM2 start/stop/restart of `charon` is allowed via `safe_restart_charon.js` only
- PM2 start/stop/restart of `cli-proxy-api` is allowed (separate from charon, no position check needed)
- `src/` code changes are allowed on `feat/ohlcv-entry-confirmation-soft-cutoff` branch

## Current State (as of 2026-05-21)

### Active branch

`feat/ohlcv-entry-confirmation-soft-cutoff` — live on VPS. All new strategy features are on this branch.

### Live strategy: sniper

| Parameter | Value |
|-----------|-------|
| trading_mode | **live** |
| position_size_sol | 0.03 |
| tp_percent | +300% |
| sl_percent | -60% |
| dry_run_slippage_pct | 15% (price impact simulation) |
| dry_run_fee_pct | 0.5% |
| trailing_enabled | false |
| max_top20_holder_percent | 45% |
| min_fee_claim_sol | 0.50 SOL |
| require_fee_claim | false (replaced by alt gate) |
| fee_claim_alt_gate_enabled | true |
| fee_claim_alt_threshold | 40 |
| soft_cutoff_ms | 14400000 (4h) |
| soft_cutoff_recheck_ms | 3600000 (1h) |
| soft_cutoff_max_rechecks | 3 (7h total max hold) |
| reentry_enabled | true |
| reentry_window_ms | 86400000 (24h) |
| max_open_positions | 3 |

### New features live (2026-05-21)

| Feature | Description |
|---------|-------------|
| OHLCV entry confirmation | 15×1m Birdeye candles after LLM BUY — rejects local-top entries (RSI, VWAP, volume, structure) |
| Fee-claim secondary path | Tokens without fee claim route through alt quality gate (2+ wallets, 2+ sources, ≤40% holder%) instead of hard-reject |
| Soft cutoff | At 4h hold time, fetches 30×5m Birdeye candles, LLM-assisted CUT/HOLD/TIGHTEN decision |
| Re-entry rule | SL exit → 24h watchlist → OHLCV confirm → re-enter (bypasses LLM) |
| LLM payload budget | 70KB (raised from 40KB) |

### VPS layout (moonbags, 140.245.38.133)

| Path | Description |
|------|-------------|
| `/opt/trading-data/charon.sqlite` | Charon DB (2,269 wallets in `saved_wallets`) |
| `/opt/trading-data/charon-shadow.sqlite` | Shadow DB |
| `/opt/trading-data/harvester.db` | Harvester DB |
| `/opt/trading-data/logs/auto-sync-YYYY-MM-DD.log` | Auto-sync pipeline logs |
| `~/charon/` | Charon repo (branch: `feat/ohlcv-entry-confirmation-soft-cutoff`) |
| `/home/opc/.cli-proxy-api/config.yaml` | LLM proxy config |
| `/home/opc/.cli-proxy-api/` | Codex OAuth auth files (3 active accounts) |

### PM2 processes

| Name | ID | Status | Description |
|------|----|--------|-------------|
| `charon` | 22 | online | Main bot (live mode, sniper strategy) |
| `charon-shadow` | 10 | online | Shadow bot (dry_run, separate DB) |
| `charon-observation-collector` | 13 | online | Birdeye OHLCV telemetry collector |
| `charon-shadow-observation-collector` | 14 | online | Shadow telemetry collector |
| `charon-shadow-sync` | 16 | stopped (cron) | Shadow DB sync, runs every 2h |
| `charon-auto-sync` | 17 | stopped (cron) | Wallet harvest→enrich→sync pipeline, every 6h |
| `charon-shadow-notifier` | 18 | stopped (cron) | Shadow fleet Telegram notifier, every 30min |
| `cli-proxy-api` | 24 | online | LLM proxy (Codex OAuth, port 8317, no-autorestart) |

Note: stopped cron processes are normal — they run on schedule and exit cleanly (exit code 0).

### LLM proxy (cli-proxy-api)

- Binary: `/usr/local/bin/cli-proxy-api` v6.9.37
- Endpoint: `127.0.0.1:8317`
- 3 active Codex OAuth accounts (ChatGPT Plus/Pro Lite) — round-robin
- Management API enabled — key in `~/.hermes/profiles/charon/.env` → `CLIPROXY_MANAGEMENT_KEY`
- Cost: $0/call (subscription-based, not API-billed)
- Real limit: Codex 5h rolling quota per account (3× effective)

### Wallet intelligence

| Metric | Value |
|--------|-------|
| Total wallets | 2,269 |
| Jupiter enriched | 2,211 (97%) |
| GMGN enriched | 2,211 (97%) |
| OKX enriched | ~10 (0.4%) — bottleneck |
| Quality A (≥80) | 771 |
| Quality D (<40) | 1,305 (mostly unenriched) |

### Schema drift (shadow DB)

Fixed 2026-05-21. Shadow DB tables `dry_run_positions`, `saved_wallets`, `signal_events` were cosmetically drifted (column order). Migrated via `scripts/migrate_shadow_schema.js`. Backup at `/opt/trading-data/charon-shadow-backup-1779361264333.sqlite`.

`shadow_bootstrap.js` updated to use `PRAGMA table_info()` column-level comparison instead of raw SQL string equality — eliminates false drift alarms.

### SHADOW-LIVE-1 owner-approved exception

Approved 2026-05-19. Permits exactly the following live parameter changes on the `sniper` strategy via `scripts/shadow_config.js set`:

| Setting | Allowed range | Revert value |
|---|---|---:|
| `strategies.sniper.config_json.max_top20_holder_percent` | [25, 35] | 35 |
| `strategies.sniper.config_json.trending_max_bundler_rate` | [0.3, 0.5] | 0.5 |
| `strategies.sniper.config_json.max_open_positions` | [2, 5] | 5 |

Note: `max_top20_holder_percent` is now 45% (set via `deploy_runner_capture_config.js`, outside SHADOW-LIVE-1 scope). SHADOW-LIVE-1 range [25,35] still applies if using `shadow_config.js set` directly.

## Pending work

| Item | File | Status |
|------|------|--------|
| Re-entry rule planning | `.ai/plans/REENTRY_RULE_PLAN.md` | On hold — implement after live validation |
| Prompt injection investigation | `.ai/handoffs/PROMPT_INJECTION_INVESTIGATION_HANDOFF.md` | Source identified: 9Router agentic model injects CHUNKED WRITE PROTOCOL block. Not malicious. Switch to thinking-only mode to suppress. |
| OKX enrichment | — | Stalled at 10/2,269 wallets. Needs investigation. |
| Wire `buildCutoffLlmPayload` | `src/pipeline/llm.js` | Done — wired into `positions.js` soft cutoff |

## Next Safe Action

Monitor live trading on VPS. Charon is in live mode with the sniper strategy. Watch for:
1. First BUY signal passing OHLCV entry confirmation → `[entry-confirm]` in logs
2. First position opened → `[position]` in logs
3. Soft cutoff triggering at 4h → `[soft-cutoff]` in logs
4. Re-entry rule triggering after SL → `[reentry]` in logs

```bash
# Watch live logs
ssh moonbags "pm2 logs charon --lines 50 --nostream"

# Check LLM call rate
ssh moonbags "node -e \"const db=require('/home/opc/charon/node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite'); const r=db.prepare('SELECT status,COUNT(*) as n FROM llm_usage_events WHERE created_at_ms>? GROUP BY status').all(Date.now()-3600000); console.log(r);\""

# Check cli-proxy-api account health
KEY=$(grep CLIPROXY_MANAGEMENT_KEY ~/.hermes/profiles/charon/.env | cut -d= -f2)
ssh moonbags "curl -s http://127.0.0.1:8317/v0/management/auth-files -H 'Authorization: Bearer $KEY'" | python3 -m json.tool | grep -E '"email"|"status"'
```

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
