# WP-M7-3 — Filter Observability: Age, Early Skips, Rug Ratio, And Bundler Rate

Created: 2026-05-14
Audience: Architect agent orchestrating Charon + Charon Intelligence development
Primary repo: `.`
Consultation repo: `../charon-intelligence`

## Objective

Make Charon's entry filters auditable and replayable from live evidence, especially:

- `token_age_max_ms` / Telegram `Age`
- early skips before candidate construction
- `trending_max_rug_ratio` / Telegram `Max Rug`
- `trending_max_bundler_rate` / Telegram `Max Bundler`

Current operator questions like "how many candidates would I lose if Age = 10m?" or
"is Max Rug 20 doing anything?" cannot be answered exactly from the current DB snapshot.
This milestone should fix that measurement gap without changing trading behavior.

## Safety Posture

This is an observability-only milestone.

Do not:
- run live trading, swaps, signing, Telegram sends, Charon startup/restart, PM2 changes, or runtime checks without explicit owner approval.
- read, print, copy, validate, or modify `.env`, private keys, provider keys, Telegram session contents, wallet keys, or raw secrets.
- mutate the live Charon SQLite database directly.
- auto-apply config changes.

Allowed:
- source-code inspection.
- local code edits.
- safe local syntax/tests that do not require secrets.
- Charon Intelligence snapshot inspection through approved read-only scripts.
- read-only SQLite access to Charon Intelligence snapshots when the owner approves the query plan.

## Read First

In `charon`:
- `AGENTS.md`
- `src/signals/serverClient.js`
- `src/signals/trending.js`
- `src/signals/axiomSource.js`
- `src/enrichment/jupiter.js`
- `src/enrichment/gmgn.js`
- `src/pipeline/candidateBuilder.js`
- `src/db/connection.js`
- `src/db/candidates.js`
- `src/db/decisions.js`
- `src/telegram/menus.js`
- `src/telegram/commands.js`
- `tickets/ARCHITECT_HANDOFF_WP-M7_LLM_TELEMETRY_AND_ANALYSIS.md`

In `charon-intelligence`:
- `AGENTS.md`
- `.ai/specs/CHARON_INTELLIGENCE_PRODUCT_SPEC.md`
- `scripts/analyze_filters.py`
- `scripts/run_full_pipeline.sh`
- `reports/latest_filter_analysis.md`
- `reports/latest_filter_analysis.json`
- `data/vps-snapshots/latest/charon.sqlite`

## Evidence Behind This Ticket

Latest analyzed snapshot:

- Snapshot: `20260514T082229Z`
- Live cohort starts at position `13`
- Live start: `2026-05-13T16:39:17Z`
- Candidate rows since live start: `266`
- Candidate statuses:
  - `buy`: `6`
  - `watch`: `91`
  - `candidate`: `1`
  - `filtered`: `168`

Manual read-only replay found:

- Candidate rows do not persist the exact `signal.ageMs` used by `src/signals/serverClient.js`.
- Signals skipped by source count, fee requirement, or token age never become candidate rows.
- Candidate snapshots since position `13` had:
  - `trending.rug_ratio` present: `0`
  - `trending.bundler_rate` present: `0`
- Trending signal events since position `13` had:
  - `jupiter_trending`: `9630` events, `0` with `rug_ratio`, `0` with `bundler_rate`
  - `axiom_trending`: `9381` events, `0` with `rug_ratio`, `0` with `bundler_rate`
- Current `settings` in the snapshot:
  - `trending_source = jupiter`
  - `trending_interval = 5m`
  - `trending_limit = 100`
  - `trending_max_rug_ratio = 0.3`
  - `trending_max_bundler_rate = 0.5`

Practical implication:

- `Age 10m` cannot be replayed exactly from candidates because the exact signal age is missing.
- `Max Rug` and `Max Bundler` are wired settings, but currently data-missing in the evidence stream, so changing them has no measurable effect unless the provider fields are populated.

## Current Runtime Behavior

### Early Signal Gates

`src/signals/serverClient.js` applies these before full candidate construction:

- `sourceCount < strat.min_source_count`
- `strat.require_fee_claim && !hasFee`
- `signal.ageMs > strat.token_age_max_ms`

If any of these fail, no candidate row is built. That means Charon Intelligence cannot count those losses from `candidates`.

### Candidate Filters

