# WP Runtime Readiness 1

Updated: 2026-05-13 07:49 +0700

VPS smoke updated: 2026-05-13 08:35 +0700

Candidate-builder smoke updated: 2026-05-13 08:58 +0700

Dry-run readiness updated: 2026-05-13 09:58 +0700

## Scope

Readiness review for moving the wallet pipeline toward VPS/runtime use without
starting Charon, Telegram, PM2, trading, signing, swaps, or any bot runtime.

## Current Curated Wallet Set

- Charon DB: `charon.sqlite`
- Current `saved_wallets`: 58
- Latest priority export basis:
  - `reports/smart-wallet-priority-2026-05-12T23-49-35-516Z.json`
  - `reports/smart-wallet-priority-2026-05-12T23-49-35-516Z.csv`
- Current saved-wallet lanes under that export:
  - `ready`: 29
  - `watch`: 29
  - `blocked`: 0
  - `owner_review`: 0

Portable seed artifact for fresh DB/VPS setup:

- `reports/charon-saved-wallets-seed-2026-05-13T00-48-52-871Z.json`
- `reports/charon-saved-wallets-seed-2026-05-13T00-48-52-871Z.csv`

Importer dry-run on the seed selected all 58 rows and would write 0 locally
because all 58 are already present.

## Path Boundary

Local defaults:

- Charon DB: `./charon.sqlite`
- Harvester DB:
  `../moonbags/tools/wallet-harvester/data/harvester.db`

VPS intended layout from the artifact-boundary plan:

- `HARVESTER_DB_PATH=/opt/trading-data/harvester.db`
- `CHARON_DB_PATH=/opt/trading-data/charon.sqlite`

Current code supports:

- Wallet scripts read `HARVESTER_DB_PATH` or `--harvester-db`.
- Importer reads `--charon-db`.
- Runtime wallet exposure reads `HARVESTER_DB_PATH` for read-only KOL/profile
  metadata joins.

## Verification Performed

- `scripts/import_priority_wallets.js` no longer imports `better-sqlite3` from
  MoonBags via `createRequire`.
- No `createRequire`, `harvesterRequire`, or `DEFAULT_HARVESTER_ROOT` remains in
  Charon `scripts/*.js` or `src/**/*.js`.
- `src/config.js` supports `CHARON_SKIP_DOTENV=true` for harnesses that need to
  import Charon modules without reading `.env`.
- `scripts/export_saved_wallets_seed.js` created a 58-wallet seed artifact from
  the current Charon DB and latest priority export.
- `scripts/import_priority_wallets.js` dry-run against the seed:
  - selected 58
  - skipped blocked 0
  - skipped other non-candidates 0
  - would insert/update 0
  - would skip existing 58
- `scripts/check_candidate_payload_shadow.js` ran without starting Charon or
  making provider calls:
  - saved wallets: 58
  - KOL-like saved wallets: 6
  - matched synthetic holders: 8
  - KOL holders in payload: 6
  - compact payload includes `savedWalletExposure` and `kolDumpRisk`
- Candidate payload artifact:
  - `reports/candidate-payload-shadow-2026-05-13T01-08-58-377Z.json`

Commands used with local Node 20:

```bash
node --check scripts/import_priority_wallets.js
node --check scripts/export_saved_wallets_seed.js
node --check scripts/check_candidate_payload_shadow.js
node scripts/export_saved_wallets_seed.js --priority=reports/smart-wallet-priority-2026-05-12T23-49-35-516Z.json
node scripts/import_priority_wallets.js --input=reports/charon-saved-wallets-seed-2026-05-13T00-48-52-871Z.json --tiers= --limit=1000
node scripts/check_candidate_payload_shadow.js --limit=8
```

## Important Behavior Note

`reports/smart-wallet-priority-2026-05-12T23-49-35-516Z.json` has 214 total
`watch` rows. The current Charon DB intentionally does not contain all of them.
It contains the owner-approved 29 `ready` plus 29 `watch` wallets from the
current curated saved-wallet state.

For a fresh VPS DB, use the `charon-saved-wallets-seed-*` artifact if the goal
is to reproduce the current 58-wallet list exactly.

## Not Run

- Charon runtime
- PM2
- Telegram polling or commands
- trading, confirm trading, signing, swaps
- provider calls
- `.env` reads or secret inspection
- broad runtime log inspection

