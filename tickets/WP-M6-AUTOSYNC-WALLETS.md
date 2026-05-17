# WP-M6: Auto-Sync Enriched Wallets + Position-Safe Charon Restart

**Type:** Coder
**Parent plan:** `AUTOSYNC_PLAN.md`
**Status:** Open
**Milestones covered:** M6-1, M6-2, M6-3

---

## Goal

Build a fully automated pipeline that:
1. Runs the harvester to discover new wallets
2. Enriches them with GMGN + OKX profiles
3. Syncs only new, fully-enriched wallets into Charon `saved_wallets`
4. Restarts Charon only when there are zero open positions

All three deliverables (sync flags, safe restart script, orchestrator shell script) are in this ticket.

## Owner-visible outcome

After this ticket:
1. `node scripts/sync_saved_wallets.js --dry-run --new-only --require-enriched` shows only wallets that have both GMGN and OKX profiles AND are not already in `saved_wallets` (or have newer profile data).
2. `node scripts/safe_restart_charon.js --dry-run` reports the current open position count and whether it would restart.
3. `bash scripts/auto_sync_wallets.sh` chains the full pipeline: harvest → enrich → sync → safe restart.
4. `node --check` passes on all new/modified files.

---

## Deliverable 1: `--new-only` and `--require-enriched` flags on sync script

### File: `scripts/sync_saved_wallets.js`

Add two new CLI flags to the existing sync script:

**`--new-only`**
Only sync wallets that meet one of:
- Address not already in Charon `saved_wallets`
- Address exists in `saved_wallets` but harvester profile data is newer than `saved_wallets.last_synced_at`

**`--require-enriched`**
Only sync wallets where `wallet_profiles` has BOTH:
- `gmgn_snapshot_at IS NOT NULL`
- `okx_snapshot_at IS NOT NULL`

Skip any wallet missing either profile. This ensures only wallets with real intelligence get into Charon.

**Combined SQL for eligible wallets (harvester DB joined with Charon DB):**

After loading Charon's existing `saved_wallets` addresses and their `last_synced_at` timestamps into a Map, filter harvester wallets:

```js
// Pseudocode for the filter logic
function isEligible(harvesterWallet, profile, charonSavedMap) {
  // --require-enriched: must have both GMGN and OKX
  if (!profile?.gmgn_snapshot_at || !profile?.okx_snapshot_at) return false;

  // --new-only: skip if already synced and profiles haven't been refreshed
  const existing = charonSavedMap.get(harvesterWallet.address);
  if (existing && existing.source === 'harvester') {
    const lastSync = existing.last_synced_at || 0;
    const profileFresher = profile.gmgn_snapshot_at > lastSync
                        || profile.okx_snapshot_at > lastSync;
    if (!profileFresher) return false;
  }

  return true;
}
```

**Exit codes:**
- `0` — new wallets were synced (signals downstream that a restart may be needed)
- `2` — nothing new to sync (orchestrator skips restart)
- `1` — error

**Dry-run output example:**
```
[sync] --new-only --require-enriched mode
[sync] Harvester wallets: 920
[sync] With GMGN+OKX profiles: 340
[sync] Already in Charon (up to date): 320
[sync] Eligible for sync: 20
[sync] DRY RUN — would insert 18, update 2
```

**Implementation notes:**
- The existing sync logic (scoring, tier assignment, label generation, UPSERT) stays the same. These flags only filter WHICH wallets enter the sync pipeline.
- When both flags are omitted, the script behaves exactly as it does now (full sync).
- Read the existing `sync_saved_wallets.js` carefully before modifying — it already has `--dry-run`, `--commit`, `--stats-only`, and scoring/tier logic from M5-1. Add the new flags alongside.

---

## Deliverable 2: `scripts/safe_restart_charon.js`

New standalone Node script.

### Behavior

1. Open Charon DB **read-only**
2. Query: `SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = 'open'`
3. If 0 open positions:
   - Run: `child_process.execSync('pm2 restart charon')`
   - Log: `[safe-restart] 0 open positions, restarted charon at <ISO timestamp>`
   - Exit 0