`src/pipeline/candidateBuilder.js` filters built candidates using:

- market cap min/max
- fee claim SOL
- GMGN total fees
- graduated volume
- holder count
- top holder concentration
- saved-wallet holder count
- ATH distance
- trending volume/swaps
- trending rug ratio
- trending bundler rate
- wash-trading flag

These are partially replayable today because built candidates have `candidate_json` and `filter_result_json`.

### Trending Risk Fields

`src/signals/trending.js` expects:

- `row.rug_ratio`
- `row.bundler_rate`
- `row.is_wash_trading`

`src/enrichment/jupiter.js` currently maps:

- `row.audit.botHoldersPercentage -> bundler_rate`
- `rug_ratio -> null`

But the latest snapshot did not contain `audit.botHoldersPercentage` in stored `signal_events`.

`src/enrichment/gmgn.js` currently passes through GMGN market rank rows without a Charon-specific rug/bundler mapping. The architect must inspect actual available GMGN fields through safe snapshot/log evidence or bounded non-secret provider-contract review before assigning a normalizer implementation.

## Architecture Recommendation

Do not solve this by making Charon Intelligence guess from pool creation time, partial trending JSON, or PM2 log strings.

Add a compact, normalized **screening event ledger** in Charon. This makes every gate decision measurable while keeping Charon Intelligence read-only and evidence-driven.

### Proposed Data Model

Add a new SQLite table, name flexible but prefer:

```sql
screening_events
```

Suggested fields:

```text
id INTEGER PRIMARY KEY
at_ms INTEGER NOT NULL
mint TEXT NOT NULL
strategy_id TEXT
stage TEXT NOT NULL
action TEXT NOT NULL
reason_code TEXT
reason_text TEXT
signal_key TEXT
candidate_id INTEGER
batch_id INTEGER
execution_mode TEXT
source_count INTEGER
sources_json TEXT
route TEXT
age_ms INTEGER
age_threshold_ms INTEGER
has_fee_claim INTEGER
fee_claim_sol REAL
market_cap_usd REAL
holder_count INTEGER
max_holder_percent REAL
saved_wallet_holders INTEGER
gmgn_total_fee_sol REAL
graduated_volume_usd REAL
trending_source TEXT
trending_volume_usd REAL
trending_swaps INTEGER
trending_rug_ratio REAL
trending_bundler_rate REAL
trending_is_wash_trading INTEGER
provider_fields_json TEXT
config_snapshot_json TEXT
```

