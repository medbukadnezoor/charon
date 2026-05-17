# Architect Handoff — WP-M7 LLM Telemetry, Cost Tracking, And Live Analysis Hygiene

Created: 2026-05-14
Audience: Architect agent orchestrating Charon development
Primary repo: `.`
Consultation repo: `../charon-intelligence`

## Objective

Orchestrate the next bounded development milestone around Charon LLM usage telemetry and cost visibility, while preserving the current safety posture. The owner wants to know how often the LLM is called, how many tokens are burned, and what the live cost trend is. Current Charon can count LLM batches and payload bytes, but it does not yet persist provider token usage or cost.

## Read First

In `charon`:
- `AGENTS.md`
- `tickets/WP-M7-LLM-PAYLOAD-BUDGET-PLANNER.md`
- `tickets/WP-M7-1-HOLDER-SUMMARY-BUDGET.md`
- `tickets/WP-M7-2-LLM-USAGE-TELEMETRY.md`
- `src/pipeline/llm.js`
- `src/db/connection.js`
- `src/db/decisions.js`
- `src/telegram/commands.js`
- `src/telegram/callbacks.js`
- `src/db/settings.js`

In `charon-intelligence`:
- `AGENTS.md`
- `.ai/specs/CHARON_INTELLIGENCE_PRODUCT_SPEC.md`
- `reports/latest_trade_analysis.md`
- `reports/latest_llm_audit.md`
- `reports/latest_filter_analysis.md`

## Confirmed Current State

Live Charon evidence was refreshed through Charon Intelligence on 2026-05-14 using snapshot `20260514T082229Z`. The owner clarified that positions `1-12` are dry-run history and positions `13+` are live. A local analysis adjustment was made in `charon-intelligence` so reports can be rerun with:

```bash
bash scripts/run_full_pipeline.sh --days 1 --skip-sync --skip-telegram --live-position-start-id 13
```

Corrected live-only results from that snapshot:
- Live cohort starts at position `13`, opened `2026-05-13T16:39:17Z` / `2026-05-13 23:39:17 WIB`.
- Positions `1-12` excluded as dry-run history.
- Live trades counted: `2`.
- Live win rate: `0W / 2L`.
- Live PnL: `-0.0364 SOL`.
- LLM batches since live start: `224`.
- Average LLM batch cadence from live start to snapshot: about `14.25 batches/hour`, or one batch every `4.2 minutes`.

Current LLM call path in Charon:
- `src/app.js` polls server signals every `SIGNAL_POLL_MS` (default `30s`).
- `src/signals/serverClient.js` gates source count, fee requirement, and token age before triggering candidates.
- `src/pipeline/orchestrator.js` builds/enriches candidates, filters them, then calls `decideCandidateBatch()` only when the active strategy has `use_llm: true`.
- `src/pipeline/llm.js` sends one OpenAI-compatible `/chat/completions` call per eligible LLM batch.
- LLM is used for entry selection only. It is not used for TP/SL/trailing exits or position monitoring.

Current telemetry:
- `llm_batches` records batch-level verdict, confidence, selected candidate, raw decision JSON, candidate IDs, `payload_size_bytes`, `candidate_count`, `conclusion_count`, `critical_count`, trim stages, and RPC enrichment flag.
- There is no `llm_usage_events` table yet.
- Provider response `usage` fields are not captured.
- Prompt/completion/total token counts are not stored.
- Cost is not stored.

## Main Milestone To Orchestrate

### WP-M7-2 — LLM Usage Telemetry + Cost Tracking

Use the existing ticket as the implementation contract: `tickets/WP-M7-2-LLM-USAGE-TELEMETRY.md`.

Architect should break this into small Coder tickets:

1. **Usage Ledger Schema**
   - Add `llm_usage_events` table.
   - Add defaults for `llm_cost_tracking_enabled`, `llm_input_cost_per_1m_tokens`, and `llm_output_cost_per_1m_tokens`.
   - Keep this local SQLite only. No remote writes, no `.env` reads.

2. **LLM Call Instrumentation**
   - In `src/pipeline/llm.js`, log one event for every attempted batch outcome:
     - `success`
     - `timeout`
     - `error`
     - `budget_skipped`
     - disabled / missing-key fallback, if desired as non-provider attempt
   - Capture latency, request bytes, candidate count, model, batch ID when available, token usage when provider returns it.
   - If provider usage is absent, estimate tokens by documented rough ratio, likely `ceil(bytes / 4)` for prompt and response bytes for completion.
   - Do not store raw prompt or raw provider response in the usage table.

3. **Usage Summary API / Helper**
   - Add a summary function that aggregates over windows like `30m`, `1h`, `24h`, `7d`.
   - Report request counts, success/error/timeout counts, prompt tokens, completion tokens, total tokens, estimated cost, average/max latency, and total request bytes.

4. **Telegram `/llmusage` Command**
   - Add owner-facing report command with default `24h`.
   - Keep output compact and operational: request count, tokens, estimated cost, error rate, latency, avg cadence.
   - Do not print model secrets or raw payloads.

5. **Settings Wiring**
   - Add M7 settings to allowed runtime-setting command paths if the current command system requires whitelisting.
   - Avoid broad config refactors.

6. **Verification**
   - `node --check` on changed JS files.
   - Existing relevant tests, if available.
   - A safe local smoke using `CHARON_SKIP_DOTENV=true` where possible.
   - No live runtime, no PM2, no trading, no Telegram send unless explicitly owner-approved.

## Related Important Follow-Ups

