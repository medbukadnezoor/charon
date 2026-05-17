# Planner Handoff: Wallet Auto-Sync Recovery

**Role target:** Planner / Architect
**Repo:** `.`
**Related ticket:** `tickets/WP-M6-AUTOSYNC-WALLETS.md`
**Freshness:** Investigation evidence was collected from the VPS on 2026-05-15 Asia/Jakarta time. Recheck live state before final implementation.

## Objective

Recover the Charon saved-wallet auto-sync pipeline so the 6h cron actually:

1. Runs the approved MoonBags wallet harvester path.
2. Enriches the resulting wallets.
3. Syncs eligible wallets into Charon `saved_wallets`.
4. Restarts Charon only through the existing position-safe restart path.
5. Produces enough structured evidence that future no-op runs are diagnosable.

This is not a trading strategy change. It is wallet-pipeline production reliability plus sync-policy cleanup.

## Safety Boundaries

Follow `AGENTS.md`, `~/AGENTS.md`, and `~/ROLES.md`.

Allowed only under owner-approved wallet-pipeline scope:

- Read PM2 status/logs for `charon-auto-sync`.
- Read `/opt/trading-data/harvester.db` and `/opt/trading-data/charon.sqlite` through read-only checks or approved scripts.
- Modify and deploy wallet-pipeline scripts after owner approval.
- Use `scripts/sync_saved_wallets.js --commit` only for the approved saved-wallet import path.
- Use `scripts/safe_restart_charon.js` only for position-safe Charon restart.

Do not:

- Trade, sign, swap, send Telegram commands, or start ad hoc Charon trading flows.
- Read or print `.env`, private keys, provider keys, Telegram session contents, or secrets.
- Directly mutate Charon SQLite outside approved sync scripts.
- Hot-edit production without reconciling git state.
- Use broad `git add -A` in this dirty repo.

## Confirmed Problem

The `charon-auto-sync` PM2 cron is firing every 6 hours, but it is not collecting new wallets.

Root cause 1: `scripts/auto_sync_wallets.sh` calls:

```bash
npx tsx src/harvester.ts
```

MoonBags now safety-blocks that raw command and tells operators to use:

```bash
npm run harvest:run:gmgn
```

The wrapper currently uses `|| true`, so the harvester failure is swallowed and the pipeline logs `Harvester complete` even though no harvest occurred.

Root cause 2: `scripts/sync_saved_wallets.js --require-enriched` currently means both:

- `gmgn_snapshot_at IS NOT NULL`
- `okx_snapshot_at IS NOT NULL`

But the current cron enrichment path is GMGN-only:

```bash
npx tsx src/enrichWalletProfile.ts --limit=50
```

That produces GMGN profiles but no OKX profiles, so most wallets are permanently ineligible under the current sync gate.

Root cause 3: the operational wallet-pipeline files are currently untracked in git locally and on the VPS, including:

- `scripts/auto_sync_wallets.sh`
- `scripts/sync_saved_wallets.js`
- `scripts/safe_restart_charon.js`
- `ecosystem.config.cjs`

This makes production drift likely and hides critical runtime behavior from the normal deploy path.

## Evidence Collected

PM2:

- `charon-auto-sync` exists.
- `cron_restart` is `0 */6 * * *`.
- It can appear `stopped` between cron runs; that is normal for a cron-style PM2 process.
- Logs are under `/opt/trading-data/logs/auto-sync.log`, `/opt/trading-data/logs/auto-sync-error.log`, and dated logs.

Recent cron logs:

- Each run logs the MoonBags safety message:
  - `Full harvest is disabled for H0 safety.`
  - `Use npm run harvest:run:gmgn for the approved GMGN-only H1 path.`
- The wrapper still logs `Step 1: Harvester complete`.
- Enrichment then logs `{"done":true,"gmgn_stored":50,"okx_stored":0}`.
- Sync repeatedly logs:
  - `Harvester wallets: 908`
  - `Inserted (new): 0`
  - `Updated (existing harvester): 0`
  - `Skipped (manual/protected): 58`
  - `Skipped (missing GMGN+OKX): 840`
  - `Skipped (already up to date): 10`

Harvester DB evidence:

- `runs` max `started_at`: `2026-05-12 06:41:50 UTC`.
- Last real run:
  - `run_id`: `70e64284`
  - `tokens_discovered`: `30`
  - `tokens_harvested`: `7`
  - `wallets_new`: `89`
  - `wallets_updated`: `418`
  - `sightings_added`: `359`
- Current counts:
  - `wallets`: `908`
  - `sightings`: `1337`
  - `tokens`: `103`
  - `wallet_profiles`: `468`
  - GMGN profiles: `468`
  - OKX profiles: `68`

Charon DB evidence:

- `saved_wallets`: `908` total.
- `harvester`: `850`.
- `manual`: `58`.
- Max `last_synced_at`: `2026-05-13 11:31:37 UTC`.
- No saved-wallet growth after the bulk sync.

## Architecture Decision Needed

The planner must explicitly resolve the sync-policy mismatch:

Current M6 ticket says fully enriched means GMGN + OKX. Current production path is GMGN-only. Choose one of these and make it explicit:

