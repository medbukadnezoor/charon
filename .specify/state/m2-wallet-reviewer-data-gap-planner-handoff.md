# M2 Wallet Reviewer Data-Gap Planner Handoff

Created: 2026-05-12 19:25 +0700
Owner request: give this to a planner coding agent to solve why many wallets with visible GMGN data are still classified as `insufficient_data`.

## Objective

Plan the next coding ticket to make Charon's wallet LLM reviewer judge wallets from sufficient wallet-level evidence, not just sparse token-level holder/trader sightings.

The owner manually checked several wallets on GMGN and confirmed the LLM output is currently misleading: wallets that have rich GMGN wallet-page data are being marked `insufficient_data` because the local harvester DB does not contain those GMGN wallet analytics.

## Safety boundaries

Follow `./AGENTS.md`.

Do not:
- read `.env` or secret files
- print, copy, validate, or store API keys
- run Charon, PM2, Telegram, trading, signing, swaps, or wallet command flows
- install dependencies
- make unbounded provider/API calls

Allowed in this planning slice:
- read source files and existing reports/artifacts
- inspect public wallet addresses in local SQLite DBs
- design a dry-run-first implementation ticket
- propose bounded provider/API use only as a future explicitly approved coding ticket

## Current confirmed state

Charon repo:
- `.`

MoonBags wallet harvester repo:
- `../moonbags/tools/wallet-harvester`

Current artifacts:
- Latest LLM review artifact before owner feedback:
  - `reports/wallet-llm-reviews/wallet-review-1778585803267.json`
  - `reports/wallet-llm-reviews/wallet-review-1778585803267.csv`
- Latest priority export:
  - `reports/smart-wallet-priority-2026-05-12T11-36-55-195Z.json`
  - `reports/smart-wallet-priority-2026-05-12T11-36-55-195Z.csv`
- Owner screenshot evidence for `2Nu...`:
  - `~/Downloads/gmgn.ai_sol_address_2NuAgVk3hcb7s4YvP4GjV5fD8eDvZQv5wuN6ZC8igRfV (1).png`

Recent code/data fixes already landed:
- `scripts/llm_wallet_reviewer.js`
  - added `data_quality`
  - added `recommended_action=watch`
  - added targeted `--wallet-address=...`
  - added aggregate action counts and KOL/negative-PnL flags after owner feedback
  - fixed `finiteNumber(null)` so `NULL` DB fields do not become fake `0`
- MoonBags harvester:
  - `src/extractors/gmgn.ts` no longer converts unavailable GMGN holder amounts to `0`
  - `src/repairGmgnHolderAmounts.ts` repaired 1,000 historical fake-zero GMGN holder rows to `NULL`

Important: these fixes improve prompt honesty, but they do not solve the main data gap.

## Owner-labeled evidence

The owner says these LLM `insufficient_data` or weak classifications are wrong because GMGN wallet pages show sufficient wallet-level analytics:

### Should be treated as smart/profitable or at least data-sufficient

- `2NuAgVk3hcb7s4YvP4GjV5fD8eDvZQv5wuN6ZC8igRfV`
  - Owner: smart wallet.
  - Screenshot shows rich GMGN 7D wallet analytics, not insufficient data.
  - Visible screenshot details include roughly: 7D realized PnL `+1.15%`, win rate `42.69%`, token distribution `1327`, 7D TXs around `5047/5048`, 7D volume around `$899.9K`, avg buy MC mostly `$0-$100K`.
  - Local harvester row has only token-level sightings: 10 sightings, 5 target tokens, 1 older trader/sell sighting, many holder sightings.

- `2ji39D4iDuDR1m7rpJcS5ci86PLgBQkWPgwya8YQvY4h`
  - Owner: has data.

- `2tMtxBCdF7NWZxVdmBU2DFYBapEAruJVR7KWmZYSkroi`
  - Owner: has data.

- `2xTAbVhrFdHybZnxjkwfkQHLvkRKMfggL641mFKj8xWD`
  - Owner: has data, not very profitable, large drawdowns.

- `43QmFc2QPPGyMrSNuPnhvfs8BFW1XVZYFdbwURtWoo9x`
  - Owner: good profitable smart wallet.

- `55ZQuSoWHxHkCxzZvU4QP6FyNAcc6y62d3FKiEghPzAH`
  - Owner: good profitable smart wallet.

- `6Dt9J7TXM3eqyQBAZMbGJCV6VsP13WVStwPJnLPFtw2Y`
  - Owner: has data; not profitable in 7D, profitable in 30D, not the best.

### KOL / watch / avoid-entry-when-in-profit cases

