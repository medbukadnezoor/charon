# Planner Handoff: Auto-Sync Post-Verification Follow-Up

**Role target:** Planner / Architect
**Repo:** `.`
**Related handoff:** `tickets/PLANNER_HANDOFF_WALLET_AUTOSYNC_RECOVERY.md`
**Branch verified:** `fix/autosync-recovery`
**Commit verified:** `96a0f7c fix(autosync): recover wallet harvest sync pipeline`
**Freshness:** Live VPS checks and one manual production-env auto-sync run were performed on 2026-05-15 Asia/Jakarta time. Recheck current state before implementing follow-up work.

## Objective

Plan the remaining hardening after the auto-sync recovery patch was deployed and verified. The main pipeline now works, but manual execution can still target the wrong DBs if the production PM2 environment variables are missing.

## Safety Boundaries

Follow `AGENTS.md`, `~/AGENTS.md`, and `~/ROLES.md`.

Allowed scope is wallet-pipeline reliability only:

- Read PM2 status/logs for `charon` and `charon-auto-sync`.
- Read `/opt/trading-data/harvester.db` and `/opt/trading-data/charon.sqlite` through read-only checks or approved scripts.
- Modify wallet-pipeline scripts, PM2 ecosystem config, and documentation after owner approval.
- Use `scripts/auto_sync_wallets.sh` and `scripts/safe_restart_charon.js` only within the approved wallet-pipeline path.

Do not:

- Trade, sign, swap, send Telegram commands, or start ad hoc Charon trading flows.
- Read or print `.env`, private keys, provider keys, Telegram session contents, or secrets.
- Directly mutate Charon SQLite outside approved sync scripts.
- Use broad `git add -A` in this dirty repo.

## Confirmed State

The recovery branch is deployed on the VPS and works when run with the production environment:

```bash
CHARON_DB_PATH=/opt/trading-data/charon.sqlite \
HARVESTER_DB_PATH=/opt/trading-data/harvester.db \
MOONBAGS_DIR=/home/opc/moonbags \
LOG_DIR=/opt/trading-data/logs \
bash scripts/auto_sync_wallets.sh
```

Successful run timestamp:

- Auto-sync run started: `2026-05-15T09:36:46Z`.
- Charon safe restart completed: `2026-05-15T09:38:16Z`.

Successful run output summary:

- Harvester completed for real; no H0 safety-block message.
- Harvester DB after run: `993` wallets, `1760` sightings, `518` wallet profiles.
- Latest harvester run:
  - `run_id`: `c4336d93`
  - `start_utc`: `2026-05-15 09:36:49`
  - `status`: `completed`
  - `tokens_discovered`: `30`
  - `tokens_harvested`: `12`
  - `wallets_new`: `85`
  - `wallets_updated`: `539`
  - `sightings_added`: `423`
- Enrichment:
  - `gmgn_stored`: `50`
  - `okx_stored`: `0`
- Charon sync with `--new-only --require-profile=gmgn`:
  - `Inserted (new)`: `48`
  - `Updated (existing harvester)`: `402`
  - `Skipped (manual/protected)`: `58`
  - `Skipped (missing GMGN profile)`: `475`
  - `Skipped (already up to date)`: `10`
- Charon `saved_wallets` after run:
  - total: `956`
  - harvester: `898`
  - manual: `58`
  - max `last_synced_at`: `2026-05-15 09:38:15 UTC`
- Open dry-run positions at restart check: `0`.
- `scripts/safe_restart_charon.js` restarted Charon.
- PM2 after run:
  - `charon`: online
  - `charon-auto-sync`: stopped between cron runs, expected for cron-style PM2 process.
- Charon logs after restart included:
  - `[bot] wallet cache loaded`
  - `[bot] Charon started (server mode: https://api.thecharon.xyz/api)`

Post-run dry-run proof:

- `node scripts/sync_saved_wallets.js --new-only --require-profile=gmgn --harvester-db=/opt/trading-data/harvester.db --charon-db=/opt/trading-data/charon.sqlite`
- Result after the successful run:
  - `Would insert (new)`: `0`
  - `Would update (existing harvester)`: `0`
  - `Skipped (already up to date)`: `460`
  - exit `0`

## Caveat Found During Verification

Bare manual execution from `/home/opc/charon` is still unsafe/confusing:

```bash
bash scripts/auto_sync_wallets.sh
```