Recommended indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_screening_events_at ON screening_events(at_ms);
CREATE INDEX IF NOT EXISTS idx_screening_events_mint_at ON screening_events(mint, at_ms);
CREATE INDEX IF NOT EXISTS idx_screening_events_stage_reason ON screening_events(stage, reason_code, at_ms);
CREATE INDEX IF NOT EXISTS idx_screening_events_candidate ON screening_events(candidate_id);
```

Keep the ledger compact:

- Do not store raw provider responses.
- Do not store prompts.
- Do not store secrets or headers.
- Store only normalized numeric facts and small source/config metadata needed for replay.

### Why This Architecture

This is better than scattering one-off fields because the operator needs two different views:

1. **What happened live?**
   - How many signals were skipped before candidate creation?
   - Which gate skipped them?
   - Which thresholds were active at that moment?

2. **What would happen under a different config?**
   - If `Age = 10m`, how many live signals would be lost?
   - If `Max Mcap = 100k`, how many candidates would be lost?
   - If `Max Rug = 20`, does that actually block anything, or is the data missing?

A screening-event ledger gives Charon Intelligence a stable evidence surface without querying live runtime internals or scraping logs.

## Implementation Slices For Architect

### Ticket A — Screening Event Ledger Schema + Helper

Scope:

- Add `screening_events` table and indexes in `src/db/connection.js`.
- Add helper module, for example `src/db/screeningEvents.js`.
- Helper should expose a small function like:

```js
logScreeningEvent({
  stage,
  action,
  reasonCode,
  reasonText,
  mint,
  strategy,
  signal,
  candidate,
  candidateId,
  batchId,
  configSnapshot,
})
```

Reason-code examples:

```text
source_count_below_min
fee_claim_missing_required
token_age_above_max
candidate_filter_failed
candidate_filter_passed
trending_rug_ratio_above_max
trending_bundler_rate_above_max
trending_wash_trading
llm_watch
llm_buy
llm_pass
execution_guard_failed
```

Acceptance criteria:

- Table initializes on a clean local DB.
- Helper writes compact rows with no raw secrets.
- `node --check` passes on changed JS files.
- No Charon process start/restart.

### Ticket B — Instrument Early Signal Gates

Scope:

- In `src/signals/serverClient.js`, log screening events when signals are skipped by:
  - source count
  - missing fee claim
  - token age
- Persist the exact `signal.ageMs` and threshold used.
- Include source count, source labels, has-fee flag, route/source context where available.
- Also pass `signal.ageMs` into candidate construction so built candidates retain:

```text
candidate_json.signals.ageMs
candidate_json.signals.sourceCount
candidate_json.signals.sources
```

Design note:

- The current `triggerCandidate()` signature does not pass the full signal object.
- Architect should decide whether to pass a small `signalMeta` object instead of the entire raw signal.
- Prefer `signalMeta` to avoid accidental raw payload bloat:

```js
signalMeta: {
  ageMs,
  sourceCount,
  sources,
  hasFeeClaim,
  seenAtMs,
}
```

Acceptance criteria:

- A skipped-age signal creates a `screening_events` row with `age_ms` and `age_threshold_ms`.
- A built candidate includes `candidate_json.signals.ageMs`.
- Charon Intelligence no longer needs a pool-created-time proxy for built candidate age.

### Ticket C — Candidate Filter Event Logging

Scope:

- In `src/pipeline/candidateBuilder.js`, after `filterCandidate()`, write one compact event per built candidate:
  - `stage = candidate_filter`
  - `action = passed` or `filtered`
  - `reason_code = candidate_filter_passed` or a stable mapped code
  - current normalized filter features
  - current relevant config thresholds

Recommended implementation:

- Keep existing `filter_result_json.failures` for display.
- Add stable machine-readable failure codes, either:
  - alongside existing failure strings, or
  - in the screening event `reason_code` / `provider_fields_json`.

Examples:

```text
min_mcap_usd
max_mcap_usd
min_gmgn_total_fee_sol
min_saved_wallet_holders
min_holders
max_top20_holder_percent
trending_max_rug_ratio
trending_max_bundler_rate
trending_wash_trading
```

Acceptance criteria:

- Charon Intelligence can count filter blockers from stable codes, not brittle string prefixes.
- Existing Telegram candidate summaries remain unchanged unless the architect intentionally includes the stable codes in debug output.

### Ticket D — Trending Risk Field Normalization And Coverage

Scope:

- Audit all current trending sources:
  - `serverClient` signal server `signal.trending`
  - local Jupiter top-trending normalizer
  - GMGN market-rank normalizer
  - Axiom source, if active
- Normalize provider fields into:

```text
trending.rug_ratio
trending.bundler_rate
trending.is_wash_trading
trending.risk_field_availability
```

Recommended normalized metadata:

```json
{
  "rug_ratio": "present|missing|unsupported",
  "bundler_rate": "present|missing|unsupported",
  "is_wash_trading": "present|missing|unsupported",
  "source": "jupiter_toptrending|gmgn_market_rank|axiom_trending|signal_server"
}
```

Jupiter:

- Keep mapping `audit.botHoldersPercentage / 100 -> bundler_rate` when present.
- Set `bundler_rate` to `null` when missing, not `0`.
- Mark field availability as `missing` or `unsupported`.
- Jupiter currently has no direct rug ratio in the normalizer; mark `rug_ratio` as `unsupported` unless a real field is found.

GMGN:

- Inspect available GMGN market-rank/token fields without exposing API keys.
- If GMGN exposes wash/rug/bundler fields, map them explicitly.
- If GMGN only supports filtering `not_wash_trading` at request time, record that as provider-side prefilter metadata rather than pretending Charon has a numeric rug ratio.

Axiom:

- Current source appears to set rug/bundler fields to null.
- If Axiom has hidden/raw risk fields, normalize them. If not, mark unsupported.

Acceptance criteria:

- Missing rug/bundler data is distinguishable from a real `0`.
- Charon Intelligence can report:
  - field present count
  - field missing count
  - field unsupported count
  - reject count by rug/bundler filters
- Lowering `Max Rug` or `Max Bundler` no longer appears to do something when the provider fields are absent.

### Ticket E — Charon Intelligence Replay And Reports

Scope in `charon-intelligence`:

- Extend filter analysis to consume `screening_events` when present.
- Add a filter-observability section:

```text
Early signal skips
- source count
- fee required
- token age

