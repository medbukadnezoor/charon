# Charon Next Agent Handoff — 2026-05-21

Repo: `/Users/marcelyuwono/Trading Project Files/charon`
VPS alias: `moonbags`
Updated: `2026-05-21T18:12Z` / `2026-05-21 01:12 Asia/Jakarta`
Target role: Architect / Planner agent

## Follow

- `./AGENTS.md`
- `~/AGENTS.md`
- `~/ROLES.md`

Do not read `.env`, secrets, provider keys, Telegram tokens, wallet keys, raw
logs, or broad PM2 env. Do not send Telegram commands. Do not mutate PM2 unless
a ticket explicitly permits it.

---

## What Happened This Session (2026-05-21)

### Sequence completed

| Ticket | Result |
|--------|--------|
| SOAK-2 review | STATUS: steady. Shadow ran cleanly 24h. |
| AUTO-2 | Skipped — VPS automation already healthy. |
| DELIVER-1 (D-Commit) | 14 analysis files committed + deployed to VPS. |
| RPT-1 | Shadow runner analysis run. 2,435 mints, 498 2x+, 272 3x+. Artifacts at `reports/shadow-runner-analysis/SHADOW-RPT-1-2026-05-21T15-29-25Z/`. |
| INT-1 | Charon Intelligence pipeline refreshed. Synthesis complete. |
| Alt gate bug fix (2 commits) | Fixed and deployed. See below. |
| OKX enrichment (4 tickets) | Fixed and confirmed working. See below. |

---

## Current Live State

### Active branch

`feat/ohlcv-entry-confirmation-soft-cutoff` — live on VPS.

### HEAD commits (local = VPS = origin)

```
697137d fix: pass --okx to enrichWalletProfile when OKX discovery enabled
e32f0df fix: defer alt gate quality check to candidateBuilder where full wallet data is available
b6819a5 fix: alt gate fires when fee_claim_alt_gate_enabled=true regardless of require_fee_claim
a1d47c7 feat: add shadow runner analysis scripts and tests (DELIVER-1)
1014470 docs: update AGENTS.md to current live state (2026-05-21)
```

### Live strategy: sniper

| Parameter | Value |
|-----------|-------|
| trading_mode | live |
| position_size_sol | 0.03 |
| tp_percent | +300% |
| sl_percent | -60% |
| max_top20_holder_percent | 45% |
| trending_max_bundler_rate | 0.4 |
| max_open_positions | 3 |
| fee_claim_alt_gate_enabled | true |
| fee_claim_alt_threshold | 40 |
| soft_cutoff_ms | 14400000 (4h) |
| reentry_enabled | true |
| entry_confirm_ohlcv_count | 15 |

### PM2 processes (as of 2026-05-21T18:00Z)

| Name | ID | Status |
|------|----|--------|
| charon | 22 | online |
| charon-shadow | 10 | online |
| charon-observation-collector | 13 | online |
| charon-shadow-observation-collector | 14 | online |
| charon-shadow-sync | 16 | stopped (cron `0 */2 * * *`) |
| charon-auto-sync | 17 | stopped (cron `0 */2 * * *`) |
| charon-shadow-notifier | 18 | stopped (cron `*/30 * * * *`) |
| cli-proxy-api | 24 | online |

---

## Alt Gate Fix — What Changed

### Bug

`fee_claim_alt_gate_enabled: true` was set in the DB but the alt gate never
fired. Both `serverClient.js` and `candidateBuilder.js` gated the alt gate
check inside `if (strat.require_fee_claim)`, but `require_fee_claim` is
`false`. So no-fee-claim tokens bypassed the quality check entirely.

### Fix (commits b6819a5 + e32f0df)

Two-step fix:

1. `b6819a5` — Restructured both files so the alt gate fires when
   `fee_claim_alt_gate_enabled=true && !hasFee`, regardless of
   `require_fee_claim`.

2. `e32f0df` — Removed the early signal-level alt gate score check from
   `serverClient.js` entirely. Reason: `savedWalletHolderCount` is not
   available at signal level, so the score was always 0 and all tokens
   failed. The real quality check in `candidateBuilder.js` has full data
   and runs correctly.

### Current behavior

No-fee-claim tokens pass through `serverClient.js` unchanged (unless
`require_fee_claim=true` with alt gate off — hard reject). They reach
`candidateBuilder.js` where the full alt gate runs:
- ≥2 saved wallet holders
- ≤40% top-20 holder concentration
- ≥2 sources
- alt score ≥40

