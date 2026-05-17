# Planner Handoff: MoonBags Harvester / Charon Runtime Ownership

Updated: 2026-05-13

## Objective

Ask a planner agent to decide the best architecture for the wallet harvester now that it is no longer practically separable from Charon.

The current harvester implementation lives under MoonBags:

`../moonbags/tools/wallet-harvester`

But Charon now depends on its database and enrichment outputs for the smart-wallet pipeline:

`.`

Both Charon and the harvester are expected to run on the VPS later, so the project needs a clean ownership/runtime decision before more automation is added.

## Why This Matters

Charon's smart-wallet behavior now depends on wallet-harvester artifacts:

- `harvester.db`
- `wallets`
- `sightings`
- `wallet_profiles`
- `owner_labels`
- GMGN wallet-level enrichment
- optional OKX enrichment

Charon currently reads those from the MoonBags harvester DB. That worked for local development, but on VPS this becomes an operational coupling problem:

- deployment paths span two projects
- secrets and provider keys currently belong to MoonBags harvester
- Charon's import/review pipeline assumes the harvester DB is available
- OKX local enrichment is blocked by local ISP/TLS interception, but should work on VPS or through WARP
- automated schedules will need one owner, one run order, and clear failure behavior

## Latest Confirmed State

Charon wallet pipeline status:

- Charon `saved_wallets` is currently reconciled to 62 approved `ready` wallets.
- A paced Jupiter PnL smoke against those 62 wallets returned 62 HTTP 200, 0 429, 0 errors.
- Latest approved baseline export before the M2b stress pass:
  - `reports/smart-wallet-priority-2026-05-12T15-57-21-464Z.json`
  - `reports/smart-wallet-priority-2026-05-12T15-57-21-464Z.csv`
- M2b controlled LLM review was run later after GMGN profile enrichment:
  - latest review artifact: `reports/wallet-llm-reviews/wallet-review-1778603942110.json`
  - latest export: `reports/smart-wallet-priority-2026-05-12T16-39-19-056Z.json`
  - for current saved wallets: 30 ready, 19 watch, 8 owner_review, 5 blocked
  - this latest result was not applied to `saved_wallets` because it still had 18 `insufficient_data` judgments.
- Focused owner-review CSV created:
  - `reports/wallet-review-blocked-owner-review-2026-05-13.csv`

MoonBags harvester status relevant to Charon:

- GMGN-only harvest reached 908 wallets / 1337 sightings with 0 rate-limit hits.
- GMGN holder fake-zero amount bug was fixed and historical fake-zero rows were repaired.
- `src/enrichWalletProfile.ts` now creates and updates:
  - `wallet_profiles`
  - `owner_labels`
- GMGN profile enrichment has successfully stored 62/62 profiles for current Charon saved wallets.
- OKX enrichment failed locally due TLS interception: `web3.okx.com` returned an `internetpositif.id` certificate. No TLS bypass was attempted.

## Current Couplings

Charon reads MoonBags harvester data in:

- `scripts/export_wallet_priority.js`
- `scripts/llm_wallet_reviewer.js`
- `scripts/refresh_wallet_pnl.js`

Charon expects harvester DB default path:

`../moonbags/tools/wallet-harvester/data/harvester.db`

The harvester itself owns provider integration code for:

- GMGN discovery/profile APIs
- OKX signed wallet profile/portfolio calls
- existing rate-limit and runtime config handling

## Planner Question

Decide the best long-term boundary:

### Option A: Keep Harvester Owned By MoonBags, Charon Consumes Its DB

Pros:
- minimal code movement
- reuses existing GMGN/OKX harvester keys and extractor code
- keeps the harvester as one shared data collector

Cons:
- Charon production runtime depends on a sibling project path
- deployment and backups span two repos
- Charon's wallet pipeline is harder to reason about as a self-contained service

### Option B: Promote Wallet Harvester To Shared Tool/Service

