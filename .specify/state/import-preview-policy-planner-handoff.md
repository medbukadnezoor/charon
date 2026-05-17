# Import Preview Policy Planner Handoff

Created: 2026-05-12 21:45 +0700
Owner request: help decide import-preview logic, and ask what else should be checked for a second opinion before changing behavior.

## Objective

Plan the policy for how Charon wallet import previews should treat LLM review results, enriched GMGN/OKX wallet-profile analytics, owner labels, KOL flags, and stale/remove signals.

This is a planner-only handoff. Produce a decision memo and a coding ticket if a code change is recommended. Do not implement yet.

## Safety boundaries

Follow:
- `./AGENTS.md`
- `./WALLET_PIPELINE_PLAN.md`

Do not:
- read or print secrets, `.env`, API keys, auth headers, signatures, or raw environments
- start Charon, PM2, Telegram, trading, signing, or swap flows
- auto-delete wallets
- change import behavior without owner approval
- make broad provider calls

Allowed:
- read current code, reports, SQLite public wallet rows, and review artifacts
- reason from latest priority export and LLM artifacts
- propose dry-run-first import/export changes

## Current state

Latest priority export:
- `reports/smart-wallet-priority-2026-05-12T14-32-14-362Z.json`
- `reports/smart-wallet-priority-2026-05-12T14-32-14-362Z.csv`

Latest targeted LLM review artifact:
- `reports/wallet-llm-reviews/wallet-review-1778596313715.json`
- `reports/wallet-llm-reviews/wallet-review-1778596313715.csv`

Latest importer dry-run:
- Selected `69` A/B wallets
- Skipped `1` stale row
- Would write `0`, because selected wallets already exist

Latest export summary:
- Tier counts: `A=25`, `B=44`, `C=141`, `stale=1`, `watch=39`
- Latest LLM action counts in top 250:
  - `remove=2`
  - `demote=2`
  - `keep=8`
  - `promote=2`
  - `watch=4`
  - `blank=232`

Current stale rule:
- Export marks `tier=stale` only after the latest 3 consecutive LLM reviews recommend `remove`.
- Importer skips stale rows by default.
- Importer does **not** currently block a wallet just because the latest LLM review says `remove`.

## Why this policy matters

After GMGN+OKX profile enrichment, the LLM review quality improved:
- 10 owner-flagged wallets were enriched with GMGN and OKX wallet-profile rows.
- Retest returned zero `insufficient_data` verdicts.
- KOL/noisy wallets are now identified more directly.

But import-preview policy now has a gap:
- A wallet can remain formula-tier `A` or `B` while latest LLM action says `remove`.
- The current importer only skips after 3 consecutive removes.
- This is conservative against false positives, but it lets obviously bad latest-reviewed wallets stay in import previews.

## Concrete current examples

### `69z4qTgQ5DBRTJvnQzx2h8jZhNsv5UgADotEwwKUm2JS`

Current latest export state:
- Rank `2`
- Formula tier `A`
- Final tier `A`
- Score `184.3`
- Owner label: `kol_only`
- `kol_like=true`
- Latest LLM verdict: `inflated_or_wash`
- Latest LLM action: `remove`
- Not stale yet, because stale requires 3 consecutive removes
- LLM reason: KOL-like wallet with negative PnL and low win rate; manual label confirms noisy KOL.

Problem:
- Import preview still considers it an A-tier candidate unless the stale rule eventually trips.

### `719sfKUjiMThumTt2u39VMGn612BZyCcwbM5Pe8SqFYz`

Current latest export state:
- Rank `127`
- Formula tier `B`
- Final tier `stale`
- Score `94.7`
- Owner label: `kol_noisy_not_profitable`
- `kol_like=true`
- Latest LLM verdict: `inflated_or_wash`
- Latest LLM action: `remove`
- Stale candidate: true

This one is skipped already.

## Planner question

What should the import-preview policy be?

Compare these options:

### Option A — Keep current 3-consecutive-remove stale rule

Pros:
- Avoids overreacting to one bad LLM review.
- Good for early-stage noisy LLM signals.

Cons:
- Known bad KOL/noisy wallets can remain importable for too long.
- Owner labels and enriched profiles are underused.

### Option B — Latest `remove` blocks import preview immediately

Policy:
- If latest fresh LLM action is `remove`, importer excludes the wallet by default.
- Export keeps the row visible with a field like `import_blocked=true`.
- Owner can override with `--include-blocked` or `--include-stale`.

Pros:
- Prevents obvious bad wallets like `69z...` from staying in A/B import previews.
- Easy to understand.

