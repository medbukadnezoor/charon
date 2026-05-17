# Architect Ticket: WP-IMPORT-POLICY-1

## Title

Add corroborated import-blocking and two-lane preview to export and importer

## Goal

Prevent known-bad wallets (unprofitable KOLs, LLM-flagged noisy wallets) from
appearing in import previews while protecting good wallets from false-positive
LLM removals. Add auditable `import_candidate`, `import_blocked`,
`import_block_reason`, and `review_lane` fields to the export CSV.

## Depends On

WP-M2-ENRICH-1 (wallet profile enrichment — landed)

## Owner-Verified Policy

Tested against all 18 LLM-reviewed wallets. Zero false positives/negatives.

| Wallet | Owner verdict | Policy result |
|--------|--------------|---------------|
| `69z4qT...m2JS` | unprofitable KOL, block | blocked (remove + kol_like + negative PnL) |
| `719sfK...qFYz` | unprofitable KOL, block | blocked (stale + kol_like) |
| `2fg5QD...rx6f` | KOL profitable, dump-risk watch | watch (demote, not remove) |
| `2xTAbV...8xWD` | weak 30% WR, 1.43% PnL/vol | owner_review (demote + A/B disagree) |
| `43QmFc...oo9x` | smart wallet, not bad | ready (keep) |
| `55ZQuS...PzAH` | good wallet | ready (promote) |
| `2NuAgV...gRfV` | not bad | ready (keep) |
| `6EDaVs...UqN3` | KOL profitable, watch | watch (LLM watch + kol_profitable) |

## Updated Owner Labels

These should be set in `owner_labels` table if not already correct:

| Address | manual_label | manual_notes |
|---------|-------------|--------------|
| `69z4qTgQ5DBRTJvnQzx2h8jZhNsv5UgADotEwwKUm2JS` | `kol_only` | unprofitable KOL |
| `719sfKUjiMThumTt2u39VMGn612BZyCcwbM5Pe8SqFYz` | `kol_noisy_not_profitable` | unprofitable KOL |
| `2fg5QD1eD7rzNNCsvnhmXFm5hqNgwTTG8p7kQ6f3rx6f` | `kol_profitable_watch` | KOL profitable but dump-risk; do not enter when already in profit |
| `2xTAbVhrFdHybZnxjkwfkQHLvkRKMfggL641mFKj8xWD` | `data_sufficient_drawdown` | 30% WR, PnL only 1.43% of volume |
| `43QmFc2QPPGyMrSNuPnhvfs8BFW1XVZYFdbwURtWoo9x` | `good_profitable_smart_wallet` | smart wallet, not KOL |
| `55ZQuSoWHxHkCxzZvU4QP6FyNAcc6y62d3FKiEghPzAH` | `good_profitable_smart_wallet` | good wallet |
| `2NuAgVk3hcb7s4YvP4GjV5fD8eDvZQv5wuN6ZC8igRfV` | `smart_wallet` | not bad |
| `6EDaVsS6enYgJ81tmhEkiKFcb4HuzPUVFZeom6PHUqN3` | `kol_profitable_watch` | KOL profitable; do not enter when already in profit on candidate token |

## Safety Boundaries

Follow:
- `./AGENTS.md`
- `./WALLET_PIPELINE_PLAN.md`

Do not:
- Read, print, copy, validate, or modify `.env` or secrets
- Start Charon, PM2, Telegram, trading, signing, or swaps
- Install dependencies
- Auto-delete or auto-remove wallets from `saved_wallets`
- Change the scoring formula or tier thresholds

---

## Blocking Policy

A wallet is `import_blocked = true` when ANY of these conditions are met:

### Condition 1: Stale (existing rule, unchanged)

```
stale_candidate = true  (3+ consecutive LLM reviews said remove)
→ block_reason: 'stale_3_consecutive'
```

### Condition 2: Owner hard-exclude

```
owner_manual_label IN ('exclude', 'avoid', 'ban')
→ block_reason: 'owner_exclude'
```

