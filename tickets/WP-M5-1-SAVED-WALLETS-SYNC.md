# WP-M5-1: Extend saved_wallets schema + harvester sync script

**Type:** Coder
**Parent plan:** `SMART_WALLET_ARCH_PLAN.md`
**Status:** Open

---

## Goal

Expand Charon's `saved_wallets` from 70 curated wallets to the full 800+ harvester universe so that `min_saved_wallet_holders` overlap checks cover a much larger pool. Add cached intelligence columns so the hot-path wallet lookup never cross-reads `harvester.db`.

## Owner-visible outcome

After this ticket:
1. Running `node scripts/sync_saved_wallets.js --dry-run` prints a report showing all 800+ harvester wallets that would sync into `saved_wallets`, with tier distribution and label preview.
2. Running `node scripts/sync_saved_wallets.js --commit` actually populates `saved_wallets` with 800+ rows, each carrying cached GMGN/OKX/Jupiter profile data and a computed tier/score.
3. Existing 70 manually-imported wallets are preserved with `source='manual'` and not overwritten.
4. `node --check` passes on all modified files.
5. Charon can still start and read `saved_wallets` without errors — the schema migration is additive (all new columns have defaults).

## What to implement

### 1. Schema migration in `src/db/connection.js`

Add an idempotent migration block after the existing `CREATE TABLE IF NOT EXISTS saved_wallets` that runs safe `ALTER TABLE ADD COLUMN` statements. Each must be wrapped in a try/catch so it's safe to run repeatedly (SQLite errors on duplicate column adds).

New columns to add:

```
tags_json        TEXT    DEFAULT '[]'
tier             TEXT    DEFAULT 'universe'
quality_score    REAL
source           TEXT    DEFAULT 'manual'
gmgn_winrate     REAL
gmgn_realized_pnl REAL
gmgn_tags_json   TEXT
gmgn_twitter     TEXT
gmgn_snapshot_at INTEGER
okx_winrate      REAL
okx_realized_pnl REAL
okx_preferred_mcap TEXT
okx_snapshot_at  INTEGER
jup_total_pnl    REAL
jup_winrate      REAL
jup_total_trades INTEGER
jup_snapshot_at  INTEGER
owner_label      TEXT
owner_notes      TEXT
last_synced_at   INTEGER
harvester_last_seen INTEGER
```

Also set `source='manual'` on all existing rows that don't have a source value yet:
```sql
UPDATE saved_wallets SET source = 'manual' WHERE source IS NULL;
```

### 2. New script: `scripts/sync_saved_wallets.js`

Standalone script. Does not load `.env` or start Charon runtime.

**Inputs:**
- `harvester.db` path via `--harvester-db=` or `HARVESTER_DB_PATH` env var (same pattern as existing scripts)
- Charon DB path via `--charon-db=` or `CHARON_DB_PATH` env var (default: `./charon.sqlite`)
- `--dry-run` (default): report only, no writes
- `--commit`: actually write to Charon DB
- `--stats-only`: just print tier distribution and staleness counts
- `--limit=N`: optional cap on how many wallets to sync

**Steps:**

1. Open `harvester.db` read-only.
2. Query all wallets joined with `wallet_profiles` and `owner_labels`:
   ```sql
   SELECT w.*, wp.*, ol.manual_label, ol.manual_notes
   FROM wallets w
   LEFT JOIN wallet_profiles wp ON w.address = wp.address
   LEFT JOIN owner_labels ol ON w.address = ol.address
   ```
3. For each harvester wallet, compute `quality_score` and `tier` using the same formula as `export_wallet_priority.js`:
   - Reuse `scoreWallet()` and `tierFor()` logic — copy or import from `export_wallet_priority.js`
   - The scoring formula is at `export_wallet_priority.js:393-448`, tier thresholds at `:450-455`
4. Generate a `label` for each wallet:
   - If `owner_labels.manual_label` exists → use it
   - Else if `wallet_profiles.gmgn_twitter_username` exists → `@username`
   - Else if wallet has meaningful tags → `{first_tag}_{shortAddr}` (e.g. `smart_money_7xKX`)
   - Else → short address `7xKX...9mPQ`
   - Handle collisions: append `_2`, `_3` etc. if label already used