Candidate filter blockers
- mcap min/max
- GMGN fees
- saved-wallet holders
- holder count
- top holder concentration
- trend volume/swaps
- rug ratio
- bundler rate

Data coverage
- age_ms present %
- rug_ratio present/missing/unsupported %
- bundler_rate present/missing/unsupported %
- is_wash_trading present/missing/unsupported %
```

- Add what-if replay for common thresholds:

```text
Age: 10m / 30m / 60m
Max Mcap: 100k / 150k / 200k
Min Holders: 50 / 100 / 200
Max Holder: 30% / 50%
Max Rug: 20% / 30%
Max Bundler: 35% / 50%
GMGN Fees: 6 / 8 / 10 SOL
Saved Wallet Holders: 1 / 2
```

Important:

- Separate exact replay from proxy replay.
- If data is missing, say `not replayable` instead of estimating silently.
- Keep KB/query context supporting only. Primary evidence must come from snapshot DB/reports.

Acceptance criteria:

- The report can answer:
  - "How many candidates/signals would Age 10m remove?"
  - "Is Max Rug active or data-missing?"
  - "Is Max Bundler active or data-missing?"
  - "Which stricter setting costs the most entries?"
- The report labels live/dry-run windows correctly and supports `--live-position-start-id 13`.

## Suggested Architecture Refinements

Architect should consider these improvements before assigning Coder tickets:

1. **Use stable reason codes, not display text**
   - Keep human-readable failure strings for Telegram.
   - Add machine-readable `reason_code` values for reports and replay.

2. **Capture config snapshot at decision time**
   - Store only relevant thresholds, not full environment.
   - This avoids confusion when settings change later.

3. **Use nullable fields for missing risk data**
   - Missing rug/bundler is not the same as `0`.
   - Runtime filters may treat missing as pass, but Intelligence must report it as missing.

4. **Keep raw payloads out of the new ledger**
   - Existing `signal_events` and `candidate_json` already provide detailed context.
   - The new ledger should be small, queryable, and safe.

5. **Do not make Charon Intelligence call providers to fill gaps**
   - Charon Intelligence should analyze captured Charon evidence.
   - Provider enrichment belongs in Charon runtime or a controlled Charon data collection step, not ad hoc analysis.

6. **Add retention or compaction**
   - A signal-level ledger can grow quickly.
   - Add a retention setting or cleanup routine later if needed.
   - Do not block the first implementation on retention unless table growth is already problematic.

## Verification Plan

Charon:

```bash
node --check src/db/connection.js
node --check src/db/screeningEvents.js
node --check src/signals/serverClient.js
node --check src/signals/trending.js
node --check src/enrichment/jupiter.js
node --check src/enrichment/gmgn.js
node --check src/pipeline/candidateBuilder.js
```

If tests exist for the touched modules, run only the relevant safe tests. Do not
start Charon or PM2 without owner approval.

Charon Intelligence:

```bash
python3 -m py_compile scripts/analyze_filters.py
python3 scripts/analyze_filters.py --days 1 --live-position-start-id 13
```

If the first implementation creates synthetic/local DB fixtures, add focused tests
for:

- early age skip event
- missing rug/bundler field coverage
- present rug/bundler field coverage
- exact what-if age replay

## Operator-Facing Outcome

After this milestone, the operator should be able to ask:

```text
If I set Age 10m, how many live signals/candidates do I lose?
If I set Max Rug 20, does it block anything?
If I set Max Bundler 35, does it block anything?
Which filter is reducing entries the most?
Which filter is active but data-missing?
```

and Charon Intelligence should answer with exact counts, rates, timestamps, and
source coverage from the snapshot.

## Recommended Architect Output

Produce bounded Coder tickets in this order:

1. `WP-M7-3A Screening Event Ledger`
2. `WP-M7-3B Early Gate + AgeMs Instrumentation`
3. `WP-M7-3C Stable Candidate Filter Codes`
4. `WP-M7-3D Trending Risk Field Normalization`
5. `CI-M8 Replay And Field-Coverage Reports`

Do not combine all implementation into one Coder task. The schema/helper and
early-gate instrumentation should land first because Intelligence depends on
that evidence surface.
