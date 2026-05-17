# WP-M7: LLM Payload Budget + Candidate Evidence Compaction Plan

**Type:** Planner / Architect
**Status:** Done — plan delivered in `WP-M7-1-HOLDER-SUMMARY-BUDGET.md`
**Created:** 2026-05-13
**Priority:** High

---

## Goal

Design a more elegant LLM payload process for Charon so candidate selection can
scale with many tracked wallets and many eligible candidates without sending a
large raw body to the LLM.

Also design token/cost telemetry so the owner can track how quickly Charon is
spending LLM tokens and plan model/provider usage accordingly.

This is not a coder ticket yet. The next agent should produce a concrete
implementation plan with milestones, config items, verification gates, and
owner-visible tradeoffs.

## Why this matters

The smart-wallet rollout fixed one scaling issue by keeping all saved wallets in
an in-memory cache and sending only matched wallet evidence to the LLM. The
current candidate payload still has a similar scaling problem in another area:
holder data and full candidate context can make the LLM request body too large.

The latest VPS inspection showed:

| Batch | Candidates | Body size | User message | Holder rows | Matched wallets | Result |
|-------|------------|-----------|--------------|-------------|-----------------|--------|
| `llm_batches.id=58` | 8 | ~109 KB | ~103,812 chars | 777 | 23 | timeout at 60s |
| `llm_batches.id=59` | 7 | ~94 KB | ~88,139 chars | 654 | 18 | BUY at 78% |

This confirms Charon is not sending all 908 saved wallets to the LLM, but it is
still sending up to 100 top-holder rows per candidate. If candidate count grows,
the request body grows linearly and may keep causing slow or failed LLM calls.

There is a second operational concern: Charon may consume LLM/API tokens quickly
when candidate volume is high. The system currently records LLM decisions and
batch metadata, but it does not provide a clear owner-facing token/cost ledger.
The planner must include metering as part of the payload design.

## Current confirmed code path

Read these first:

| File | Why |
|------|-----|
| `src/pipeline/llm.js` | Builds the LLM system/user prompt and compact candidate payload |
| `src/db/candidates.js` | Selects recent eligible candidates for LLM review |
| `src/enrichment/wallets.js` | Smart-wallet cache and compact wallet evidence pattern |
| `src/db/decisions.js` | Stores LLM decisions and batch metadata |
| `src/db/connection.js` | Runtime settings defaults, including `llm_timeout_ms` |
| `src/telegram/menus.js` / `src/telegram/commands.js` | Runtime settings UX patterns |

Important current behavior:

- `decideCandidateBatch()` sends one chat-completion request with up to
  `llm_candidate_pick_count` candidates.
- `compactCandidateForLlm()` includes holder summary plus
  `holders.top_holders`, currently capped at 100 rows per candidate.
- Saved-wallet evidence is already compacted: scalar counts, summary, and only
  top matched wallets.
- `llm_timeout_ms` is now a DB-backed runtime setting; env is fallback only.
- Exact outbound LLM payloads are not persisted today. Only LLM decisions and
  batch metadata are stored.
- LLM token usage is not currently tracked in a dedicated usage ledger.

## Planning Questions

The planner should answer these before implementation:

1. What information does the LLM actually need to choose a buy?
2. Which candidate facts should be pre-scored locally instead of sent raw?
3. What holder-derived signals should replace raw top-holder rows?
4. Should Charon use a two-stage process:
   - local deterministic pre-rank / summarize candidates
   - LLM only reviews the final compact shortlist
5. What should be configurable at runtime versus hardcoded?
6. What payload size budget should Charon enforce before calling the LLM?
7. What should happen when the compact payload still exceeds budget?
8. What audit artifact should prove the LLM saw enough evidence without storing
   huge raw prompts forever?
9. How should Charon log LLM token usage, request count, latency, and estimated
   cost without storing secrets or huge prompt bodies?
10. What owner-facing command/report should show daily LLM usage and cost trend?

## Design Requirements

The planned solution should keep these properties:

- Do not send raw large holder arrays by default.
- Keep smart-wallet evidence prominent and compact.
- Preserve enough holder information for risk detection:
  - concentration
  - top holder dominance
  - suspicious clustering if available
  - dev/bundler/rug hints if available
  - smart-wallet overlap
- Keep candidate filtering deterministic before the LLM where possible.
- Keep Telegram/runtime settings ergonomic.
- Avoid needing more Jupiter calls or any additional API hammering.
- Avoid storing giant prompt bodies in SQLite by default.
- Include a small sampled/debug mode for inspecting payloads when needed.
- Keep default behavior safe for a growing wallet universe and higher candidate
  counts.
- Add LLM usage telemetry that is compact, queryable, and safe to inspect.
- Track both provider-reported token usage when available and local estimates
  when the provider response does not include usage.
- Track enough metadata to identify expensive paths:
  - feature/caller, such as candidate batch or learning summary
  - model
  - candidate count
  - payload bytes
  - prompt/completion/total tokens if available
  - estimated cost if pricing is configured
  - latency
  - success, timeout, or error class

## Candidate Architecture Options To Evaluate

The planner should compare at least these options and choose one:

### Option A: Configurable Hard Cap

Add settings such as:

- `llm_max_candidates`
- `llm_max_holder_rows_per_candidate`
- `llm_payload_budget_bytes`
- `llm_payload_debug_sample`

This is fast to implement but may still be crude if raw holder rows are not the
right evidence.

### Option B: Holder Signal Summary

Replace most raw holder rows with a compact holder-risk object, for example:

```json
{
  "holderRisk": {
    "top20Percent": 41.2,
    "maxHolderPercent": 8.5,
    "holderRowsSampled": 100,
    "largeHolderCount": 6,
    "smartWalletHolderCount": 4,
    "kolHolderCount": 1,
    "freshWalletClusterHint": "unknown",
    "concentrationRisk": "medium",
    "notes": ["top20_under_50", "smart_wallet_overlap"]
  }
}
```

The LLM receives a summary plus a very small evidence sample, not all top-holder
rows.

### Option C: Two-Stage Candidate Triage

Stage 1 runs local scoring over all recent eligible candidates and produces a
small shortlist. Stage 2 sends only the shortlist to the LLM.

Example local score dimensions:

- saved-wallet holder count and tier quality
- market cap window
- source count
- fee claim / GMGN quality
- top-holder concentration
- distance from ATH
- KOL dump risk
- Twitter/narrative signal presence

### Option D: Evidence Ledger + Pointer Prompt

Store richer local evidence in a compact decision/evidence table, but send only
summaries and stable evidence IDs to the LLM. This improves auditability without
large prompt bodies.

### Option E: LLM Usage Ledger

Add a compact usage table for every LLM request attempt. This should be evaluated
as a required companion to any payload-budget solution.

Potential schema:

```sql
CREATE TABLE llm_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at_ms INTEGER NOT NULL,
  feature TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  error_class TEXT,
  latency_ms INTEGER,
  request_bytes INTEGER,
  candidate_count INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  estimated_cost_usd REAL,
  batch_id INTEGER,
  metadata_json TEXT
);
```

Planning notes:

- Prefer provider `usage` fields when present.
- If provider usage is absent, estimate tokens from request/response text with a
  documented rough ratio or a tokenizer if already available.
- Do not store authorization headers, API keys, raw `.env`, or full giant
  prompts in this table.
- Cost estimation should be configurable because model pricing can change:
  `llm_input_cost_per_1m_tokens`, `llm_output_cost_per_1m_tokens`, and possibly
  `llm_cost_tracking_enabled`.
- The owner should be able to view recent usage without SQLite tooling, ideally
  through a Telegram command such as `/llmusage 24h` or an Agent menu item.

## Expected Planner Output

Produce a plan document or ticket set with:

1. Recommended architecture and why.
2. Exact settings to add, with defaults.
3. Data structures for compact holder/candidate evidence.
4. What to persist in decision logs for auditability.
5. Token/cost usage telemetry design, including schema and owner-facing report.
6. Migration/backward compatibility needs.
7. Coder tickets split into small safe milestones.
8. Verification gates:
   - static checks
   - payload-size replay from recent VPS batches
   - token/cost replay or synthetic accounting check
   - no-regression check that smart-wallet evidence is still present
   - timeout/error-rate monitoring after deployment
9. Rollback plan.

## Suggested Acceptance Criteria For The Future Implementation

The eventual implementation should meet these measurable criteria:

- Default LLM request body stays below a chosen budget, suggested starting point:
  `<= 35 KB`.
- LLM candidate request sends no more than a configured small holder sample,
  suggested starting point: `<= 15 holder rows total`, not per candidate.
- Smart-wallet matched evidence remains present for every candidate with
  `savedWalletExposure.holderCount > 0`.
- Payload budget and holder sample caps are runtime-configurable.
- If payload exceeds budget, Charon deterministically reduces or drops lowest
  priority evidence before calling the LLM.
- If the payload still exceeds budget, Charon skips the LLM with a clear logged
  reason instead of timing out blindly.
- A replay script can estimate payload size from recent `llm_batches` /
  `candidates` without making an LLM call.
- Every LLM request attempt writes one compact usage row, including failed and
  timeout attempts.
- Usage reporting can answer at minimum:
  - requests in the last 1h / 24h
  - total prompt, completion, and total tokens when available
  - estimated cost when pricing settings are configured
  - timeout/error count
  - average and max latency
  - top expensive feature path
- Token/cost logging must not require reading `.env` or printing secrets.

## What Not To Do In Planning

- Do not implement code in this planner pass.
- Do not read `.env`, secrets, Telegram tokens, wallet/private keys, or raw
  secret-bearing logs.
- Do not run live trading, confirm trading, wallet signing, swaps, or Telegram
  command flows.
- Do not assume raising timeout is the real fix. Timeout is a safety valve; the
  payload needs a budgeted design.
- Do not remove smart-wallet logic or reduce the wallet universe as the primary
  solution.

## Owner-Visible Summary

The desired outcome is the same as the smart-wallet cache improvement: Charon
should keep rich local evidence, but send the LLM only a compact, budgeted
decision packet. The LLM should see the strongest reasons to buy or pass without
being asked to parse hundreds of holder rows every cycle.
