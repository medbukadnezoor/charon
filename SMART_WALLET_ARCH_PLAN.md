# WP-M5: Broad Wallet Universe & Compact Evidence Plan

Created: 2026-05-13
Status: **Owner approved — 2026-05-13**
Parent: `SMART_WALLET_LOGIC_PLANNING_HANDOFF.md`

---

## 1. Problem recap

| Dimension | Current state | Target |
|-----------|--------------|--------|
| Runtime wallet set | 70 A/B wallets in `saved_wallets` | 800+ wallets synced from harvester |
| Overlap recall | Low — early Pump tokens rarely overlap 70 wallets | High — every harvester wallet is checked |
| Metadata lookup | Cross-DB read to `harvester.db` per candidate call | In-memory cache, refreshed on timer |
| Jupiter PnL in hot path | KOL dump-risk calls only (0-2/candidate) | Same — no new hot-path Jupiter |
| Evidence logging | Raw `savedWalletExposure` + `kolDumpRisk` blobs | Compact structured `walletEvidence` |
| Jupiter refresh rate | 1 req/sec | 2-3 req/sec with multi-address batching |

The `min_saved_wallet_holders` strategy setting stays as-is — it's already a toggle. The fix is making the pool it checks against 10x larger so early tokens actually hit matches.

---

## 2. Data model changes

### 2a. Extend `saved_wallets` schema

Current schema is minimal:
```sql
CREATE TABLE IF NOT EXISTS saved_wallets (
  label TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
);
```

Add cached intelligence columns so `fetchSavedWalletExposure` never needs to cross-read `harvester.db` at candidate time:

```sql
ALTER TABLE saved_wallets ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE saved_wallets ADD COLUMN tier TEXT DEFAULT 'universe';
ALTER TABLE saved_wallets ADD COLUMN quality_score REAL;
ALTER TABLE saved_wallets ADD COLUMN source TEXT DEFAULT 'manual';  -- 'harvester' | 'manual'
-- cached GMGN profile
ALTER TABLE saved_wallets ADD COLUMN gmgn_winrate REAL;
ALTER TABLE saved_wallets ADD COLUMN gmgn_realized_pnl REAL;
ALTER TABLE saved_wallets ADD COLUMN gmgn_tags_json TEXT;
ALTER TABLE saved_wallets ADD COLUMN gmgn_twitter TEXT;
ALTER TABLE saved_wallets ADD COLUMN gmgn_snapshot_at INTEGER;
-- cached OKX profile
ALTER TABLE saved_wallets ADD COLUMN okx_winrate REAL;
ALTER TABLE saved_wallets ADD COLUMN okx_realized_pnl REAL;
ALTER TABLE saved_wallets ADD COLUMN okx_preferred_mcap TEXT;
ALTER TABLE saved_wallets ADD COLUMN okx_snapshot_at INTEGER;
-- cached Jupiter PnL
ALTER TABLE saved_wallets ADD COLUMN jup_total_pnl REAL;
ALTER TABLE saved_wallets ADD COLUMN jup_winrate REAL;
ALTER TABLE saved_wallets ADD COLUMN jup_total_trades INTEGER;
ALTER TABLE saved_wallets ADD COLUMN jup_snapshot_at INTEGER;
-- owner labels (copied from harvester)
ALTER TABLE saved_wallets ADD COLUMN owner_label TEXT;
ALTER TABLE saved_wallets ADD COLUMN owner_notes TEXT;
-- housekeeping
ALTER TABLE saved_wallets ADD COLUMN last_synced_at INTEGER;
ALTER TABLE saved_wallets ADD COLUMN harvester_last_seen INTEGER;
```

The sync script populates these columns. Existing 70 wallets get their `source` set to `'manual'`; new harvester-synced wallets get `'harvester'`. The migration is additive — all new columns have defaults, so old code that reads `label`, `address`, `created_at_ms` keeps working.

### 2b. Freshness contract

| Provider | Fresh | Stale | Missing |
|----------|-------|-------|---------|
| GMGN profile | < 3 days | 3-14 days | NULL |
| OKX profile | < 3 days | 3-14 days | NULL |
| Jupiter PnL | < 1 day | 1-7 days | NULL |

Freshness flags are computed at read time from snapshot timestamps, not stored.

---

## 3. Hot-path candidate logic

### 3a. In-memory address cache replaces per-call DB reads

Current flow (per candidate):
```
fetchSavedWalletExposure(mint, holders)
  → SELECT * FROM saved_wallets (70 rows, every call)
  → open harvester.db, query owner_labels + wallet_profiles for those 70 addresses
  → close harvester.db
  → intersect with holder addresses
```

