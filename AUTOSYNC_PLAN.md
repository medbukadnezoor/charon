# WP-M6: Auto-Sync Enriched Wallets + Position-Safe Charon Restart

Created: 2026-05-13
Status: **Owner approved — 2026-05-13**
Parent: `SMART_WALLET_ARCH_PLAN.md` (M5 complete)

---

## Goal

After the harvester ingests new wallets and enriches them with GMGN/OKX profiles, automatically:

1. Detect which wallets are newly enriched (have both GMGN and OKX data)
2. Sync only those new ones into Charon `saved_wallets`
3. Restart Charon — but only when there are zero open positions

No manual intervention. Runs on the VPS alongside Charon.

---

## Current state

| Thing | Status |
|-------|--------|
| Harvester (`harvest:run`) | Manual, not scheduled |
| Profile enrichment (`enrich:profiles`) | Manual, not scheduled |
| `sync_saved_wallets.js` | Exists (M5-1), manual `--commit` |
| Charon open positions | `dry_run_positions WHERE status = 'open'` |
| PM2 on VPS | All processes stopped, Charon at id 8 |

---

## Pipeline

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│  Harvester   │ ──► │  Enrich profiles │ ──► │  Sync to Charon │ ──► │ Safe restart │
│ harvest:run  │     │ enrich:profiles  │     │ (new+enriched   │     │ (wait for no │
│              │     │ (GMGN + OKX)     │     │  wallets only)  │     │  positions)  │
└─────────────┘     └──────────────────┘     └─────────────────┘     └──────────────┘
```

One orchestrator script runs this end-to-end on a cron/PM2 schedule.

---

## Design

### 1. Orchestrator script: `scripts/auto_sync_wallets.sh`

Shell script on the VPS that runs the full pipeline:

```
Step 1: Run harvester
  cd ~/moonbags/tools/wallet-harvester
  npm run harvest:run
  → discovers new wallets, adds to harvester.db

Step 2: Enrich new wallets with GMGN + OKX profiles
  npm run enrich:profiles -- --limit=50
  → calls GMGN/OKX for wallets missing profiles
  → writes to wallet_profiles table in harvester.db

Step 3: Incremental sync to Charon (new enriched wallets only)
  cd ~/charon
  node scripts/sync_saved_wallets.js --commit --new-only --require-enriched
  → queries harvester.db for wallets where:
      - wallet_profiles.gmgn_snapshot_at IS NOT NULL
      - wallet_profiles.okx_snapshot_at IS NOT NULL
      - address NOT IN charon saved_wallets (or last_synced_at < wallet_profiles snapshot)
  → UPSERT into saved_wallets
  → exits with code 0 if new wallets synced, code 2 if nothing new

Step 4: If new wallets were synced (exit code 0), safe restart Charon
  node scripts/safe_restart_charon.js
  → checks dry_run_positions WHERE status = 'open'
  → if 0 open positions: pm2 restart charon
  → if open positions: wait and poll every 30s, up to max wait (e.g. 30 min)
  → if still open after max wait: skip restart, log warning, notify owner
```

### 2. Changes to `sync_saved_wallets.js`

Add two new flags:

**`--new-only`**: Only sync wallets not already in `saved_wallets` (by address). Skip wallets that are already synced unless their profile data is newer than `last_synced_at`.

**`--require-enriched`**: Only sync wallets that have BOTH `gmgn_snapshot_at` AND `okx_snapshot_at` in `wallet_profiles`. Skip unenriched wallets entirely.

Combined query for eligible wallets:
```sql
SELECT w.address
FROM wallets w
INNER JOIN wallet_profiles wp ON w.address = wp.address
WHERE wp.gmgn_snapshot_at IS NOT NULL
  AND wp.okx_snapshot_at IS NOT NULL
  AND (
    w.address NOT IN (SELECT address FROM saved_wallets)
    OR wp.gmgn_snapshot_at > (SELECT last_synced_at FROM saved_wallets WHERE address = w.address)
    OR wp.okx_snapshot_at > (SELECT last_synced_at FROM saved_wallets WHERE address = w.address)
  )