Pros:
- honest ownership: neither MoonBags nor Charon owns it exclusively
- both projects can consume the same generated DB/artifacts
- easier to schedule as an independent VPS process

Cons:
- needs migration planning, paths, docs, and service naming
- may require repo split or workspace-level service folder
- extra coordination before automation

### Option C: Move/Copy Harvester Into Charon

Pros:
- Charon becomes self-contained for smart-wallet runtime
- one deployment unit for Charon wallet pipeline
- simpler Charon-specific scheduling

Cons:
- duplicates or moves code currently useful to MoonBags
- secrets/key ownership must be redesigned
- more migration risk and possible drift if MoonBags still needs the harvester

### Option D: Keep Code In MoonBags But Materialize Charon-Specific Artifacts

Example:
- MoonBags harvester runs on VPS.
- It writes stable artifacts to a shared location such as `/opt/trading-data/wallet-harvester/`.
- Charon reads only that stable artifact path, not the MoonBags repo path.

Pros:
- minimal code movement
- cleaner production path
- Charon no longer depends on local repo layout
- easier backup and sync story

Cons:
- still has cross-project operational dependency
- requires a small artifact contract and health checks

## Planner Deliverable Requested

Return a recommendation with:

1. Preferred ownership model for VPS.
2. Whether harvester should remain in MoonBags, move into Charon, or become shared.
3. Recommended production paths for:
   - harvester code
   - harvester DB
   - exported wallet priority artifacts
   - Charon DB
   - logs
4. Secret boundary:
   - which process owns GMGN/OKX keys
   - whether Charon should ever read harvester provider keys
   - how LLM key should be injected for reviewer runs
5. Runtime schedule:
   - harvest cadence
   - GMGN profile enrichment cadence
   - OKX enrichment cadence
   - LLM review cadence
   - Charon import/reconcile cadence
6. Failure behavior:
   - what happens if OKX fails
   - what happens if GMGN profile enrichment fails
   - what happens if LLM reviewer returns many `insufficient_data`
   - what happens if Jupiter returns 429
7. Migration plan:
   - local development changes
   - VPS deployment changes
   - rollback path
8. Tests/checks before enabling automation.

## Suggested Recommendation Bias

Start by seriously evaluating Option D: keep the harvester implementation where it is for now, but stop making Charon depend on a sibling repo path. Materialize a stable harvester DB/artifact directory that both local and VPS workflows can point to via env/config.

This may be the lowest-risk bridge before deciding whether to split the harvester into a shared service later.

## Safety Boundaries

Planner must not propose or run:

- Charon runtime start
- PM2 service start
- Telegram flows
- trading, signing, swaps
- dependency installs
- secret printing
- `.env` contents inspection
- broad runtime log inspection

Secrets should remain process-owned:

- GMGN/OKX keys belong to the harvester process.
- Charon should consume sanitized DB/artifacts, not provider credentials.
- LLM key should remain runtime-injected or stored only in a private, ignored operator-controlled file outside the repo.

## Evidence To Read First

In Charon:

- `AGENTS.md`
- `WALLET_PIPELINE_PLAN.md`
- `.specify/state/progress.md`
- `.specify/state/handoff.md`
- `scripts/export_wallet_priority.js`
- `scripts/llm_wallet_reviewer.js`
- `scripts/import_priority_wallets.js`

In MoonBags harvester:

- `../moonbags/tools/wallet-harvester/src/enrichWalletProfile.ts`
- `../moonbags/tools/wallet-harvester/src/harvester.ts`
- `../moonbags/tools/wallet-harvester/src/extractors/okx.ts`
- `../moonbags/tools/wallet-harvester/package.json`

## Exact Next Step For Planner

Produce an architecture decision brief, not code.

The output should end with one bounded implementation ticket for the coder. The first implementation ticket should avoid service automation and should only establish the chosen artifact/config boundary locally, with dry-run verification.