New flow:
```
startup / every 5 minutes:
  → SELECT * FROM saved_wallets (800+ rows)
  → build addressSet (Set of addresses) and walletMap (Map<address, row>)
  → cache in module-level variables

fetchSavedWalletExposure(mint, holders):
  → intersect holder addresses against cached addressSet (O(1) per holder)
  → look up matched rows from cached walletMap
  → return enriched result with compact walletEvidence
  → zero DB queries, zero cross-DB reads
```

~800 addresses in a `Set` is ~50KB. The cache refresh is a single `SELECT *` every 5 minutes. The intersection is a tight loop over holders (typically 20-200 addresses).

### 3b. No new Jupiter PnL calls in the hot path

`fetchKolDumpRisk` stays bounded at 0-2 Jupiter calls per candidate (only matched KOL wallets). The broader overlap check uses cached profile data only.

### 3c. Compact `walletEvidence` on candidate

Replace the current `savedWalletExposure` output with richer structured evidence:

```js
savedWalletExposure: {
  holderCount: 5,              // how many saved_wallets matched
  checked: 842,                // total saved_wallets size
  wallets: ["whale_1", ...],   // labels (existing field, kept for compat)
  matchedWallets: [ ... ],     // existing detailed array (kept for compat)
  evidence: {
    wallets: [
      {
        addr: "7xKX...9mPQ",
        label: "degen_whale",
        tags: ["smart_money", "kol"],
        tier: "A",
        gmgn: { wr: 0.68, pnl: 12400, fresh: true },
        okx:  { wr: 0.72, mcap: "10k-100k", fresh: true },
        jup:  { pnl: 8200, wr: 0.65, fresh: false },
        owner: "whale-tracker",
      },
    ],
    summary: {
      avgGmgnWinrate: 0.65,
      kolCount: 1,
      smartMoneyCount: 3,
      topTier: "A",
      strongCount: 2,   // tier A or B
    },
  },
}
```

The existing `holderCount`, `checked`, `wallets`, `matchedWallets` fields stay so nothing downstream breaks. The new `evidence` sub-object adds the compact intelligence.

### 3d. LLM payload changes

In `compactCandidateForLlm`, pass `savedWalletExposure.evidence.summary` and the top 5 matched wallets (by tier/score) instead of the full `matchedWallets` array. Keeps LLM context small.

### 3e. Decision log evidence

Compact log format per wallet: `shortAddr:tier:primaryTag:freshnessFlag`

```json
{
  "walletEvidence": {
    "matched": 5,
    "strongCount": 3,
    "kolCount": 1,
    "wallets": [
      "7xKX:A:smart_money:gmgn_fresh",
      "3pQR:B:kol:jup_stale"
    ]
  }
}
```

---

## 4. Sync process: harvester → saved_wallets

### 4a. Updated sync script

Refactor `scripts/import_priority_wallets.js` (or new `scripts/sync_saved_wallets.js`) to:

1. Open `harvester.db` read-only
2. Join `wallets` + `wallet_profiles` + `owner_labels` on address
3. Compute `quality_score` using existing formula from `export_wallet_priority.js`
4. Assign `tier` from score thresholds
5. UPSERT into `saved_wallets` with all profile columns populated
6. Preserve existing manually-added wallets (`source='manual'`) — don't overwrite them
7. Report: `synced 842 wallets (772 new harvester, 70 existing manual), tier distribution: 25A 45B 120C 652 universe`

**Flags:**
- `--dry-run` (default): show what would change
- `--commit`: write
- `--stats-only`: tier distribution and staleness summary

**Frequency:** After each harvester cycle, or manually. Not in Charon hot path.

### 4b. Label generation

Current `saved_wallets` uses `label` as PRIMARY KEY. For harvester wallets, generate labels from:
1. Owner label if set → use as-is
2. GMGN twitter username → `@username`
3. Wallet tags → first meaningful tag + short address: `smart_money_7xKX`
4. Fallback → short address: `7xKX...9mPQ`

Collision handling: append suffix if label already exists (`smart_money_7xKX_2`).

---

## 5. Background Jupiter PnL refresh

### 5a. Faster rate + multi-address batching

Jupiter `datapi.jup.ag/v1/pnl` accepts comma-separated addresses in the `addresses` param. Batch 5 addresses per request at 2 req/sec:

- Effective throughput: **10 wallets/sec** (vs. current 1/sec)
- Full 800-wallet refresh: **~80 seconds** (vs. current ~13 minutes)
- Keep 429 exponential backoff (existing pattern)
- Start at 2 req/sec; if 429s are rare, can push to 3 req/sec

Update `scripts/refresh_wallet_pnl.js` to:
- Accept `--batch-size=5` (addresses per request)
- Accept `--rate=2` (requests per second)
- Write refreshed PnL to both harvester DB (existing) and Charon `saved_wallets.jup_*` columns (new)