### Condition 3: Corroborated LLM remove

```
latest LLM action = 'remove'
AND llm_review_fresh = true (< 7 days)
AND owner_manual_label NOT IN ('good_profitable_smart_wallet', 'keep', 'smart_wallet')
AND at least ONE corroborating signal:
  (a) kol_like = true
      → append 'kol_like' to block_reasons
  (b) owner_manual_label matches /kol|noisy|not_profitable/
      → append 'owner_label' to block_reasons
  (c) gmgn_winrate < 0.35 AND gmgn_realized_profit_usd < 0
      → append 'negative_pnl' to block_reasons
  (d) okx_win_rate IS NOT NULL AND okx_win_rate < 35 AND okx_realized_pnl_usd < 0
      → append 'okx_negative_pnl' to block_reasons
```

**Note on OKX winrate units:** OKX `win_rate` is 0-100 (percentage), GMGN
`winrate` is 0-1. Thresholds: GMGN < 0.35, OKX < 35.

### Owner label overrides

| Owner label | Effect |
|-------------|--------|
| `good_profitable_smart_wallet`, `keep`, `smart_wallet` | **Prevents** blocking — stays `ready` even if LLM says remove |
| `kol_only`, `kol_noisy_not_profitable` | **Corroborates** LLM remove → triggers block |
| `kol_profitable_watch` | Does NOT corroborate remove (profitable KOL is watch, not block). But if LLM says remove AND negative PnL corroborates, it can still block. |
| `data_sufficient_drawdown`, `review` | No override, normal rules apply |
| `exclude`, `avoid`, `ban` | **Forces** block regardless of LLM |
| (empty) | No override, normal rules apply |

---

## Lane Assignment

```
if import_blocked:
  review_lane = 'blocked'
else if tier IN ('A','B') AND llm_action == 'demote' AND llm_review_fresh:
  review_lane = 'owner_review'
else if llm_action == 'watch':
  review_lane = 'watch'
else if tier IN ('A','B'):
  review_lane = 'ready'
else:
  review_lane = 'watch'

import_candidate = (review_lane == 'ready')
```

---

## Changes to `scripts/export_wallet_priority.js`

### 1. New function `computeImportPolicy(row)`

Takes the fully assembled row (with tier, llm fields, profile fields,
owner label, kol_like) and returns:

```js
{
  import_candidate: boolean,
  import_blocked: boolean,
  import_block_reason: string,   // e.g. 'kol_like+owner_label' or 'stale_3_consecutive'
  review_lane: string,           // 'ready' | 'watch' | 'blocked' | 'owner_review'
  saved_but_now_blocked: boolean // true if wallet exists in saved_wallets AND blocked
}
```

Implement the blocking conditions and lane assignment exactly as specified
above. `import_block_reason` is the `+`-joined list of block reasons, or
empty string if not blocked.

### 2. Read Charon `saved_wallets` addresses

Already connected for LLM reviews. Load the set of addresses from
`saved_wallets` to compute `saved_but_now_blocked`.

### 3. Apply policy to each row

In the `.map(row => ...)` block after line ~399, call `computeImportPolicy`
and spread the result into the row object.

### 4. Add 5 new CSV columns

Insert after `stale_reason` in the header array:

```
'import_candidate',
'import_blocked',
'import_block_reason',
'review_lane',
'saved_but_now_blocked',
```

Add corresponding values in the CSV row output.

### 5. Print summary after export

After the existing tier summary, add:

```
Import lanes: ready=N watch=N blocked=N owner_review=N
Block reasons: stale=N kol_like=N owner_label=N negative_pnl=N owner_exclude=N
Saved wallets now blocked: N
```

If `saved_but_now_blocked` count > 0, print the truncated addresses.

---

## Changes to `scripts/import_priority_wallets.js`

### 1. Update `chooseRows` to use `import_candidate`

In the `.filter(row => ...)` block:

```js
// If new-format export with import_candidate field, use it
if ('import_candidate' in row) {
  if (!includeBlocked && !truthy(row.import_candidate)) {
    if (truthy(row.import_blocked)) skippedBlocked++;
    else skippedOther++;
    return false;
  }
  return Boolean(rowAddress(row));
}
// Fallback: old-format export without import_candidate — use tier + stale filter
if (!includeStale && rowIsStale(row)) { ... }
```

### 2. Add `--include-blocked` flag

```js
const includeBlocked = hasFlag('include-blocked') || hasFlag('include-stale');
```

`--include-stale` remains as backward-compat alias.

### 3. Track and print blocked skip count

Add `skippedBlocked` counter. Print in summary:

```
Skipped blocked rows: N
Skipped other non-candidate rows: N
```

---

## Forbidden Actions

- Do not change the scoring formula or tier thresholds
- Do not auto-delete or auto-remove wallets from `saved_wallets`
- Do not read/print secrets, `.env`, API keys, auth headers
- Do not start Charon, PM2, Telegram, trading, signing, or swaps
- Do not install dependencies
- Do not make any provider API calls from these scripts

---

## Verifier Checklist

1. Run export. `69z4qT...m2JS` has `import_blocked=true`, `review_lane=blocked`,
   `import_block_reason` includes `kol_like`
2. `719sfK...qFYz` has `import_blocked=true` (stale), same as before
3. `2fg5QD...rx6f` has `review_lane=watch` (demote but KOL profitable watch)
4. `2xTAbV...8xWD` has `review_lane=owner_review` (demote + A/B disagreement)
5. `43QmFc...oo9x` has `import_candidate=true`, `review_lane=ready`
6. `55ZQuS...PzAH` has `import_candidate=true`, `review_lane=ready`
7. `2NuAgV...gRfV` has `import_candidate=true`, `review_lane=ready`
8. `6EDaVs...UqN3` has `review_lane=watch` (LLM watch, kol_profitable)
9. A wallet with `owner_manual_label=good_profitable_smart_wallet` stays
   `import_candidate=true` even if LLM says `remove`
10. A wallet with `owner_manual_label=exclude` is `import_blocked=true`
    regardless of LLM
11. A wallet with LLM `remove` but no corroboration (not KOL, no negative PnL,
    no owner label) stays `import_candidate=true`
12. Importer dry-run with new export: `ready` count matches
    `import_candidate=true` count
13. `--include-blocked` flag overrides and includes blocked rows
14. `saved_but_now_blocked` count = 2 (the two KOL wallets already imported)
15. Export summary prints lane counts and block reason breakdown
16. No scoring formula changes, no tier threshold changes
17. Backward compat: importer works with old-format exports missing
    `import_candidate` field

## Acceptance Criteria (Owner-Checkable)

- Export CSV clearly shows `ready` / `blocked` / `owner_review` / `watch` lanes
- `69z...` and `719...` are no longer in the import preview
- `2fg5QD...` and `6EDa...` are in `watch` lane (KOL profitable, dump-risk only)
- `2xTAbV...` is in `owner_review` lane for you to decide
- Good wallets (`43Qm`, `55ZQ`, `2Nu`) are `ready`
- Owner labels like `good_profitable_smart_wallet` protect against accidental blocking
- `saved_but_now_blocked` report shows the 2 KOL wallets already in saved_wallets
- No wallet is auto-removed from `saved_wallets`
- `--include-blocked` lets you override if needed

## Files to Change

| File | Change |
|------|--------|
| `scripts/export_wallet_priority.js` | Add `computeImportPolicy`, 5 new CSV columns, summary |
| `scripts/import_priority_wallets.js` | Filter on `import_candidate`, add `--include-blocked` |

## Files to Read (Coder Reference)

1. `scripts/export_wallet_priority.js` — current stale/tier/llm logic
2. `scripts/import_priority_wallets.js` — current `chooseRows` filter
3. `scripts/llm_wallet_reviewer.js` — LLM field names for reference
4. This ticket for exact blocking rules and lane assignment