```

Exit codes:
- `0` — new wallets synced
- `2` — nothing new to sync (no restart needed)
- `1` — error

### 3. New script: `scripts/safe_restart_charon.js`

Standalone Node script that:

1. Opens Charon DB read-only
2. Checks `SELECT COUNT(*) FROM dry_run_positions WHERE status = 'open'`
3. If 0 open positions:
   - Run `pm2 restart charon`
   - Log: `[safe-restart] no open positions, restarted charon`
   - Exit 0
4. If open positions:
   - Log: `[safe-restart] ${count} open positions, waiting...`
   - Poll every 30 seconds
   - Max wait: configurable via `--max-wait-minutes=30` (default 30)
   - If positions close within max wait → restart
   - If max wait exceeded → log warning, exit 3 (skip restart)
   - Optional: `--notify` flag sends a Telegram message if restart was skipped

**Does NOT:**
- Force-close positions
- Modify position state
- Touch `.env` or secrets
- Call any trading/signing/swap APIs

### 4. Schedule

PM2 cron or system crontab on the VPS:

```bash
# Run every 4 hours
0 */4 * * * /home/opc/charon/scripts/auto_sync_wallets.sh >> /home/opc/charon/logs/auto-sync.log 2>&1
```

Or as a PM2 entry with `cron_restart`:

```js
{
  name: "wallet-auto-sync",
  script: "/home/opc/charon/scripts/auto_sync_wallets.sh",
  cron_restart: "0 */4 * * *",
  autorestart: false,
  watch: false,
}
```

Frequency is owner-configurable. 4 hours is suggested because:
- Harvester discovers wallets from GMGN trending/trenches which rotate every few hours
- GMGN/OKX enrichment is rate-limited (~50 wallets per run at their pace)
- More frequent than 4h risks hitting provider rate limits

---

## Milestone ladder

### M6-1: `--new-only` and `--require-enriched` flags on sync script
**Type:** Coder
**Scope:**
- Add both flags to `scripts/sync_saved_wallets.js`
- Add exit code 2 for "nothing new"
- Static `node --check` + dry-run test against real harvester DB
**Gate:** Dry-run shows correct filtering (only enriched, only new)

### M6-2: `safe_restart_charon.js` script
**Type:** Coder
**Scope:**
- New `scripts/safe_restart_charon.js`
- Reads `dry_run_positions` (read-only)
- Polls until 0 open, then `pm2 restart charon`
- `--max-wait-minutes` and `--dry-run` flags
- Static `node --check` only, no actual restart
**Gate:** Dry-run shows correct position check and wait logic

### M6-3: Orchestrator shell script
**Type:** Coder
**Scope:**
- New `scripts/auto_sync_wallets.sh`
- Chains: harvest → enrich → sync (--new-only --require-enriched --commit) → safe restart
- Logging with timestamps
- Exit early if sync reports nothing new (exit code 2)
**Gate:** Manual walk-through on VPS with each step verified

### M6-4: VPS deployment + schedule (owner-gated)
**Type:** Coder (requires owner approval)
**Scope:**
- Deploy scripts to VPS
- Set up cron or PM2 cron entry
- Verify first auto-run end-to-end
- Monitor logs for one cycle
**Gate:** Owner observes one successful auto-sync cycle

---

## What this plan does NOT do

- Does not force-close positions or touch trading state
- Does not run Charon in live/confirm mode
- Does not touch `.env`, secrets, or wallet keys
- Does not modify the harvester itself (just calls existing `harvest:run` and `enrich:profiles`)
- Does not auto-delete wallets from `saved_wallets`
- Does not restart Charon while positions are open

---

## Open decisions for owner

1. **Schedule frequency**: 4 hours suggested. More frequent? Less?
2. **Max wait for positions to close**: 30 minutes default. If positions are still open after 30 min, skip restart and wait for next cycle. OK?
3. **Telegram notification**: Should the script notify you via Telegram when it syncs new wallets and/or when it skips a restart due to open positions?
4. **Enrichment limit per run**: `enrich:profiles --limit=50` means at most 50 new wallets get GMGN+OKX data per cycle. Enough? The rate limit is the bottleneck here.