## Next Approval Boundary

## VPS Path/Config Smoke Result

Completed on `moonbags` without starting Charon:

- Created `/opt/trading-data`
- Wrote `/opt/trading-data/harvester.db` from a SQLite backup of the VPS
  MoonBags harvester DB
- Wrote `/opt/trading-data/charon.sqlite` from the 58-wallet seed
- Verified counts:
  - `saved_wallets`: 58
  - `wallet_profiles`: 68
  - `owner_labels`: 24
- Staged a secret-free smoke checkout at `/home/opc/charon-smoke`
- Ran:

```bash
CHARON_SKIP_DOTENV=true \
DB_PATH=/opt/trading-data/charon.sqlite \
HARVESTER_DB_PATH=/opt/trading-data/harvester.db \
node scripts/check_candidate_payload_shadow.js --limit=8
```

Output:

- saved wallets: 58
- KOL-like saved wallets: 6
- matched synthetic holders: 8
- KOL holders in payload: 6
- compact payload includes `savedWalletExposure`
- compact payload includes `kolDumpRisk`

VPS artifact copied back locally:

- `reports/vps-candidate-payload-shadow-2026-05-13T01-35-03-004Z.json`

The smoke checkout does not contain `.env`, `keys`, `*.sqlite`, or `*.db`
files.

## Candidate-Builder Smoke Result

Completed locally and on `moonbags` without starting Charon:

- `CHARON_PROVIDER_STUBS=true` added to GMGN/Jupiter/Twitter enrichment modules.
- `scripts/check_candidate_builder_shadow.js` calls real `buildCandidate()` and
  real `compactCandidateForLlm()`.
- Local artifact:
  - `reports/candidate-builder-shadow-2026-05-13T01-57-56-809Z.json`
- VPS artifact:
  - `reports/vps-candidate-builder-shadow-2026-05-13T01-58-24-278Z.json`

Both local and VPS smoke results:

- saved wallets: 58
- KOL-like saved wallets: 6
- candidate holders: 8
- saved-wallet holders: 8
- KOL holders in payload: 6
- compact payload includes `savedWalletExposure`
- compact payload includes `kolDumpRisk`

No Charon service/runtime, PM2, Telegram flow, trading/signing/swap flow,
provider call, LLM call, `.env` read, dependency install, or broad log read was
run.

## Next Approval Boundary

## Strategy Matrix And Dry-Run Readiness

Added:

- `scripts/check_strategy_matrix_shadow.js`
- `scripts/dry_run_readiness.js`

VPS strategy matrix artifact:

- `reports/vps-strategy-matrix-shadow-2026-05-13T02-55-35-927Z.json`

VPS matrix result:

- `degen`: passed
- `dip_buy`: passed
- `smart_money`: failed `holders: 100 < 1000`
- `sniper`: failed missing fee claim and GMGN fees

VPS dry-run readiness artifact:

- `reports/vps-dry-run-readiness-2026-05-13T02-55-READY.json`

VPS readiness:

- `ready_for_bounded_dry_run`: true
- `trading_mode`: `dry_run`
- active strategy: `sniper`
- saved wallets: 58
- harvester wallet profiles: 68
- owner labels: 24
- open positions: 0
- pending trade intents: 0

Local readiness is false because local `charon.sqlite` has 2 open dry-run
positions and 1 pending intent.

Before any provider-backed smoke, owner approval is needed for the exact provider
scope and target mint. The minimum proposed provider-backed smoke is:

1. Verify the intended VPS data paths exist:
   - `/opt/trading-data/harvester.db`
   - `/opt/trading-data/charon.sqlite` or chosen Charon DB path
2. Use `DB_PATH` and `HARVESTER_DB_PATH` pointing at the intended VPS
   data paths.
3. Run only the one-shot candidate-builder harness with provider stubs disabled.
4. Prove one observed candidate includes:
   - `savedWalletExposure`
   - harvester metadata on matched wallets
   - `kolDumpRisk`
   - compact LLM payload fields
5. Stop immediately after the bounded check.

No Charon service/runtime, Telegram command handling, PM2, live/confirm trading,
signing, swaps, LLM call, dependency install, `.env` read, or broad log read
should be included in that smoke.