Verified working: `fee_claim_alt_min_saved_wallets` and
`fee_claim_alt_max_holder_pct` rejections visible in `screening_events`
post-deploy.

---

## OKX Enrichment Fix — What Changed

### Root causes

Two separate bugs:

1. `HARVESTER_ENABLE_OKX_DISCOVERY` defaulted to `false` in
   `auto_sync_wallets.sh` and was never set to `true` in
   `ecosystem.config.cjs`. OKX discovery never ran.

2. Even after enabling discovery, `enrichWalletProfile.ts` only runs OKX
   profile enrichment when `--okx` CLI flag is passed. The flag was never
   passed in Step 2 of `auto_sync_wallets.sh`. So `okx_stored` was always 0.

### Fix

- `ecosystem.config.cjs`: added `HARVESTER_ENABLE_OKX_DISCOVERY: "true"`,
  `HARVESTER_OKX_MAX_CALLS_PER_RUN: "55"`, `HARVESTER_OKX_MIN_INTERVAL_MS:
  "1200"` to `charon-auto-sync` env block.

- `scripts/auto_sync_wallets.sh`: Step 2 now conditionally passes `--okx`
  to `enrichWalletProfile.ts` when `HARVESTER_ENABLE_OKX_DISCOVERY=true`.

### Confirmed working

First post-deploy run at 18:00 UTC:
- `okx_stored: 25` (was 0 on all prior runs)
- `harvester.db okx_enriched: 100` (up from baseline of 10)
- 0 rate-limit hits

### Enrichment projection

- 25 wallets/run × 12 runs/day ≈ 300/day
- 2,217 wallets remaining → full enrichment in ~7-10 days
- Pacing: 1200ms/call = 0.83 RPS (within OKX trial tier 1 RPS limit)
- Daily call cap: 500 (set in harvester config)

---

## RPT-1 Key Findings

Report at: `reports/shadow-runner-analysis/SHADOW-RPT-1-2026-05-21T15-29-25Z/`

| Metric | Value |
|--------|-------|
| Total mints | 2,435 |
| 2x+ runners | 498 (20.5%) |
| 3x+ runners | 272 (11.2%) |
| 5x+ runners | 129 (5.3%) |
| 10x+ runners | 44 (1.8%) |
| Observation coverage | 59.5% |
| Harvester coverage | 3% of mints |

Top missed runners:

| Token | Multiple | Blocker |
|-------|----------|---------|
| MANIFEST | 632x | fee_claim_missing_required (now fixed by alt gate) |
| TOESCOIN | 246x | min_saved_wallet_holders |
| HENRY | 89x | token_age_above_max |

Best filter recipe: `broad_recall_plus_recurring_runner_wallet` — 25.3%
precision, 62.2% recall, F1 36.0% (+4% precision over baseline).

Tier A wallets = 0 across all mints — wallet quality gates requiring Tier A
are dead weight until OKX enrichment completes.

---

## Pending Work

### 1. Monitor alt gate (48-72h from 2026-05-21T16:26Z)

Check at 2026-05-23T16:00Z or later:

```bash
# Alt gate pass vs reject ratio
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite',{readonly:true}); const r=db.prepare('SELECT action,reason_code,COUNT(*) as n FROM screening_events WHERE at_ms>? AND has_fee_claim=0 GROUP BY action,reason_code ORDER BY n DESC').all(Date.now()-172800000); r.forEach(x=>console.log(x.action,x.reason_code,x.n)); db.close();\""

# LLM batch rate (should not spike dramatically)
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite',{readonly:true}); const r=db.prepare('SELECT COUNT(*) as n FROM llm_usage_events WHERE created_at_ms>?').get(Date.now()-172800000); console.log('LLM calls last 48h:', r.n); db.close();\""
```

Success criteria:
- Alt gate pass rate 1-10% of no-fee-claim tokens (not 0%, not 80%)
- No spike in LLM batch rate
- No crash loops

### 2. Wire recurring runner wallet as score boost

**Not started.** Requires code changes.

Design:
1. Create `recurring_runner_wallets` table in `charon.sqlite`
2. Write `scripts/update_recurring_wallets.js` — reads
   `reports/shadow-runner-analysis/SHADOW-RPT-1-*/wallet_recurrence.json`,
   upserts into table
3. Add `lookupRecurringRunnerWallets()` in `candidateBuilder.js`
4. Add recurring wallet fields to candidate object
5. Add to LLM payload in `src/pipeline/llm.js`