Cons:
- One bad LLM review can suppress a good wallet.

### Option C — Latest `remove` blocks only when corroborated

Possible corroboration rules:
- `latest remove` AND `kol_like=true`
- `latest remove` AND owner label contains KOL/noisy/not_profitable
- `latest remove` AND GMGN/OKX win rate below threshold
- `latest remove` AND negative realized PnL
- `latest remove` AND formula-vs-LLM disagreement is true

Pros:
- Stronger against false positives.
- Uses enriched profile data and owner labels.

Cons:
- More complicated.
- Needs clearly auditable fields in CSV.

### Option D — Two-lane preview

Policy:
- Main import preview excludes latest `remove` and stale.
- Owner-review CSV still includes all rows.
- Add separate columns:
  - `import_candidate`
  - `import_blocked`
  - `import_block_reason`
  - `review_lane` such as `ready`, `watch`, `blocked`, `owner_review`

Pros:
- Clean operational list without hiding evidence.
- Best for manual review workflow.

Cons:
- Requires changing importer/export semantics and documentation.

## What else should be checked for second opinion?

Planner should recommend second-opinion checks before changing policy. Consider:

1. **Manual sample check**
   - Check all current latest `remove` and `demote` rows on GMGN.
   - Include at least 10 `keep/promote` rows as controls.
   - Confirm whether LLM action aligns with owner judgment.

2. **Profile data sanity**
   - For enriched wallets, compare GMGN and OKX win rate / PnL direction.
   - Flag contradictions: GMGN positive but OKX negative, or vice versa.
   - Confirm units: GMGN winrate appears 0-1, OKX winRate appears percentage.

3. **KOL-specific behavior**
   - For KOL-like wallets, decide whether they should be:
     - excluded from saved wallets entirely
     - allowed as watch-only
     - used only as dump-risk context, not smart-wallet follow list
   - Confirm `6EDa...` policy: profitable KOL should be watched, but Charon should avoid entering when that KOL is already in profit on the candidate token.

4. **Owner labels precedence**
   - Decide how `owner_labels.manual_label` should override or constrain LLM:
     - `good_profitable_smart_wallet` should likely prevent accidental remove.
     - `kol_only` should likely block import unless owner explicitly overrides.
     - `data_sufficient` should prevent `insufficient_data`.

5. **Freshness thresholds**
   - Latest LLM review fresh threshold is currently 7 days.
   - GMGN profile standard threshold is currently 3 days in prompt context.
   - Decide whether import-blocking should require fresh profile + fresh LLM review.

6. **Impact on existing saved wallets**
   - 70 A/B wallets are already imported.
   - Importer currently does not delete or remove saved wallets.
   - Decide whether blocked rows should merely stop future import, or also produce a separate "review existing saved wallet" report.

7. **Scoring interaction**
   - Current ticket explicitly avoided scoring formula changes.
   - Decide whether import preview should use a separate gating layer instead of modifying `score`.
   - Recommended default: add gating fields without changing formula score.

## Suggested recommendation to evaluate

Initial pragmatic policy:

- Keep formula tier and score unchanged for transparency.
- Add export fields:
  - `import_candidate`
  - `import_blocked`
  - `import_block_reason`
  - `review_lane`
- Default import candidates:
  - tier `A` or `B`
  - not `stale`
  - not `import_blocked`
- Block by default when:
  - latest fresh LLM action is `remove` AND either:
    - `kol_like=true`, or
    - owner manual label is in `kol_only`, `kol_noisy_not_profitable`, or similar, or
    - enriched profile shows negative PnL / weak win rate
- Do not block `demote` automatically; put it in owner-review lane.
- Do not auto-delete existing saved wallets. Produce a review report instead.

Ask the planner to accept, revise, or reject this recommendation.

## Required planner output

Return:
- Recommended policy with rationale
- Exact export/import fields to add
- Exact blocking rules and override flags
- How owner labels should affect policy
- How KOL wallets should be treated
- Second-opinion checklist before implementation
- Coder ticket if policy change is approved
- Verifier checklist

## First files to read

1. `./scripts/export_wallet_priority.js`
2. `./scripts/import_priority_wallets.js`
3. `./scripts/llm_wallet_reviewer.js`
4. `./WALLET_PIPELINE_PLAN.md`
5. `./reports/smart-wallet-priority-2026-05-12T14-32-14-362Z.csv`
6. `./reports/wallet-llm-reviews/wallet-review-1778596313715.csv`

## Do not implement yet

This is a planning question. The owner wants help deciding logic and what second-opinion checks to run before implementation.