That run did execute the harvester, but without the PM2 env it targeted MoonBags' default local harvester DB and then failed Charon sync because it defaulted to `/home/opc/charon/charon.sqlite`, which does not contain the production `saved_wallets` table.

Observed failure:

- `SqliteError: no such table: saved_wallets`
- Cause: missing `CHARON_DB_PATH=/opt/trading-data/charon.sqlite` and `HARVESTER_DB_PATH=/opt/trading-data/harvester.db` in the manual shell.

The PM2 cron should be fine because its ecosystem config supplies the correct production env. The remaining problem is operator-proofing manual runs and making this failure mode impossible or explicit.

## Architecture Decision Needed

Choose the hardening behavior for `scripts/auto_sync_wallets.sh`:

1. **Fail fast unless production DB env vars are set**
   - Require `CHARON_DB_PATH` and `HARVESTER_DB_PATH`.
   - Validate both files exist.
   - Validate Charon DB contains `saved_wallets`.
   - Validate harvester DB contains `wallets`, `wallet_profiles`, and `runs`.
   - This is safest and makes PM2/environment dependency explicit.

2. **Default to VPS production paths when running under `/home/opc/charon`**
   - If `/opt/trading-data/charon.sqlite` and `/opt/trading-data/harvester.db` exist, use them automatically.
   - This is convenient for VPS manual operation but less portable locally.

3. **Add explicit `--production` or `--dry-run` mode**
   - More work because the script currently uses env vars, not CLI parsing.
   - Could be useful later, but likely overkill for the immediate fix.

Planner recommendation: choose option 1 for safety, with clear error messages showing the exact env vars required. Do not silently pick a DB when the path is ambiguous.

## Proposed Follow-Up Ticket

Create a small Coder ticket:

**Title:** Harden auto-sync DB path validation for manual VPS runs

Scope:

- Update `scripts/auto_sync_wallets.sh`.
- Add early validation before Step 1:
  - `CHARON_DB_PATH` must be set or resolve to a valid intended path.
  - `HARVESTER_DB_PATH` must be set or resolve to a valid intended path.
  - Both DB files must exist.
  - Charon DB must have `saved_wallets`.
  - Harvester DB must have `wallets`, `wallet_profiles`, and `runs`.
- Print secret-safe diagnostics:
  - resolved Charon DB path
  - resolved harvester DB path
  - missing table/path reason
- Exit non-zero before harvest if DB paths are invalid.
- Keep PM2 cron behavior unchanged.
- Update docs or operator notes with the correct manual command:

```bash
CHARON_DB_PATH=/opt/trading-data/charon.sqlite \
HARVESTER_DB_PATH=/opt/trading-data/harvester.db \
MOONBAGS_DIR=/home/opc/moonbags \
LOG_DIR=/opt/trading-data/logs \
bash scripts/auto_sync_wallets.sh
```

Verification:

```bash
bash -n scripts/auto_sync_wallets.sh
node --check scripts/sync_saved_wallets.js
node --check scripts/safe_restart_charon.js
```

VPS checks:

```bash
cd /home/opc/charon
bash scripts/auto_sync_wallets.sh
# Expected without env: fail fast before harvest with clear DB env/path error.

CHARON_DB_PATH=/opt/trading-data/charon.sqlite \
HARVESTER_DB_PATH=/opt/trading-data/harvester.db \
MOONBAGS_DIR=/home/opc/moonbags \
LOG_DIR=/opt/trading-data/logs \
bash scripts/auto_sync_wallets.sh
# Expected with env: full approved wallet-pipeline run.
```

Important: do not run the second full pipeline command unless owner approves another immediate harvest/sync/restart. For Coder verification, prefer syntax checks and a validation-only mode if added.

## Files To Read First

- `AGENTS.md`
- `tickets/PLANNER_HANDOFF_WALLET_AUTOSYNC_RECOVERY.md`
- `tickets/WP-M6-AUTOSYNC-WALLETS.md`
- `scripts/auto_sync_wallets.sh`
- `scripts/sync_saved_wallets.js`
- `scripts/safe_restart_charon.js`
- `ecosystem.config.cjs`

## Exact Next Step

Planner should write a narrow Coder ticket for DB path validation and operator-proof manual execution. Keep the ticket limited to `scripts/auto_sync_wallets.sh` plus any minimal doc/operator note update. Do not reopen strategy, trading, Telegram, or wallet-source policy unless the owner asks.