### 5b. Priority queue

| Priority | Description | Refresh target |
|----------|-------------|---------------|
| P0 | Owner-labeled wallets | Every 12h |
| P1 | Recently overlapped a candidate (last 24h) | Every 12h |
| P2 | Tier A/B wallets | Every 24h |
| P3 | KOL/renowned tagged | Every 24h |
| P4 | High GMGN/OKX winrate (> 0.5) | Every 48h |
| P5 | All others | Every 7 days or best-effort |

### 5c. Stale Jupiter handling

When Jupiter PnL is stale or missing for a matched wallet:
- Wallet still appears in evidence with `jup: null` or `jup: { ..., fresh: false }`
- GMGN/OKX profile data is primary quality source
- LLM is told stale Jupiter = unknown token-specific risk, not low quality

---

## 6. Verification strategy

### Gate 1: Static checks
- `node --check` on all modified files
- Fixture tests for: cache loading, Set intersection, evidence formatting, label generation

### Gate 2: Dry-run sync
- `sync_saved_wallets.js --dry-run` against real harvester DB
- Verify tier distribution, label uniqueness, column population
- Compare overlap count for a known candidate holder list: old 70-wallet vs. new 800+ wallet

### Gate 3: Owner review
- Stats output for review
- Sample `walletEvidence` JSON for 3-5 real candidates (offline replay)
- Side-by-side: old vs. new `savedWalletExposure` for same candidates

### Gate 4: Runtime (requires separate owner ticket)
- Run sync with `--commit`
- Monitor Charon dry-run cycle with larger wallet set
- Verify filter pass rate improves without quality drop

---

## 7. Milestone ladder

### M5-1: Extend `saved_wallets` + sync script
**Type:** Coder
**Scope:**
- Add ALTER TABLE migrations to `src/db/connection.js` (additive, backward-compatible)
- New `scripts/sync_saved_wallets.js` (dry-run-first, `--commit` required)
- Read `harvester.db` wallets + wallet_profiles + owner_labels (read-only)
- Reuse scoring formula from `export_wallet_priority.js`
- Static `node --check` only
**Gate:** Gate 1 + Gate 2

### M5-2: In-memory cache + compact evidence
**Type:** Coder
**Scope:**
- Module-level address `Set` + wallet `Map` cache in `src/enrichment/wallets.js`
- Timer-based refresh (every 5 min)
- Remove per-call `harvester.db` cross-reads from `fetchSavedWalletExposure`
- Add `evidence` sub-object to return value
- Keep existing fields for backward compat
**Gate:** Gate 1

### M5-3: LLM + decision log integration
**Type:** Coder
**Scope:**
- Update `compactCandidateForLlm` to pass compact evidence summary
- Update decision logging to include compact wallet evidence
- No changes to `filterCandidate` — `min_saved_wallet_holders` reads `holderCount` which now counts against 800+ wallets
**Gate:** Gate 1 + Gate 3

### M5-4: Jupiter PnL multi-address batching
**Type:** Coder
**Scope:**
- Update `scripts/refresh_wallet_pnl.js` with `--batch-size` and `--rate` params
- Add priority queue selection logic
- Write refreshed PnL to Charon `saved_wallets.jup_*` columns
**Gate:** Gate 1 + Gate 2 (dry-run with `--limit 10`)

### M5-5: Runtime integration (owner-gated)
**Type:** Coder
**Scope:**
- Run sync `--commit` to populate 800+ wallets
- Enable in live dry-run Charon
- Monitor overlap rates for one cycle
**Gate:** Gate 4

---

## 8. What this plan does NOT do

- Does not change `min_saved_wallet_holders` logic or add new filters. The strategy toggle works as-is.
- Does not add provider calls to the hot path. Overlap is cache-only.
- Does not auto-delete wallets without owner approval.
- Does not run Charon, PM2, Telegram, trading, signing, or swaps.
- Does not touch `.env`, secrets, or credentials.
- Does not propose evidence compaction (deferred to M5-COMPACT).

---

## 9. Suggested first Coder ticket

```
WP-M5-1: Extend saved_wallets schema + sync script

Scope:
- Add cached intelligence columns to saved_wallets (ALTER TABLE, additive)
- New scripts/sync_saved_wallets.js (dry-run-first, --commit required)
- Read harvester.db wallets + wallet_profiles + owner_labels (read-only)
- Compute quality_score reusing export_wallet_priority.js formula
- Assign tier from score, generate labels
- Preserve existing manual wallets (source='manual')
- Static node --check only, no runtime
- Dry-run output for owner review

Safety: read-only harvester access, dry-run-first Charon writes,
no runtime/provider/secret/Telegram/trading access.
```
