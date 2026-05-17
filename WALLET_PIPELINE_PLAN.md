# Wallet Pipeline Improvement Plan

Created: 2026-05-12
Status: In progress

## Implementation log

- 2026-05-12: Owner confirmed the priority CSV scores matched wallets they want
  to follow.
- 2026-05-12: Added `scripts/refresh_wallet_pnl.js` for paced Jupiter PnL
  refresh of the harvester DB.
- 2026-05-12: Hardened `scripts/export_wallet_priority.js` so stale PnL is not
  counted, frequency scoring requires enough observation time, and scoring
  metadata is written into JSON exports.
- 2026-05-12: Added `scripts/import_priority_wallets.js`, dry-run-first with
  `--commit` required for writes.
- 2026-05-12: Imported A/B priority wallets from
  `reports/smart-wallet-priority-2026-05-12T08-14-35-939Z.json` into Charon
  `saved_wallets`: 70 inserted, 0 updated, 0 skipped.
- 2026-05-12: Updated M2 defaults to Xiaomi MiMo `mimo-v2.5-pro` at
  `https://token-plan-sgp.xiaomimimo.com/v1`; live mode accepts either
  `LLM_API_KEY` or `XIAOMIMIMO_API_KEY` from the operator invocation and writes
  JSON/CSV review artifacts for owner inspection.
- 2026-05-12: Implemented M2d KOL dump-risk enrichment in the candidate
  pipeline as a soft LLM/logging signal. Verified with static `node --check`
  only; no runtime, provider, Telegram, trading, signing, swap, `.env`, or log
  access was run.
- 2026-05-12: Implemented M3b stale-wallet scaffold. Priority exports mark
  wallets as `stale` after 3 consecutive latest LLM `remove` recommendations,
  and the importer skips stale rows by default. No deletion path was added.
- 2026-05-12: Ran a bounded 3-wallet live LLM smoke with an operator-provided
  runtime key. The Token Plan base rejected the `sk-...` key, matching the
  cached docs that Token Plan expects `tp-...` keys, so the smoke used the
  pay-as-you-go MiMo base override. It stored 3 `wallet_llm_reviews`, wrote
  owner-review artifacts, regenerated the priority export, and ran importer
  dry-run only.
- 2026-05-12: Repaired the M2 reviewer prompt after owner compared the first
  live-smoke wallet against GMGN. Holder endpoint `amount_usd=0` is now
  represented as unavailable source data, sparse harvester coverage is passed
  as `data_quality`, and sparse `insufficient_data` reviews can use
  `recommended_action=watch` so formula-strong wallets are not demoted solely
  because local harvester context is thinner than GMGN's live wallet page.
- 2026-05-12: Fixed the upstream MoonBags GMGN harvester extractor so future
  holder rows no longer convert missing `usd_value` fields into real
  `amount_usd=0` sightings. Added a zero-live-call extractor check. Existing
  historical rows still require repair or re-harvest before they stop carrying
  old fake-zero holder amounts.
- 2026-05-12: Added and ran a dry-run-first MoonBags historical repair for
  GMGN holder sightings. Backed up `data/harvester.db`, converted 1,000 old
  GMGN holder `amount_usd=0` rows to `NULL`, verified the repair count dropped
  to 0, regenerated the Charon priority export, and fixed an importer CLI
  numeric-argument bug where omitted `--limit` parsed as `0`.
- 2026-05-12: Ran a bounded 15-wallet live LLM reviewer pass against the
  repaired data using an operator-provided runtime key and the pay-as-you-go
  MiMo base. Stored 15 new reviews across 3 batches, wrote owner-review
  artifacts, regenerated the priority export, and confirmed importer dry-run
  still selects 70 A/B wallets with 0 stale rows.
- 2026-05-12: Patched the LLM reviewer prompt context after owner flagged
  `2Nu...` and `719...` misclassifications. The prompt now includes all-time
  and target holder/trader/buy/sell/hold counts, KOL-like and negative-PnL
  profile flags, and preserves nullable numeric DB fields as `null` instead of
  converting them to `0`. Verified with targeted dry-run JSON only.
- 2026-05-12: Implemented WP-M2-ENRICH-1 scaffold. MoonBags wallet-harvester
  now has dry-run-first `enrich:profiles` / `src/enrichWalletProfile.ts` for
  GMGN wallet-profile analytics and optional paced OKX portfolio fill-in,
  creating `wallet_profiles` and `owner_labels`. Charon reviewer/export now
  read those tables only from `harvester.db`; Charon makes no provider calls.
  No live provider enrichment was run in this slice.
