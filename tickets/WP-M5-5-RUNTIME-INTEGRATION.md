# WP-M5-5: Runtime integration (owner-gated)

**Type:** Coder
**Parent plan:** `SMART_WALLET_ARCH_PLAN.md`
**Status:** Open
**Owner approval:** Required before each gated step (see below)

---

## Goal

Wire the M5-1 through M5-4 work into the live Charon runtime:
1. Call `loadWalletCache()` at startup so the first candidate check hits the cache
2. Confirm the sync and runtime work correctly in dry-run before any live deploy

---

## What to implement

### Step 1 — Hook `loadWalletCache` into Charon startup (CODE CHANGE)

**File:** `src/app.js`

In `startCharon()`, after `initDb()` and before `initLiveExecution()`, add:

```js
import { loadWalletCache } from './enrichment/wallets.js';
```

Add to the top of `startCharon()`:
```js
  loadWalletCache();
  console.log('[bot] wallet cache loaded');
```

Full diff:

```js
// BEFORE
export async function startCharon() {
  initDb();
  initLiveExecution();

// AFTER
export async function startCharon() {
  initDb();
  loadWalletCache();
  console.log('[bot] wallet cache loaded');
  initLiveExecution();
```

And add the import at the top of the file with the other imports:
```js
import { loadWalletCache } from './enrichment/wallets.js';
```

This is the only code change in M5-5. Everything else is operational steps.

---

## Operational steps (owner executes, not the coder)

### Gate 1 — Dry-run sync (OWNER RUNS, read-only harvester)

```bash
cd "."
node scripts/sync_saved_wallets.js --dry-run
```

Review output:
- Harvester wallet count (expect 800+)
- Tier distribution (A/B/C/universe)
- Skipped manual count (expect ~70)
- Label preview looks sane

**Do not proceed to Gate 2 until you are satisfied with the dry-run output.**

### Gate 2 — Commit sync (OWNER RUNS, writes to charon.sqlite)

```bash
node scripts/sync_saved_wallets.js --commit
```

Verify:
```bash
sqlite3 charon.sqlite "SELECT source, tier, COUNT(*) FROM saved_wallets GROUP BY source, tier ORDER BY source, tier"
sqlite3 charon.sqlite "SELECT COUNT(*) FROM saved_wallets WHERE source='manual'"
```

Expected: manual count unchanged (~70), harvester rows present with tier distribution.

### Gate 3 — Static check (CODER RUNS)

```bash
node --check src/app.js
```

### Gate 4 — Charon dry-run cycle (OWNER RUNS, requires Charon .env)

Start Charon in dry-run mode and watch one screening cycle:
- Confirm `[bot] wallet cache loaded` appears in startup logs
- Confirm `fetchSavedWalletExposure` no longer logs harvester cross-read warnings
- Confirm `savedWalletExposure.checked` in candidate logs shows 800+ (not 70)
- Confirm no new errors in the first 5 minutes

**This step requires the Charon .env and is NOT run by the coder agent.**

---

## Verification (coder scope)

1. `node --check src/app.js` passes
2. `loadWalletCache` is imported and called before `initLiveExecution()`
3. No other runtime files are modified

---

## Files to modify

| File | Change |
|------|--------|
| `src/app.js` | Import `loadWalletCache`, call it after `initDb()` |

## Files to read (context)

| File | Why |
|------|-----|
| `src/app.js` | Current startup sequence |
| `src/enrichment/wallets.js` | Confirm `loadWalletCache` export exists |