- `719sfKUjiMThumTt2u39VMGn612BZyCcwbM5Pe8SqFYz`
  - Owner: same KOL from before; not profitable, just a KOL wallet.
  - Current local data: FASHR label, `provider_tags` include `kol`, negative PnL, only holder sightings.
  - Current LLM direction `remove` may be right, but verdict/reason should be "KOL/noisy/non-profitable" instead of generic `insufficient_data`.

- `69z4qTgQ5DBRTJvnQzx2h8jZhNsv5UgADotEwwKUm2JS`
  - Owner: just a KOL.

- `6EDaVsS6enYgJ81tmhEkiKFcb4HuzPUVFZeom6PHUqN3`
  - Owner: KOL but seems profitable; should be watched, but Charon should not enter when this KOL is already in profit on a token.

## Root-cause hypothesis to validate

The current LLM reviewer is mostly working with this local data:
- wallet-level aggregate from MoonBags `wallets`
- token-level `sightings`
- recent sightings from GMGN holder/trader token endpoints
- Charon `saved_wallets`

That is not the same data GMGN shows on a wallet profile page.

GMGN wallet page has richer metrics:
- 7D / 30D realized PnL
- win rate
- 7D transaction counts
- token count / distribution
- avg buy MC distribution
- recent PnL rows
- large drawdown / distribution / bought-vs-sold behavior
- KOL/social metadata

The local harvester can say "this wallet appeared on these token holder/trader lists", but cannot yet say "this wallet is actually active/profitable on GMGN over 7D/30D".

Therefore prompt-only repair is insufficient. The next coding plan should add wallet-level analytics enrichment and feed it into scoring/LLM review.

## Planner question

What is the best implementation plan to solve this correctly and safely?

Please compare at least these options:

1. **GMGN wallet-profile analytics collector**
   - Add a dry-run-first script in MoonBags wallet-harvester that fetches/stores wallet-level GMGN analytics for selected priority wallets.
   - Store normalized 7D/30D fields in SQLite.
   - Feed those fields into Charon `scripts/llm_wallet_reviewer.js` and `scripts/export_wallet_priority.js`.

2. **Use existing trade-history pipeline instead**
   - Use existing Helius/trade-history/position/strategy analysis work referenced by `STRATEGY_ANALYSIS_ADDENDUM.md`.
   - Build wallet analytics ourselves from on-chain trades instead of relying on GMGN wallet-page data.

3. **Hybrid**
   - Use GMGN wallet analytics as a fast label/feature source.
   - Use Helius/on-chain trade reconstruction for validation and strategy-classification depth.

## Required planner output

Return a concise implementation ticket with:
- recommended option and why
- exact files/modules to change
- proposed DB schema additions
- how to store owner labels/manual feedback for calibration
- how to prevent `insufficient_data` when wallet-level analytics exist
- how to classify KOL cases separately from insufficient data
- dry-run-first CLI shape
- verifier checklist
- no-secret/no-runtime safety constraints

## Suggested acceptance criteria

The next implementation should make these outcomes possible:

- `2NuAgVk3...` is not marked `insufficient_data` when GMGN wallet-level stats are available.
- `719sfKU...` is classified as KOL/noisy/non-profitable rather than generic insufficient data.
- `6EDa...` can be represented as KOL profitable/watch, with a downstream rule: do not enter when KOL is already in profit on the candidate token.
- LLM artifacts show what wallet-level analytics were used.
- Priority CSV includes fields that the owner can manually audit:
  - `gmgn_7d_pnl_pct`
  - `gmgn_30d_pnl_pct`
  - `gmgn_7d_win_rate`
  - `gmgn_7d_tx_count`
  - `gmgn_token_count`
  - `gmgn_avg_buy_mcap_bucket`
  - `kol_like`
  - `owner_manual_label`
  - `owner_manual_notes`
- No automatic deletion/removal happens from LLM output alone.

## Checks already run before this handoff

- `node --check scripts/llm_wallet_reviewer.js` passed after prompt-context patch.
- Targeted dry-run JSON for `2Nu...` and `719...` confirmed:
  - `2Nu...` context now includes 10 total sightings, 5 target tokens, 1 older trader/sell sighting, positive PnL, nullable target amount.
  - `719...` context now includes KOL-like flag, negative PnL, no trader actions, nullable target amount.
- No additional live LLM call was run after the prompt-context patch.

## First files to read

1. `./WALLET_PIPELINE_PLAN.md`
2. `./scripts/llm_wallet_reviewer.js`
3. `./scripts/export_wallet_priority.js`
4. `../moonbags/tools/wallet-harvester/src/extractors/gmgn.ts`
5. `./STRATEGY_ANALYSIS_ADDENDUM.md`
6. `~/Downloads/gmgn.ai_sol_address_2NuAgVk3hcb7s4YvP4GjV5fD8eDvZQv5wuN6ZC8igRfV (1).png`

## Next bounded step

Planner should produce the coding ticket only. Do not implement until the owner accepts the plan.
