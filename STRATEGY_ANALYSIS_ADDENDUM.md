# Strategy Analysis Addendum

Created: 2026-05-12
Status: In progress — S1 complete, S2 next
Related: [WALLET_PIPELINE_PLAN.md](./WALLET_PIPELINE_PLAN.md)
Full plan: [moonbags/tools/wallet-harvester/STRATEGY_ANALYSIS_PLAN.md](../moonbags/tools/wallet-harvester/STRATEGY_ANALYSIS_PLAN.md)

## Overview

This addendum covers two things that extend the wallet pipeline:

1. **Strategy analysis pipeline (S1-S5)** — offline research tooling inside
   the wallet-harvester to reverse-engineer how smart wallets trade: their
   entry/exit patterns, DCA behavior, TP/SL parameters, and which technical
   indicators align with their trades. Output is reports only — no config
   changes without owner approval.

2. **Periodic harvester trigger from Charon** — Charon calls the wallet
   harvester every 6 hours while running to continuously grow the wallet
   database without manual intervention.

---

## Part 1: Strategy analysis pipeline

### What it is

An expansion of the wallet-harvester tooling (`moonbags/tools/wallet-harvester`)
that adds five new analysis stages alongside the existing harvest/export flow:

| Stage | What | New file |
|-------|------|----------|
| S1 | Pull full swap history per wallet from Helius | `src/tradeHistory.ts` |
| S2 | Reconstruct positions (group buys/sells, detect DCA/partial TPs) | `src/positionBuilder.ts` |
| S3 | Pull Birdeye BDS OHLCV around each trade, compute RSI/BB/VWAP/ATR | `src/tradeContext.ts` + `src/indicators.ts` |
| S4 | Classify each wallet into archetypes, extract TP/SL parameters | `src/strategyClassifier.ts` |
| S5 | Reports: per-wallet profiles, optimal TP/SL, entry indicator correlations | `src/strategyReport.ts` |

All new tables land in the existing `harvester.db`. No writes to Charon's
`charon.sqlite` and no changes to Charon's strategy config until the owner
explicitly approves findings.

### S1 — Trade history collector (current work)

**Data source:** Helius Enhanced Transactions API
- Endpoint: `GET https://api.helius.xyz/v0/addresses/{address}/transactions`
- Query params: `api-key`, `type=SWAP`, `limit=100`, `before={cursor}` for pagination
- Returns parsed swap data: token mints, amounts, SOL amounts, timestamps,
  program IDs (Jupiter, Pump AMM, Raydium, Orca)
- Helius API key comes from `HELIUS_API_KEY` env var in the harvester's own
  `.env` file (isolated from Charon's `.env`)

**New table: `trades`**
```sql
CREATE TABLE IF NOT EXISTS trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address  TEXT NOT NULL,
  signature       TEXT NOT NULL UNIQUE,
  mint            TEXT NOT NULL,
  side            TEXT NOT NULL,
  token_amount    REAL NOT NULL,
  sol_amount      REAL NOT NULL,
  usd_amount      REAL,
  price_usd       REAL,
  price_sol       REAL,
  timestamp       INTEGER NOT NULL,
  program         TEXT,
  slot            INTEGER,
  raw_json        TEXT,
  collected_at_ms INTEGER NOT NULL
);
```

**Rate limiting:** 2 req/sec with exponential backoff on 429. Full 908-wallet
pass takes ~30-60 minutes. Incremental on re-run (only fetches new signatures).

**npm script added:** `harvest:trades` — runs the collector standalone.

**Check script:** `src/tradeHistoryCheck.ts` — fixture-only, zero live calls,
validates the Helius response parser and DB write logic.

### S1 env var requirements

Add to `moonbags/tools/wallet-harvester/.env`:
```
HELIUS_API_KEY=<same key as in charon/.env>
TRADE_HISTORY_LOOKBACK_DAYS=30
TRADE_HISTORY_RATE_LIMIT_MS=500
```

### Remaining stages (S2-S5)

See [STRATEGY_ANALYSIS_PLAN.md](../moonbags/tools/wallet-harvester/STRATEGY_ANALYSIS_PLAN.md)
for the full spec of each stage. Stages will be implemented sequentially after
S1 passes its check script and owner review.

---

## Part 2: Periodic harvester trigger from Charon

### Goal

While Charon is running, trigger a wallet harvest run every 6 hours so the
harvester DB grows continuously without the owner having to manually kick off
runs.

### Architecture

A new file `src/signals/walletHarvester.js` in Charon spawns the harvester
as a child process using `node:child_process`. It does not import harvester
code directly — the harvester is a separate project with its own dependencies.

```
Charon runtime
  └── setInterval every 6h
        └── src/signals/walletHarvester.js
              └── spawn: tsx harvester.ts (in moonbags/tools/wallet-harvester)
                    └── GMGN-only run (same as `harvest:run:gmgn`)
                    └── writes to harvester.db
                    └── stdout/stderr logged to Charon console
```

### Integration point in app.js

In `src/app.js`, after the existing `setInterval` calls:

```js
// Wallet harvest — runs every 6h to grow the smart wallet DB
const HARVESTER_INTERVAL_MS = 6 * 60 * 60 * 1000;
const { scheduleWalletHarvest } = await import('./signals/walletHarvester.js');
scheduleWalletHarvest(HARVESTER_INTERVAL_MS);
```

### Safety constraints

- Spawns as a detached child process with a hard timeout (30 min max)
- If the harvester crashes or times out, Charon logs the error and continues
  — harvester failure is non-fatal to Charon
- Does not block Charon's event loop (async spawn, stdout piped to log)
- Does not import any Charon trading path code into the harvester
- Does not read Charon's `.env` for the spawned process — harvester uses its
  own `.env`
- New env var in Charon `.env.example`:
  ```
  WALLET_HARVESTER_ENABLED=true
  WALLET_HARVESTER_INTERVAL_HOURS=6
  WALLET_HARVESTER_PATH=../moonbags/tools/wallet-harvester
  WALLET_HARVESTER_TIMEOUT_MINUTES=30
  ```

### Status reporting

The harvester trigger logs to Charon console:
```
[harvester] starting scheduled run (next in 6h)
[harvester] run complete: 12 new wallets, 89 updated, 45 sightings
[harvester] run failed: <error> — will retry in 6h
```

Optionally, a Telegram notification can be sent on completion (owner-toggleable
via `WALLET_HARVESTER_TELEGRAM_NOTIFY=true`). Not implemented in the first pass.

### What this is NOT

- Does not auto-import harvested wallets into Charon's `saved_wallets` — that
  still requires the manual export/review/import flow from the wallet pipeline
  plan (M3a)
- Does not change any trading parameters
- Does not run on startup (first run is after the first 6h interval)

---

## Implementation status

| Item | Status |
|------|--------|
| S1 trade history collector | **Done** — 10/10 checks pass, typecheck clean |
| S2 position reconstructor | Next |
| S3 OHLCV context + indicators | Planned |
| S4 strategy classifier | Planned |
| S5 report generator | Planned |
| Charon periodic harvester trigger | Planned — implement after S2 lands |

---

## Owner approval gates

None of the strategy analysis outputs (S1-S5) change Charon's behavior.
They are reporting only.

The periodic harvester trigger (Part 2) **does** add code to Charon's `app.js`
and a new file `src/signals/walletHarvester.js`. This requires owner approval
before implementation. The spec above is the design for review.