4. If open positions exist:
   - Log: `[safe-restart] ${count} open position(s), waiting...`
   - Poll every 30 seconds (re-query the DB)
   - Max wait: `--max-wait-minutes=30` (default 30, configurable)
   - If positions close within max wait → restart, exit 0
   - If max wait exceeded:
     - Log: `[safe-restart] max wait exceeded, ${count} position(s) still open, skipping restart`
     - Exit 3

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | false | Check positions and log what would happen, don't actually restart |
| `--max-wait-minutes=N` | 30 | How long to wait for positions to close |
| `--charon-db=PATH` | `./charon.sqlite` | Path to Charon DB |
| `--poll-interval-sec=N` | 30 | Seconds between position checks |

### Exit codes

- `0` — restarted successfully (or dry-run would restart)
- `1` — error (DB not found, pm2 failed, etc.)
- `3` — skipped restart (positions still open after max wait)

### Safety

- Opens DB read-only — never modifies position state
- Never force-closes positions
- Never touches `.env`, secrets, wallet keys, or trading APIs
- Uses `child_process.execSync('pm2 restart charon')` — only runs pm2, nothing else
- `--dry-run` mode makes zero side effects

### Implementation

```js
import Database from 'better-sqlite3';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// Use the same argValue/argNumber/hasFlag helpers pattern as other scripts
// (see scripts/refresh_wallet_pnl.js for the pattern)

function openPositionCount(db) {
  return db.prepare(
    'SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?'
  ).get('open').count;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const charonDb = path.resolve(argValue('charon-db', process.env.CHARON_DB_PATH || './charon.sqlite'));
  const maxWaitMs = argNumber('max-wait-minutes', 30) * 60 * 1000;
  const pollMs = argNumber('poll-interval-sec', 30) * 1000;
  const dryRun = hasFlag('dry-run');

  if (!fs.existsSync(charonDb)) throw new Error(`Charon DB not found: ${charonDb}`);

  const db = new Database(charonDb, { readonly: true, fileMustExist: true });
  const startedAt = Date.now();

  let count = openPositionCount(db);

  while (count > 0) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= maxWaitMs) {
      console.log(`[safe-restart] max wait exceeded, ${count} position(s) still open, skipping restart`);
      db.close();
      process.exit(3);
    }
    console.log(`[safe-restart] ${count} open position(s), waiting ${pollMs / 1000}s... (${Math.round(elapsed / 1000)}s elapsed)`);
    await sleep(pollMs);
    count = openPositionCount(db);
  }

  db.close();

  if (dryRun) {
    console.log(`[safe-restart] DRY RUN — would restart charon (0 open positions)`);
    process.exit(0);
  }

  console.log(`[safe-restart] 0 open positions, restarting charon...`);
  execSync('pm2 restart charon', { stdio: 'inherit' });
  console.log(`[safe-restart] charon restarted at ${new Date().toISOString()}`);
}

main().catch(err => {
  console.error(`[safe-restart] ERROR: ${err.message}`);
  process.exit(1);
});
```

---

## Deliverable 3: `scripts/auto_sync_wallets.sh`

Shell script that chains the full pipeline. Runs on the VPS via cron or PM2.

### Script

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHARON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Paths — adjust for VPS layout
MOONBAGS_DIR="${MOONBAGS_DIR:-$(cd "$CHARON_DIR/../moonbags" && pwd)}"
HARVESTER_DIR="$MOONBAGS_DIR/tools/wallet-harvester"
CHARON_DB="$CHARON_DIR/charon.sqlite"
HARVESTER_DB="$HARVESTER_DIR/data/harvester.db"
LOG_PREFIX="[auto-sync $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

echo "$LOG_PREFIX Starting wallet auto-sync pipeline"

# Step 1: Run harvester
echo "$LOG_PREFIX Step 1: Running harvester..."
cd "$HARVESTER_DIR"
npx tsx src/harvester.ts 2>&1 | tail -5
echo "$LOG_PREFIX Step 1: Harvester complete"

# Step 2: Enrich new wallets with GMGN + OKX profiles
echo "$LOG_PREFIX Step 2: Enriching wallet profiles (limit 50)..."
npx tsx src/enrichWalletProfile.ts --limit=50 2>&1 | tail -10
echo "$LOG_PREFIX Step 2: Enrichment complete"