- 2026-05-12: Ran bounded live GMGN+OKX profile enrichment for the 10
  owner-flagged wallets using MoonBags harvester keys, then reran targeted
  MiMo review. Result: 10/10 owner-flagged wallets now have GMGN and OKX
  profile rows; the targeted LLM retest returned no `insufficient_data`
  verdicts. Latest priority export selected 69 A/B wallets and skipped 1 stale
  row. Follow-up needed: decide whether a latest `remove` review should block
  import immediately, because `69z...` remains A-tier by formula while latest
  LLM says `remove`.

## Related documents

- [STRATEGY_ANALYSIS_ADDENDUM.md](./STRATEGY_ANALYSIS_ADDENDUM.md) — strategy
  reverse-engineering pipeline (S1-S5) and periodic harvester trigger from
  Charon. Covers the Helius trade history collector, position reconstruction,
  Birdeye OHLCV indicator enrichment, and wallet strategy classification.
  **Read this before starting work on S1 or the Charon harvester trigger.**

## Problem

Charon uses `saved_wallets` as a smart-money filter. The wallet harvester
(moonbags) collects wallets from GMGN trending/trenches/signals, but:

- Importing all 908+ raw wallets creates noise (many are inactive, bots, or
  trade outside Charon's target range)
- The current scoring script (`scripts/export_wallet_priority.js`) relies on
  stale PnL data (578/908 wallets have snapshots older than 3 days)
- Win rate is nonzero for only 468/908 wallets
- Tier thresholds (A/B/C/watch) are uncalibrated — no ground truth
- No LLM quality pass to catch anomalies, bots, or inflated PnL
- Charon's `saved_wallets` table is currently empty

## Goal

Build a pipeline that:
1. Harvests wallets aggressively (keep all data)
2. Enriches with fresh PnL
3. Scores and ranks with reliable metrics
4. Runs an LLM reviewer to catch what formulas miss
5. Exports a curated shortlist for Charon
6. Gives the owner final approval before import

## Current state

| Metric | Value |
|--------|-------|
| Harvester wallets | 908 |
| Harvester sightings | 1337 |
| Harvester tokens | 76 |
| PnL snapshots fresh (<1 day) | 255 |
| PnL snapshots stale (>3 days) | 578 |
| Nonzero win rate | 468/908 |
| Charon saved_wallets | 70 A/B priority wallets imported |
| LLM model | Xiaomi MiMo `mimo-v2.5-pro` via `token-plan-sgp.xiaomimimo.com/v1` |

## Design note: KOL dump-risk signal

KOL/renowned wallets that are already profitable on a token are more likely to
dump on new entry liquidity. Conversely, if they are underwater they are
incentivized to hold. This is a soft signal — not a hard filter — because
sometimes a profitable KOL holding is genuinely bullish.

**Implementation approach:**
- When `fetchSavedWalletExposure` finds a matched KOL/renowned wallet holding
  the candidate token, call `fetchJupiterWalletPnl(walletAddress)` (already
  exists in `src/enrichment/jupiter.js:209`) and check PnL on the specific mint
- The intersection of "saved wallets that are KOLs AND hold this token" is
  typically 0-2 wallets per candidate, so the extra Jupiter calls are negligible
- Pass the result to the LLM as a risk factor, not a hard gate:
  - "KOL @handle is +120% on this token — dump risk elevated"
  - "KOL @handle is -40% on this token — likely to hold"
- Log the signal in `decision_logs` for post-analysis

**Where it lands in milestones:**
- M2a adds the KOL PnL check to the wallet reviewer's evaluation context
- M2d (new) adds the runtime KOL dump-risk enrichment to the candidate pipeline
  so the LLM candidate selector in `src/pipeline/llm.js` can weigh it

## Milestones

### M0 — Manual wallet review (no code)

**Goal:** Establish ground truth before building anything else.

**Steps:**
- Open `reports/smart-wallet-priority-*.csv`
- Check 30-50 wallets on GMGN (links in CSV `gmgn_url` column)
- Fill in `manual_rating` (1-5) and `manual_notes` columns
- Focus on:
  - Do they trade under-200K mcap tokens?
  - How frequently do they trade?
  - Are they actually profitable on those trades?
  - Are they bots, copy-traders, or genuine smart traders?

**Output:** A rated CSV with human ground truth for ~30-50 wallets.

**Depends on:** Nothing. Do this first.

---

### M1 — Fix scoring data quality

#### M1a — Fresh PnL enrichment script

**Status:** Implemented. Full refresh not yet run end-to-end; only a 2-wallet
dry-run sample was executed to verify the Jupiter path without producing 429s.

**Goal:** Get reliable PnL and win-rate data for all wallets.

**What:**
- New script: `scripts/refresh_wallet_pnl.js`
- Calls Jupiter PnL API (`datapi.jup.ag/v1/pnl`) for each wallet
- Rate-limited: 1 request/second with 429 backoff (same pattern Charon uses
  in `src/enrichment/jupiter.js` via `setJupiterAssetBackoff`)
- Targets stale wallets first (oldest `pnl_snapshot_at`)
- Updates `pnl_usd`, `win_rate`, `pnl_snapshot_at` in harvester DB
- ~908 wallets at 1/sec = ~15 minutes per full pass
- Standalone script, no Charon runtime dependency

**Depends on:** Nothing. Can run in parallel with M0.

#### M1b — Fix scoring formula

**Status:** Implemented with owner-calibrated tiers preserved. Since the owner
confirmed the priority CSV matched wallets they want to follow, A/B/C/watch
labels remain available for import previews.

**Goal:** Make `export_wallet_priority.js` produce reliable scores.

**Changes:**
- Drop `win_rate` and `pnl_usd` from scoring unless `pnl_snapshot_at` is
  within 3 days
- Replace raw `target_sightings * 8` with normalized weight — lean on
  `targetShare` and `target_tokens` instead
- Add confidence flag: `sightingsPerDay` only counted when `observedDays >= 3`
- Remove hardcoded tier thresholds — output sorted by score only, no A/B/C
  labels until calibrated from M0 data
- Make harvester DB path configurable via env var `HARVESTER_DB_PATH` instead
  of hardcoded absolute path

**Depends on:** M1a (needs fresh PnL to score against).

**Harvester data-quality note (2026-05-12):** Patched the MoonBags
`tools/wallet-harvester/src/extractors/gmgn.ts` extractor so missing GMGN
holder amount fields remain `NULL` instead of being stored as `0`. Future
harvests should no longer create fake zero-dollar holder sightings, but already
stored rows needed a repair/backfill or a clean re-harvest. The first repair
was run on 2026-05-12 after backing up the DB; it converted 1,000 matching
historical GMGN holder rows to `NULL` and a follow-up dry-run reported 0
remaining affected rows.

#### M1c — Calibrate tiers from ground truth

**Goal:** Set tier boundaries that match human judgment.

**Steps:**
- Compare M0 manual ratings against M1b scores
- Find score thresholds where human "good" wallets cluster
- Set A/B/C/watch boundaries accordingly
- One-time tuning pass, not a code milestone

**Depends on:** M0 + M1b.

---

### M2 — LLM wallet reviewer

Uses Xiaomi MiMo `mimo-v2.5-pro` via the OpenAI-compatible API at
`https://token-plan-sgp.xiaomimimo.com/v1`. Under the current Charon safety
contract, M2 scripts must not read `.env` or any env file; live mode uses
runtime-injected `LLM_API_KEY` or `XIAOMIMIMO_API_KEY`, plus optional
`LLM_BASE_URL` and `LLM_MODEL`, from the already-running process environment
only.

#### M2a — Wallet review prompt and evaluator

**Goal:** Build the LLM evaluation module.

**What:**
- New script: `scripts/llm_wallet_reviewer.js`
- Reads from harvester DB (read-only) + Charon `saved_wallets` (read-only)
- Creates Charon `wallet_llm_reviews` on startup and writes only parsed review
  rows in live mode
- Supports `--dry-run-json` for prompt/request inspection without requiring a
  key or making an HTTP call
- Batches 10-15 wallets per LLM call (fits context window)
- For each wallet sends:
  - Address, tags, sources
  - Sighting history (tokens traded, mcap range, timestamps)
  - PnL, win rate, avg buy size
  - Target token count, target share percentage
  - Last seen timestamp
- LLM evaluates:
  - Is this wallet a bot, sniper, copy-trader, or genuine smart trader?
  - Does the trading pattern match under-200K micro-cap tokens?
  - Is the PnL credible or likely wash-traded/inflated?
  - Confidence score (0-100)
  - Recommended action: `promote` / `keep` / `demote` / `remove`
  - One-line reasoning
- Stores results in new table `wallet_llm_reviews` in Charon DB:

```sql
CREATE TABLE IF NOT EXISTS wallet_llm_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  reviewed_at_ms INTEGER NOT NULL,
  llm_verdict TEXT NOT NULL,
  llm_confidence INTEGER NOT NULL,
  llm_reasoning TEXT NOT NULL,
  recommended_action TEXT NOT NULL DEFAULT 'keep',
  llm_model TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wlr_address ON wallet_llm_reviews(wallet_address);
CREATE INDEX IF NOT EXISTS idx_wlr_reviewed ON wallet_llm_reviews(reviewed_at_ms);
```

**Depends on:** M1a (needs fresh PnL for meaningful LLM input).

**M2a implementation note (2026-05-12):** Implemented dry-run-first in
`scripts/llm_wallet_reviewer.js`. The script does not load `.env`; live mode
fails closed unless `LLM_API_KEY` or `XIAOMIMIMO_API_KEY` is already injected
at runtime. No live LLM review has been run as part of this implementation
note.

**M2 review-artifact gate (2026-05-12):** Live reviewer runs store parsed rows
in `wallet_llm_reviews` and write JSON/CSV artifacts under
`reports/wallet-llm-reviews` by default. Artifacts omit API keys, auth headers,
request headers, raw environment, and raw LLM response bodies. LLM results are
review-only signals; they do not automatically import, prune, trade, or change
wallet lists without owner approval.

#### M2b — Scheduled 15-minute review loop

**Goal:** Continuous wallet quality monitoring.

**What:**
- Runs as standalone Node process (not inside Charon runtime)
- Every 15 minutes:
  1. Pick N wallets most due for review:
     - Never reviewed
     - Oldest `reviewed_at_ms`
     - Recently promoted/demoted (re-check)
  2. Batch into groups of 10-15
  3. Call Xiaomi MiMo `mimo-v2.5-pro` for each batch
  4. Store results in `wallet_llm_reviews`
  5. Log summary to console
- Rate budget: ~4-6 LLM calls per 15-min cycle = 60-90 wallets per cycle
- Full coverage of 908 wallets in ~2.5 hours, then continuous re-checks
- Does NOT auto-import or auto-remove from `saved_wallets`
- Review only — owner decides what to act on

**Depends on:** M2a.

**M2b implementation note (2026-05-12):** Added standalone loop
scaffolding to `scripts/llm_wallet_reviewer.js` with `--loop`,
`--interval-minutes=N`, optional `--cycles=N`, and `--wallets-per-cycle=N`.
Loop cycles reuse the same due-wallet selection, batching, LLM call, storage,
and artifact path as one-shot review mode. `--dry-run-json --loop` emits one
planned cycle as valid JSON only and never sleeps or writes artifacts. No live
loop or live LLM/API call was run in this slice.

#### M2c — LLM-informed re-ranking

**Goal:** Merge LLM judgment into the priority export.

**Changes to `export_wallet_priority.js`:**
- New conservative scoring component when a review exists and is fresh
  (<= 7 days): promote `+10 * confidence`, keep `+3 * confidence`,
  watch `+0`, demote `-12 * confidence`, remove `-25 * confidence`
  with stored confidence normalized from 0-100 to 0-1
- LLM `remove` action applies a heavy score penalty
- LLM `promote` action applies a score bonus
- Flag wallets where LLM and formula-score disagree significantly
  (anomaly detection)
- New CSV/JSON columns: `llm_verdict`, `llm_confidence`,
  `llm_recommended_action`, `llm_reasoning`, `llm_reviewed_at_iso`,
  `llm_review_fresh`, `llm_score_adjustment`,
  `llm_formula_disagreement`

**Depends on:** M2b (needs review data to exist).

#### M2d — KOL dump-risk signal in candidate pipeline

**Status:** Implemented as code-only/static-verified. No runtime/provider calls
were run during implementation.

**Goal:** When Charon evaluates a candidate token, check whether any KOL/renowned
wallet holding it is already in profit — and pass that as a soft signal to the
LLM candidate selector.

**What:**
- Extend `fetchSavedWalletExposure` (or add a new function called after it)
  in `src/enrichment/wallets.js`
- For each matched saved wallet that has `kol` or `renowned` tags:
  - Call `fetchJupiterWalletPnl(walletAddress)` (already exists in
    `src/enrichment/jupiter.js:209`)
  - Look up the candidate token's mint in the PnL response
  - Record: wallet address, label, tag, PnL on this token, profitable (bool)
- Add `kolDumpRisk` field to the candidate object in `buildCandidate`
  (`src/pipeline/candidateBuilder.js`):
  ```js
  kolDumpRisk: {
    kolHolders: [
      { address, label, tag, pnlOnToken, profitable: true/false }
    ],
    anyProfitable: true/false,
    maxPnlPercent: number | null,
  }
  ```
- Pass `kolDumpRisk` to the LLM in `compactCandidateForLlm`
  (`src/pipeline/llm.js`) so the candidate selector can weigh it
- Update LLM system prompt to include guidance:
  "If a KOL/renowned wallet is already profitable on this token, treat it as
  elevated dump risk. If they are underwater, they are more likely to hold."
- Log the signal in `decision_logs` for post-analysis
- No hard filter — the LLM decides how much weight to give it
- Jupiter API cost is negligible: typically 0-2 extra calls per candidate
  (only for KOL wallets that happen to hold the candidate token)

**Depends on:** M3a (needs KOL wallets imported into `saved_wallets` with tags).
Can also work standalone if wallets are manually added with labels that indicate
KOL status.

---

### M3 — Charon integration

#### M3a — Import script with tier filter

**Status:** Implemented and used once with owner approval. Dry-run remains the
default; `--commit` is required for writes.

**Goal:** Wire ranked wallets into Charon's `saved_wallets`.

**What:**
- New script: `scripts/import_priority_wallets.js`
- Reads priority CSV/JSON output from M1/M2
- Filters by tier or minimum score threshold (configurable)
- `INSERT OR REPLACE` into Charon `saved_wallets`
- Preserves manually-added wallets already in the table
- Dry-run by default — shows what would change, requires `--commit` to write
- Log example: "Importing 70 wallets (25 A, 45 B), skipping 180 (141 C, 39 watch)"

**Depends on:** M1c + M2c (needs calibrated tiers and LLM scores).

#### M3b — Stale wallet pruning

**Status:** Implemented as a review-gated stale flag/skip scaffold. No live
review cycles have populated stale rows yet, and no auto-deletion path exists.

**Goal:** Remove wallets that consistently fail LLM review.

**Rules:**
- Wallets marked `remove` by LLM across 3+ consecutive reviews get flagged
  as `stale` tier
- Export script includes them with `stale` marker
- Import script skips `stale` wallets
- No auto-deletion — owner reviews flagged wallets before removal

**Depends on:** M3a + multiple M2b review cycles.

---

### M4 — Continuous pipeline (future)

**Goal:** Automate the full loop hands-off.

**What:**
- Harvester runs on schedule (every 2-4 hours)
- PnL enrichment runs after each harvest
- LLM reviewer runs every 15 minutes
- Export + import runs after LLM review completes
- Telegram notification when:
  - New wallet promoted to top tier
  - Existing wallet flagged for removal
  - Anomaly detected (LLM vs formula disagreement)
- Optional: dashboard view via Charon Telegram menu

**Depends on:** M0-M3 running manually until the pipeline is trusted.

---

## Dependency chain

```
M0 (manual review)
 |
 +-- M1a (fresh PnL data)
 |    +-- M1b (fix scoring formula)
 |         +-- M1c (calibrate tiers from M0 ground truth)
 |
 +-- M2a (LLM reviewer prompt) [needs M1a]
      +-- M2b (15-min review loop)
           +-- M2c (LLM-informed re-ranking)
           |    |
           |    +-- M3a (import to Charon)
           |         +-- M3b (stale pruning)
           |              |
           |              +-- M4 (full automation)
           |
           +-- M2d (KOL dump-risk signal) [needs M3a for tags]
```

## Files involved

| File | Status | Milestone |
|------|--------|-----------|
| `scripts/export_wallet_priority.js` | Exists, needs fixes | M1b |
| `scripts/import_wallets.js` | Exists, reads different CSV format | Replace in M3a |
| `scripts/refresh_wallet_pnl.js` | New | M1a |
| `scripts/llm_wallet_reviewer.js` | New | M2a/M2b |
| `scripts/import_priority_wallets.js` | New | M3a |
| `src/enrichment/wallets.js` | Exists, extend for KOL PnL check | M2d |
| `src/pipeline/candidateBuilder.js` | Exists, add `kolDumpRisk` field | M2d |
| `src/pipeline/llm.js` | Exists, pass `kolDumpRisk` to LLM | M2d |
| `reports/smart-wallet-priority-*.csv` | Exists | M0 input |

## External dependencies

| Dependency | Used in | Rate limit concern |
|------------|---------|-------------------|
| Jupiter PnL API (`datapi.jup.ag/v1/pnl`) | M1a | 1 req/sec with 429 backoff |
| Xiaomi MiMo `mimo-v2.5-pro` (`token-plan-sgp.xiaomimimo.com/v1`) | M2a/M2b | ~6 calls per 15-min cycle |
| GMGN API | Harvester (existing) | Existing pacing in harvester |
| Harvester DB (moonbags) | M1a, M1b, M2a | Read-only, no mutations |
| Charon DB | M2a, M3a | Write to wallet_llm_reviews + saved_wallets |
