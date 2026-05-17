# WP-M7-2A: Usage Ledger + LLM Instrumentation

**Role:** Coder
**Parent handoff:** `tickets/ARCHITECT_HANDOFF_WP-M7_LLM_TELEMETRY_AND_ANALYSIS.md`
**Parent ticket:** `tickets/WP-M7-2-LLM-USAGE-TELEMETRY.md`
**Status:** Open
**Created:** 2026-05-14
**Priority:** High

## Goal

Add the first bounded telemetry slice for Charon LLM usage: a local SQLite usage
ledger plus instrumentation in the candidate-batch LLM call path. This gives the
owner durable evidence for how many LLM requests are attempted, their token burn,
their latency, and whether they succeeded, timed out, errored, or were skipped by
payload budget.

## Scope

Implement only:

- `llm_usage_events` schema in local SQLite initialization.
- Default settings for opt-in cost tracking:
  - `llm_cost_tracking_enabled`
  - `llm_input_cost_per_1m_tokens`
  - `llm_output_cost_per_1m_tokens`
- New local helper module, expected path `src/db/usage.js`.
- Instrumentation inside `src/pipeline/llm.js` for:
  - `success`
  - `timeout`
  - `error`
  - `budget_skipped`
  - optional disabled or missing-key fallback only if it stays tiny and does not
    imply provider usage.
- A focused safe test or smoke proving the schema and helper work without a
  provider call.

## Out Of Scope

Do not implement in this ticket:

- Telegram `/llmusage`.
- `/setfilter` or operator setting command wiring.
- Charon Intelligence report changes.
- Strategy/config tuning from current live sample.
- Any VPS, PM2, service, bot startup, Telegram send, dry-run execution, live
  trading, swap, signing, or runtime check.
- Any `.env`, key, wallet, Telegram token, provider key, runtime log, or broad
  SQLite runtime-state read.
- Dependency installation.

## Required Behavior

1. `initDb()` creates `llm_usage_events` if missing.
2. Every logged row stores only telemetry fields, not raw prompt text, provider
   raw response, auth headers, keys, or wallet/private secret material.
3. Successful provider calls use `res.data.usage.prompt_tokens`,
   `completion_tokens`, and `total_tokens` when present.
4. When provider usage is absent, prompt and completion tokens are estimated with
   a documented rough `ceil(bytes / 4)` ratio.
5. Timeout and error outcomes write a ledger row with status and error class, but
   without raw prompt/provider response content.
6. Budget-skipped batches write a row with request bytes and candidate count
   before returning the existing WATCH fallback.
7. Cost remains opt-in. When disabled or price settings are zero, cost should be
   `NULL` or otherwise clearly not estimated as spend.

## Suggested Implementation Notes

- Reuse `now()` and `json()` from `src/utils.js`.
- Reuse `numSetting()` and `boolSetting()` from `src/db/settings.js`.
- Keep ledger inserts best-effort only if needed to avoid breaking the LLM
  fallback path, but surface local test failures normally.
- Prefer a small exported helper such as `logUsageEvent()` and, if cheap,
  token/cost helper functions that are simple to test.
- Keep candidate-batch instrumentation close to the existing budget enforcement
  and `axios.post()` call in `src/pipeline/llm.js`.

## Required Checks

Run, at minimum:

- `node --check src/db/connection.js`
- `node --check src/db/usage.js`
- `node --check src/pipeline/llm.js`
- The focused safe test or smoke added for this ticket with
  `CHARON_SKIP_DOTENV=true` and a temporary local DB path.

If an existing broader test suite is safe and does not call providers or runtime
services, run it too.

## Owner-Checkable Evidence

Coder must report:

- The files changed.
- The exact checks run and their results.
- Evidence that `llm_usage_events` exists in a local initialized DB.
- Evidence that a local helper write can persist a row with token/cost fields.
- Confirmation that no `.env`, provider call, PM2, Telegram send, trading,
  signing, or live runtime action was used.

## Verifier Focus

Verifier should check:

- The diff stays within this ticket and does not include `/llmusage` or runtime
  command wiring.
- The ledger does not store raw prompt, raw provider response, auth header, or
  secret content.
- Success, timeout/error, and budget-skip paths are all covered or honestly
  caveated.
- The evidence proves the owner can later inspect LLM request counts, tokens,
  latency, and optional estimated cost from local ledger rows.
