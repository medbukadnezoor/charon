# Wallet Harvester

Standalone Charon tool for building a seed database of smart-wallet and KOL
addresses. The harvester is intentionally outside the Charon trading hot path:
it does not import from Charon runtime modules, does not trade, does not read the
repo root `.env`, and does not touch cohorts, genomes, runtime state, Telegram,
PM2, or wallet files.

## H0 Safety Mode

Only read-only discovery is enabled in the first phase:

```bash
npm run harvest:discover
```

This command calls GMGN discovery endpoints, prints owner-checkable token rows,
and exits without creating SQLite databases or reports.

Required local configuration lives in `tools/wallet-harvester/.env`:

```bash
GMGN_API_KEY=...
```

Do not put wallet private keys in this file. OKX credentials are optional for
discovery and GMGN-only runs.

## H1 GMGN-Only Extraction

The first storage-enabled path is GMGN-only:

```bash
HARVESTER_MAX_TOKENS_PER_RUN=5 npm run harvest:run:gmgn
```

This discovers tokens, extracts GMGN smart/KOL holder and trader rows, writes
SQLite records, and emits a JSON run report. It does not call OKX and does not
schedule anything.

## H2 GMGN + OKX Extraction

OKX extraction is explicitly gated and uses the same fail-closed full-run switch:

```bash
HARVESTER_MAX_TOKENS_PER_RUN=40 npm run harvest:run:okx
```

Required OKX configuration lives in `tools/wallet-harvester/.env`:

```bash
OKX_API_KEY=...
OKX_SECRET_KEY=...
OKX_PASSPHRASE=...
OKX_PROJECT_ID=...
```

The default OKX pacing is `HARVESTER_OKX_MIN_INTERVAL_MS=1200`, which keeps the
trial-tier path below 1 request per second. The default per-run OKX ceiling is
`HARVESTER_OKX_MAX_CALLS_PER_RUN=55`; 429 or OKX `50011` responses stop OKX scan
expansion for that run.

OKX currently scans Solana leaderboard lists for KOL, Smart Money, and Pump
Smart Money wallets across timeframes and sort modes, then checks Smart
Money/KOL tracker trades for discovered token mints.

## Disabled Until Later Tickets

Generic full harvesting is still fail-closed. `npm run harvest:run` exits unless
the operator deliberately sets `HARVESTER_ENABLE_FULL_RUN=true` or passes
`--enable-full-run`. OKX extraction remains disabled unless
`HARVESTER_ENABLE_OKX=true` or `--enable-okx` is set.

The disabled phases include:

- cron or PM2 scheduling

## Local Checks

```bash
npm run typecheck
npm run harvest:discover
find data reports -maxdepth 1 -type f -print
```

The final command should show only `.gitkeep` files after discover-only.

## Wallet Review CSV

Export the current wallet database to a review CSV with direct GMGN wallet links:

```bash
npm run harvest:export:wallets
```

The CSV is written under `reports/wallet-review-*.csv` and includes wallet
address, `https://gmgn.ai/sol/address/{wallet}`, public GMGN display metadata,
source type, classification tags, sighting counts, PnL snapshot fields, and
blank review columns for manual classification.

## GMGN KOL Label Backfill

Backfill public GMGN display metadata for already harvested KOL wallets:

```bash
npm run harvest:backfill:gmgn-labels -- --limit=2
npm run harvest:export:wallets
```

The backfill re-queries GMGN `token_top_holders` and `token_top_traders` with
`tag=renowned` for distinct GMGN KOL token mints already present in the local
SQLite database. It updates only aggregate wallet metadata in the harvester
database and prints aggregate counts; it does not create trading/runtime
artifacts or print provider credentials.

## Smart Wallet Seed Species Export

Export a lab-facing, shadow-only seed list for the future smart-wallet species:

```bash
npm run harvest:export:seed-list
```

Default outputs:

- `../../lab/smart-wallet-seeds/smart_wallet_seed_v0.json`
- `../../lab/smart-wallet-seeds/smart_wallet_seed_v0.md`

The export reads only the local harvester SQLite database. It does not call
providers, change runtime settings, or affect the MVP scorecard. The JSON stores
full public wallet addresses for local review and should remain uncommitted; the
Markdown file masks wallet addresses for operator summaries.