RPT-1 data available at:
`reports/shadow-runner-analysis/SHADOW-RPT-1-2026-05-21T15-29-25Z/wallet_recurrence.json`

Top recurring wallets (from RPT-1):
- `DrnuP46q...` — 30 runner mints, 18 3x+, 10 5x+
- `8FiuwM6F...` — 13 runner mints, 6 3x+, 4 5x+
- `6aXFYXbF...` — 13 runner mints, 8 3x+, 3 5x+

### 3. fee_graduated_trending route — re-evaluate after 2 weeks

Check at 2026-06-04 or later. Query:

```bash
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite',{readonly:true}); const r=db.prepare(\\\"SELECT COUNT(*) as n, SUM(CASE WHEN pnl_pct>0 THEN 1 ELSE 0 END) as wins FROM positions WHERE route='fee_graduated_trending' AND closed_at_ms>?\\\").get(Date.now()-1209600000); console.log(JSON.stringify(r)); db.close();\""
```

If still 0% win rate with 10+ trades: remap route in
`src/signals/serverClient.js:41` from `fee_graduated_trending` to
`fee_trending`.

### 4. Tier A wallet gate cleanup (low priority)

After OKX enrichment completes (~2026-05-31):
- Add coverage notes to `src/analysis/filterEval.js` recipes that require
  `candidate_tier_a_wallet_count >= 1` — these are offline analysis only,
  not live pipeline.
- Recipes affected: `broad_recall_plus_tier_a_wallet`,
  `dual_source_plus_tier_a_wallet`, `dual_source_plus_wallet_quality_high`

### 5. OKX enrichment — monitor progress

Check every few days:

```bash
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/harvester.db',{readonly:true}); const r=db.prepare('SELECT COUNT(*) as n FROM wallet_profiles WHERE okx_snapshot_at IS NOT NULL').get(); const t=db.prepare('SELECT COUNT(*) as n FROM wallet_profiles').get(); console.log('okx_enriched:', r.n, '/', t.n); db.close();\""
```

Expected: ~300 new wallets enriched per day. Full enrichment by ~2026-05-31.

---

## What Not To Do Next

- Do not re-run RPT-1 until at least 2 weeks of new shadow data accumulates
- Do not apply config changes based on RPT-1 findings without a new INT-1
  consultation
- Do not enable InsightX
- Do not revert the alt gate fix
- Do not change OKX rate limits — current pacing (1200ms) is correct for
  trial tier (1 RPS max)
- Do not run AUTO-2 — automation is healthy
- Do not treat pre-2026-05-21 live trade data as signal — all live config
  changed today

---

## Useful Diagnostic Commands

```bash
# Live bot health
ssh moonbags "pm2 list"

# Alt gate activity (last 1h)
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite',{readonly:true}); const r=db.prepare('SELECT action,reason_code,COUNT(*) as n FROM screening_events WHERE at_ms>? AND has_fee_claim=0 GROUP BY action,reason_code ORDER BY n DESC').all(Date.now()-3600000); r.forEach(x=>console.log(x.action,x.reason_code,x.n)); db.close();\""

# OHLCV rejections (last 24h)
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite',{readonly:true}); const r=db.prepare(\\\"SELECT COUNT(*) as n FROM decision_logs WHERE action='entry_rejected_ohlcv' AND at_ms>?\\\").get(Date.now()-86400000); console.log('ohlcv_rejections_24h:', r.n); db.close();\""

# OKX enrichment progress
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/harvester.db',{readonly:true}); const r=db.prepare('SELECT COUNT(*) as n FROM wallet_profiles WHERE okx_snapshot_at IS NOT NULL').get(); const t=db.prepare('SELECT COUNT(*) as n FROM wallet_profiles').get(); console.log('okx_enriched:', r.n, '/', t.n); db.close();\""

# Last auto-sync OKX result
ssh moonbags "grep 'okx_stored' /opt/trading-data/logs/auto-sync.log | tail -3"

# Recent live decisions
ssh moonbags "cd ~/charon && node -e \"const db=require('./node_modules/better-sqlite3')('/opt/trading-data/charon.sqlite',{readonly:true}); const r=db.prepare('SELECT at_ms,action,selected_mint FROM decision_logs WHERE at_ms>? ORDER BY at_ms DESC LIMIT 10').all(Date.now()-3600000); r.forEach(x=>console.log(new Date(x.at_ms).toISOString(),x.action,x.selected_mint||'')); db.close();\""
```
