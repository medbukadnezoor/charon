# WP-M5-2: In-memory address cache + compact evidence

**Type:** Coder
**Parent plan:** `SMART_WALLET_ARCH_PLAN.md`
**Status:** Open

---

## Goal

Replace the per-call `harvester.db` cross-read in `fetchSavedWalletExposure` with a
module-level in-memory cache loaded from `saved_wallets` (now 800+ rows after M5-1).
Add a compact `evidence` sub-object to the return value. Keep all existing fields
for backward compatibility.

## Owner-visible outcome

After this ticket:
1. `fetchSavedWalletExposure` makes zero DB queries and zero cross-DB reads per call.
2. The cache is a `Set<address>` + `Map<address, row>` loaded from `saved_wallets` at
   startup and refreshed every 5 minutes.
3. The return value gains an `evidence` sub-object with per-wallet detail and a summary.
4. All existing fields (`holderCount`, `checked`, `wallets`, `matchedWallets`) are
   preserved unchanged so nothing downstream breaks.
5. `node --check` passes on all modified files.

## What to implement

### File: `src/enrichment/wallets.js`

#### 1. Module-level cache

Add at module level (after imports):

```js
// In-memory cache — populated at startup and refreshed every 5 min
let _walletCache = null;          // { addressSet: Set, walletMap: Map, loadedAt: number }
const CACHE_TTL_MS = 5 * 60 * 1000;

function loadWalletCache() {
  const rows = db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
  const addressSet = new Set(rows.map(r => r.address));
  const walletMap = new Map(rows.map(r => [r.address, r]));
  _walletCache = { addressSet, walletMap, loadedAt: Date.now() };
  return _walletCache;
}

function getWalletCache() {
  if (!_walletCache || Date.now() - _walletCache.loadedAt > CACHE_TTL_MS) {
    loadWalletCache();
  }
  return _walletCache;
}
```

Export `loadWalletCache` so callers can force a refresh after `sync_saved_wallets --commit`:
```js
export { loadWalletCache };
```

#### 2. Update `savedWallets()`

Replace the current implementation (which calls `harvesterWalletMetadata`) with a
cache-backed version:

```js
export function savedWallets() {
  const { walletMap } = getWalletCache();
  return [...walletMap.values()];
}
```

The harvester cross-read is no longer needed here because M5-1 populated all profile
columns directly into `saved_wallets`. Keep `harvesterWalletMetadata` in the file
(do not delete it) — it may still be used by other callers — but `savedWallets()` must
not call it.

#### 3. Update `fetchSavedWalletExposure`

Replace the current implementation with a cache-backed version that also builds the
`evidence` sub-object:

```js
export async function fetchSavedWalletExposure(mint, holders) {
  const { addressSet, walletMap } = getWalletCache();
  const total = walletMap.size;

  if (!total || !holders?.holders?.length) {
    return {
      holderCount: 0,
      checked: total,
      wallets: [],
      matchedWallets: [],
      evidence: { wallets: [], summary: emptySummary() },
    };
  }

  const matched = holders.holders
    .filter(h => addressSet.has(h.address))
    .map(h => walletMap.get(h.address));

  return {
    holderCount: matched.length,
    checked: total,
    wallets: matched.map(w => w.label),
    matchedWallets: matched.map(walletDetail),
    evidence: buildEvidence(matched),
  };
}
```

#### 4. Add `buildEvidence(matched)` helper

```js
function buildEvidence(matched) {
  const now = Date.now();
  const GMGN_STALE_MS = 3 * 86_400_000;
  const JUP_STALE_MS  = 1 * 86_400_000;

  const wallets = matched.map(w => {
    const gmgnFresh = w.gmgn_snapshot_at != null
      && (now - Number(w.gmgn_snapshot_at)) < GMGN_STALE_MS;
    const jupFresh = w.jup_snapshot_at != null
      && (now - Number(w.jup_snapshot_at)) < JUP_STALE_MS;

    const tags = parseTagsJson(w.tags_json);

    return {
      addr: shortAddress(w.address),
      label: w.label,
      tags,
      tier: w.tier || 'universe',
      gmgn: w.gmgn_winrate != null
        ? { wr: w.gmgn_winrate, pnl: w.gmgn_realized_pnl ?? null, fresh: gmgnFresh }
        : null,
      okx: w.okx_winrate != null
        ? { wr: w.okx_winrate, mcap: w.okx_preferred_mcap ?? null, fresh: true }
        : null,
      jup: w.jup_winrate != null
        ? { pnl: w.jup_total_pnl ?? null, wr: w.jup_winrate, fresh: jupFresh }
        : null,
      owner: w.owner_label || null,
    };
  });

  const gmgnWinrates = wallets
    .map(w => w.gmgn?.wr)
    .filter(v => v != null && Number.isFinite(v));

  const summary = {
    avgGmgnWinrate: gmgnWinrates.length
      ? Math.round((gmgnWinrates.reduce((a, b) => a + b, 0) / gmgnWinrates.length) * 1000) / 1000
      : null,
    kolCount: wallets.filter(w => w.tags.some(t => KOL_TAG_RE.test(t))).length,
    smartMoneyCount: wallets.filter(w => w.tags.some(t => /smart_money|smart_degen/i.test(t))).length,
    topTier: topTierOf(wallets.map(w => w.tier)),
    strongCount: wallets.filter(w => w.tier === 'A' || w.tier === 'B').length,
  };

  return { wallets, summary };
}

function emptySummary() {
  return { avgGmgnWinrate: null, kolCount: 0, smartMoneyCount: 0, topTier: null, strongCount: 0 };
}

function topTierOf(tiers) {
  if (tiers.includes('A')) return 'A';
  if (tiers.includes('B')) return 'B';
  if (tiers.includes('C')) return 'C';
  if (tiers.includes('universe')) return 'universe';
  return null;
}

function parseTagsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}
```

#### 5. Keep `walletDetail()` unchanged

The existing `walletDetail(wallet)` function must remain exactly as-is. It is used by
`matchedWallets` which must stay backward-compatible.

#### 6. Keep `harvesterWalletMetadata` in the file

Do NOT delete `harvesterWalletMetadata`. Just stop calling it from `savedWallets()`.

## What NOT to do

- Do not modify `fetchKolDumpRisk` — it reads `matchedWallets` which is unchanged
- Do not modify `filterCandidate` or any hot-path filter logic
- Do not call Jupiter, GMGN, OKX, or any external provider
- Do not run Charon, PM2, Telegram, trading, signing, or swaps
- Do not read `.env` or secrets
- Do not install dependencies
- Do not delete `harvesterWalletMetadata`

## Verification

1. `node --check src/enrichment/wallets.js` passes
2. `savedWallets()` no longer calls `harvesterWalletMetadata`
3. `fetchSavedWalletExposure` return value includes `evidence.wallets` array and
   `evidence.summary` object alongside the existing fields
4. `loadWalletCache` is exported

## Files to modify

| File | Change |
|------|--------|
| `src/enrichment/wallets.js` | Add cache, update `savedWallets()`, update `fetchSavedWalletExposure`, add `buildEvidence` helpers, export `loadWalletCache` |

## Files to read (context)

| File | Why |
|------|-----|
| `src/enrichment/wallets.js` | Full current implementation |
| `SMART_WALLET_ARCH_PLAN.md` sections 3a–3c | Cache design, evidence shape |