### Charon Intelligence live/dry-run cohort support

A local analysis improvement was made in `charon-intelligence` to support `--live-position-start-id 13` for `analyze_trades.py`, `analyze_filters.py`, `analyze_llm_decisions.py`, and `run_full_pipeline.sh`. Architect should decide whether to formalize this as a ticket in `charon-intelligence`:
- Add tests for live cohort cutoff.
- Thread the cutoff into consult packet metadata and config recommendations if needed.
- Consider a config/source-map field or CLI arg instead of ad hoc operator memory.

### Charon Intelligence filter attribution bug

After live cutoff, `reports/latest_filter_analysis.md` showed:
- `266` live-window candidates.
- `168` filtered/rejected.
- Every named filter still reported `0` rejects.

PM2 logs clearly showed filter reasons such as saved wallet holders, market cap max, GMGN total fees, and market cap min. This implies a parser/mapping mismatch between `filter_result_json.failures` strings and the report’s `FILTER_FIELDS` keys. This is not a Charon runtime bug; it is an intelligence/reporting bug. Architect should ticket this separately before using filter opportunity-cost recommendations.

Suggested ticket:
- Inspect sanitized `filter_result_json` structure from the snapshot through approved read-only Charon Intelligence scripts.
- Map failure strings like `market cap min`, `market cap max`, `GMGN total fees`, and `saved wallet holders` to filter keys.
- Add a report section for unmapped failure strings.
- Do not run arbitrary SQLite queries unless owner approves the exact query plan first.

### Next milestone: signal-age and early-skip telemetry

The owner asked whether `signal.ageMs` should be stored so Charon Intelligence can
replay `Age 10m / 30m / 60m` changes accurately. It should be included in the
next telemetry milestone.

Current issue:
- `src/signals/serverClient.js` applies `token_age_max_ms` before a full
  candidate row is built.
- The exact `signal.ageMs` value used for that gate is not persisted in
  `candidate_json`.
- Signals skipped by source count, fee requirement, or token age never become
  candidates, so Charon Intelligence cannot reconstruct their loss counts from
  `candidates` alone.

Recommended scope:
- Persist `signal.ageMs` and signal source metadata on every built candidate,
  preferably under `candidate_json.signals.ageMs`.
- Add an early-skip telemetry table or event stream for pre-candidate skips:
  source count, missing fee claim, and token age.
- Store only operational metadata: mint, timestamp, source count, route/source
  labels, ageMs, threshold, skip reason. Do not store secrets or raw provider
  credentials.
- Update Charon Intelligence to report age-filter attribution and what-if replay
  for common thresholds.

Acceptance criteria:
- Charon Intelligence can answer "how many candidates would Age 10m remove?"
  without using pool-created-time proxies.
- Reports separate "built candidates filtered later" from "signals skipped before
  candidate construction."

## Safety Boundaries

Do not:
- run live trading, swaps, signing, Telegram sends, Charon startup/restart, PM2 process changes, or direct runtime checks without explicit owner approval.
- read or print `.env`, private keys, API keys, Telegram session contents, provider keys, wallet keys, raw secrets, or broad runtime logs.
- mutate Charon SQLite directly.
- install dependencies unless a bounded ticket explicitly requires it and owner approves.

Allowed for this milestone:
- source-code inspection.
- local code edits in `charon` for telemetry.
- safe syntax/tests that do not require secrets or live services.
- Charon Intelligence snapshot/report inspection through approved scripts.

## Dirty Worktree Warning

The `charon` worktree is already dirty with many modified and untracked files. Assume these are owner or prior-agent changes. Do not revert them. Before assigning Coder work, have Coder run `git status --short` and inspect any files they plan to edit.

Known relevant dirty areas include:
- `src/pipeline/llm.js`
- `src/db/connection.js`
- `src/db/decisions.js`
- `src/telegram/commands.js`
- `src/telegram/callbacks.js`
- `src/db/settings.js`
- docs/tickets/reports directories

## Suggested Architect Output

Architect should produce one bounded implementation ticket first:

**Ticket A: WP-M7-2A Usage Ledger + LLM Instrumentation**
- Scope: schema, `src/db/usage.js`, instrumentation in `src/pipeline/llm.js`.
- Exclude Telegram command for first slice unless small enough after inspection.
- Verification: syntax checks and a safe unit/smoke test with no provider call.

Then follow with:

**Ticket B: WP-M7-2B `/llmusage` Operator Report**
- Scope: Telegram command/report wiring and settings allowlist.
- Verification: command-format test or safe helper test, no live Telegram send.

Then:

**Ticket C: Charon Intelligence Filter Attribution Repair**
- Scope: report parser/mapping, unmapped reason accounting, tests.
- Verification: rerun Charon Intelligence report against latest snapshot and confirm nonzero mapped reject counts.

## Owner-Checkable Evidence

After Ticket A:
- `llm_usage_events` exists in local initialized DB.
- A mocked successful LLM call logs token or estimated token fields.
- A mocked timeout/error logs a row without raw prompt or secret content.

After Ticket B:
- `/llmusage 24h` can summarize counts, tokens, estimated cost, latency, and error rate from ledger data.

After Ticket C:
- `reports/latest_filter_analysis.md` no longer says all filters are inactive when `total_filtered` is nonzero.

## Current Recommendation

Do not make config changes from the current live sample. The live sample is only two trades. Prioritize telemetry and measurement integrity first, then revisit strategy changes after live token/cost telemetry and corrected filter attribution are available.