5. Open Charon DB.
6. For each harvester wallet, UPSERT into `saved_wallets`:
   - Use `INSERT ... ON CONFLICT(address) DO UPDATE` keyed on `address` (the UNIQUE column)
   - Do NOT overwrite rows where `source = 'manual'` — skip those addresses
   - Set `source = 'harvester'` for synced rows
   - Populate all cached profile columns from the joined harvester data
   - Set `last_synced_at = Date.now()`
   - Set `harvester_last_seen = wallets.last_seen`
7. Print summary report:
   ```
   Sync complete:
     Harvester wallets: 842
     New inserts: 772
     Updated: 0
     Skipped (manual): 70
     Tier distribution: 25 A, 45 B, 120 C, 652 universe
     Stale GMGN (>3d): 340
     Stale Jupiter (>1d): 580
     Missing Jupiter: 230
   ```

### 3. Profile column mapping

Map from harvester tables to `saved_wallets` columns:

| saved_wallets column | Source |
|---------------------|--------|
| `tags_json` | Merge `wallets.tags`, `wallets.provider_tags`, `wallet_profiles.gmgn_tags` into one JSON array |
| `gmgn_winrate` | `wallet_profiles.gmgn_winrate` |
| `gmgn_realized_pnl` | `wallet_profiles.gmgn_realized_profit_usd` |
| `gmgn_tags_json` | `wallet_profiles.gmgn_tags` |
| `gmgn_twitter` | `wallet_profiles.gmgn_twitter_username` |
| `gmgn_snapshot_at` | `wallet_profiles.gmgn_snapshot_at` |
| `okx_winrate` | `wallet_profiles.okx_win_rate` |
| `okx_realized_pnl` | `wallet_profiles.okx_realized_pnl_usd` |
| `okx_preferred_mcap` | `wallet_profiles.okx_preferred_mcap` |
| `okx_snapshot_at` | `wallet_profiles.okx_snapshot_at` |
| `jup_total_pnl` | `wallets.pnl_usd` |
| `jup_winrate` | `wallets.win_rate` |
| `jup_total_trades` | NULL (not in harvester; populated later by refresh script) |
| `jup_snapshot_at` | `wallets.pnl_snapshot_at` |
| `owner_label` | `owner_labels.manual_label` |
| `owner_notes` | `owner_labels.manual_notes` |

## What NOT to do

- Do not run Charon, PM2, Telegram, trading, signing, or swaps
- Do not read `.env` or secrets
- Do not install dependencies
- Do not modify `fetchSavedWalletExposure` or any hot-path code (that's M5-2)
- Do not modify `filterCandidate` (the existing `min_saved_wallet_holders` logic is unchanged)
- Do not call Jupiter, GMGN, OKX, or any external provider
- Do not auto-delete or auto-prune wallets

## Verification

1. `node --check src/db/connection.js` passes
2. `node --check scripts/sync_saved_wallets.js` passes
3. `node scripts/sync_saved_wallets.js --dry-run` runs against real `harvester.db` and prints a valid summary report with tier distribution
4. `node scripts/sync_saved_wallets.js --stats-only` prints staleness counts
5. After `--commit`: `sqlite3 charon.sqlite "SELECT source, tier, COUNT(*) FROM saved_wallets GROUP BY source, tier"` shows both `manual` and `harvester` rows with expected tier distribution
6. After `--commit`: `sqlite3 charon.sqlite "SELECT COUNT(*) FROM saved_wallets WHERE source='manual'"` still returns the original 70 wallets
7. Charon can start without errors (if safe to verify — otherwise confirm with `node --check` on `src/db/connection.js` only)

## Files to modify

| File | Change |
|------|--------|
| `src/db/connection.js` | Add ALTER TABLE migration block for new columns |
| `scripts/sync_saved_wallets.js` | **New file** — sync script |

## Files to read (context)

| File | Why |
|------|-----|
| `scripts/export_wallet_priority.js:393-455` | `scoreWallet()` and `tierFor()` to reuse |
| `scripts/export_wallet_priority.js:195-217` | `loadWalletProfiles()`, `loadOwnerLabels()`, `loadSavedWalletAddresses()` patterns |
| `scripts/import_priority_wallets.js` | Existing import pattern, `--dry-run`/`--commit` flag handling |
| `src/enrichment/wallets.js:13-19` | Current `savedWallets()` function that reads the table |
| `SMART_WALLET_ARCH_PLAN.md` | Full architecture context |