1. **GMGN-only eligibility for production auto-sync**
   - Add a sync option such as `--require-profile=gmgn`.
   - Auto-sync uses GMGN profiles as the required intelligence gate.
   - OKX remains optional supporting data when available.
   - This best matches the current approved `npm run harvest:run:gmgn` path.

2. **Both-provider eligibility**
   - Keep GMGN + OKX required.
   - Then auto-sync must run OKX profile enrichment reliably.
   - This requires confirming OKX source availability and credentials without printing secrets.
   - This may keep throughput low if OKX is sparse or blocked.

3. **Configurable eligibility**
   - Preferred long-term shape.
   - Implement `--require-profile=gmgn|okx|both|any`.
   - Default auto-sync to `gmgn` unless owner explicitly approves stricter `both`.
   - Report missing GMGN and missing OKX separately.

Planner recommendation: choose option 3, deploy option `gmgn` for current production, and preserve the ability to tighten to `both` later.

## Required Patch Shape

Plan this as a proper patch, not a VPS-only workaround.

### 1. Git-track the operational surface

Bring these files into version control intentionally:

- `scripts/auto_sync_wallets.sh`
- `scripts/sync_saved_wallets.js`
- `scripts/safe_restart_charon.js`
- `ecosystem.config.cjs`

Avoid unrelated dirty files. Stage paths explicitly.

### 2. Fix harvester invocation

In `scripts/auto_sync_wallets.sh`, replace the raw harvester call with the approved MoonBags script:

```bash
npm run harvest:run:gmgn
```

or an equivalent explicit env command only if the planner determines `npm run` is unsuitable for PM2.

Do not keep `|| true` around the harvester. A failed harvest must fail the pipeline loudly.

### 3. Fix enrichment/sync policy

Implement explicit profile requirement semantics in `scripts/sync_saved_wallets.js`.

Suggested CLI:

```bash
--require-profile=gmgn
--require-profile=okx
--require-profile=both
--require-profile=any
```

Backward compatibility:

- Keep `--require-enriched` accepted.
- Either map it to `both` for strict backward compatibility, or deprecate it with a clear log line.
- For `charon-auto-sync`, use the new explicit flag so the behavior is obvious.

### 4. Improve no-op observability

At minimum, update logs to split:

- missing GMGN
- missing OKX
- missing both
- already up to date
- manual/protected
- eligible before limit
- inserted
- updated

Preferred follow-up: add structured run/event tables or JSONL ledger for:

- harvest command used
- harvest exit code
- discovered tokens
- harvested tokens
- wallets new/updated
- GMGN enriched
- OKX enriched
- sync eligible
- sync inserted/updated/skipped
- restart skipped/restarted/reason

## Verification Plan

Use read-only checks first.

Suggested VPS checks:

```bash
ssh moonbags "pm2 describe charon-auto-sync"
ssh moonbags "tail -n 120 /opt/trading-data/logs/auto-sync.log"
```

Use Node + `better-sqlite3` if `sqlite3` CLI is unavailable on VPS.

Check harvester run freshness:

```js
select count(*) as count, datetime(max(started_at)/1000,'unixepoch') as max_started_utc from runs;
select run_id, datetime(started_at/1000,'unixepoch') as start_utc, status, tokens_discovered, tokens_harvested, wallets_new, wallets_updated, sightings_added
from runs
order by started_at desc
limit 8;
```

Check profile coverage:

```js
select count(*) as total,
       sum(case when gmgn_snapshot_at is not null then 1 else 0 end) as gmgn_profiles,
       sum(case when okx_snapshot_at is not null then 1 else 0 end) as okx_profiles
from wallet_profiles;
```

Check Charon saved wallets:

```js
select count(*) as total, datetime(max(last_synced_at)/1000,'unixepoch') as max_synced_utc
from saved_wallets;

select source, count(*) as count, datetime(min(last_synced_at)/1000,'unixepoch') as min_sync_utc, datetime(max(last_synced_at)/1000,'unixepoch') as max_sync_utc
from saved_wallets
group by source;
```

Code checks:

```bash
node --check scripts/sync_saved_wallets.js
bash -n scripts/auto_sync_wallets.sh
node --check scripts/safe_restart_charon.js
```

Dry-run behavior checks should prove:

- raw harvester path is no longer used
- failed harvest exits non-zero
- GMGN-only profile gate makes eligible wallets visible
- missing OKX no longer blocks GMGN-only mode
- `--require-enriched` compatibility is documented by behavior

## Deployment Guidance

Use the git-first flow:

1. Create or continue a `codex/` branch.
2. Commit only the wallet-pipeline files touched.
3. Push the branch.
4. On VPS, fetch/pull the same branch.
5. Run syntax checks on VPS.
6. Reload/update PM2 only for `charon-auto-sync` if ecosystem changes.
7. Let the next cron prove the fix, or run only the approved wallet auto-sync script if the owner explicitly approves an immediate wallet-pipeline run.

Do not restart Charon directly except through `scripts/safe_restart_charon.js`.

## Next Bounded Step

Planner should produce a Coder ticket that includes:

1. Exact sync-policy choice: likely `--require-profile=gmgn` for production auto-sync.
2. File-level implementation scope.
3. Backward-compatibility requirement for `--require-enriched`.
4. Test/verification commands.
5. Deployment sequence using git and explicit staging.

The Coder should not touch trading logic, Telegram command flow, strategy settings, or secrets.