# Step 3: Sync new enriched wallets to Charon
echo "$LOG_PREFIX Step 3: Syncing new enriched wallets to Charon..."
cd "$CHARON_DIR"
SYNC_EXIT=0
node scripts/sync_saved_wallets.js \
  --commit \
  --new-only \
  --require-enriched \
  --harvester-db="$HARVESTER_DB" \
  --charon-db="$CHARON_DB" \
  2>&1 | tail -10 || SYNC_EXIT=$?

if [ "$SYNC_EXIT" -eq 2 ]; then
  echo "$LOG_PREFIX Step 3: No new wallets to sync, skipping restart"
  echo "$LOG_PREFIX Pipeline complete (no changes)"
  exit 0
elif [ "$SYNC_EXIT" -ne 0 ]; then
  echo "$LOG_PREFIX Step 3: Sync failed with exit code $SYNC_EXIT"
  exit 1
fi

echo "$LOG_PREFIX Step 3: Sync complete, new wallets added"

# Step 4: Safe restart Charon (wait for no open positions)
echo "$LOG_PREFIX Step 4: Waiting for safe restart window..."
node scripts/safe_restart_charon.js \
  --charon-db="$CHARON_DB" \
  --max-wait-minutes=30 \
  --poll-interval-sec=30 \
  2>&1 || RESTART_EXIT=$?

if [ "${RESTART_EXIT:-0}" -eq 3 ]; then
  echo "$LOG_PREFIX Step 4: Restart skipped (positions still open), will retry next cycle"
elif [ "${RESTART_EXIT:-0}" -ne 0 ]; then
  echo "$LOG_PREFIX Step 4: Restart failed with exit code ${RESTART_EXIT:-1}"
  exit 1
else
  echo "$LOG_PREFIX Step 4: Charon restarted successfully"
fi

echo "$LOG_PREFIX Pipeline complete"
```

### Key behaviors

- `set -euo pipefail` — fails fast on errors (except sync exit code 2 which is handled)
- Logs are timestamped and tailed (last 5-10 lines per step to keep log readable)
- If sync reports nothing new (exit 2) → skip restart entirely
- If restart skipped due to open positions (exit 3) → next cron cycle will try again
- VPS paths are derived from script location + `MOONBAGS_DIR` override for flexibility
- No `.env` reads, no secrets, no trading

### Make executable
```bash
chmod +x scripts/auto_sync_wallets.sh
```

---

## Files to create

| File | Description |
|------|-------------|
| `scripts/safe_restart_charon.js` | Position-safe PM2 restart |
| `scripts/auto_sync_wallets.sh` | Orchestrator shell script |

## Files to modify

| File | Change |
|------|--------|
| `scripts/sync_saved_wallets.js` | Add `--new-only`, `--require-enriched` flags and exit code 2 |

## Files to read (context)

| File | Why |
|------|-----|
| `scripts/sync_saved_wallets.js` | Existing sync logic to extend |
| `scripts/refresh_wallet_pnl.js` | CLI flag pattern (`argValue`, `argNumber`, `hasFlag`) |
| `src/db/positions.js:5-6` | `openPositions()` query pattern |
| `src/db/connection.js:63-70` | `dry_run_positions` schema |
| `AUTOSYNC_PLAN.md` | Full architecture context |
| `SMART_WALLET_ARCH_PLAN.md` | M5 context (sync script design) |

---

## What NOT to do

- Do not run Charon, PM2, Telegram, trading, signing, or swaps
- Do not read `.env` or secrets
- Do not install dependencies
- Do not modify position state, force-close positions, or touch trading logic
- Do not modify the harvester code (just call existing scripts)
- Do not auto-delete wallets from `saved_wallets`
- Do not set up the cron schedule (that's M6-4, owner-gated)

## Verification

1. `node --check scripts/sync_saved_wallets.js` passes
2. `node --check scripts/safe_restart_charon.js` passes
3. `bash -n scripts/auto_sync_wallets.sh` passes (shell syntax check)
4. `node scripts/sync_saved_wallets.js --dry-run --new-only --require-enriched` runs against real harvester DB, shows correct filtering (only enriched wallets, only new/updated ones)
5. `node scripts/sync_saved_wallets.js --dry-run --new-only --require-enriched` exits with code 2 when run twice in a row (nothing new to sync)
6. `node scripts/safe_restart_charon.js --dry-run` reports current open position count and says "would restart" or "would wait"
7. `scripts/auto_sync_wallets.sh` is executable (`chmod +x`)
