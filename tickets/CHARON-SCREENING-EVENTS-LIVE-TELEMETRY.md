TICKET_ID:
CHARON-SCREENING-EVENTS-LIVE-TELEMETRY

END_GOAL_LINK:
Charon strategy review must be based on complete live evidence, including candidates that are rejected before LLM and signals that never become candidates.

GOAL:
Implement and deploy the missing runtime screening telemetry so the live Charon bot writes compact rows to `screening_events` for early signal gates and candidate filter outcomes.

WHY_NOW:
The latest Charon Intelligence refresh showed `screening_events` has `0` rows while the same VPS snapshot has active data in `candidates`, `decision_logs`, `llm_batches`, and `signal_events`. This means Charon Intelligence can reconstruct candidate filter blockers only from `candidates.filter_result_json`, but cannot accurately measure pre-candidate losses such as source count, missing fee claim, or token age. The operator is trying to increase entries without losing quality, so missing blocker telemetry directly weakens config decisions.

OWNER_VISIBLE_OUTCOME:
After the patch is deployed and Charon runs for a short live observation window, the next Charon Intelligence snapshot should show non-zero `screening_events` rows with clear counts by:
- `stage = early_signal_gate`
- `stage = candidate_filter`
- `reason_code`, such as `source_count_below_min`, `fee_claim_missing_required`, `token_age_above_max`, `candidate_filter_passed`, and specific candidate filter failures.

OWNER_PROOF:
The owner can verify this without reading code by running a Charon Intelligence refresh and checking that:
- `screening_events` row count is greater than `0`.
- rows have recent timestamps after the deployed restart.
- `reports/latest_filter_analysis.*` can use the new ledger or at minimum expose that the ledger is populated.
- early skips are visible separately from built candidate rejects.

OWNER_CHECK_STEPS:
1. Refresh Charon Intelligence:
   `cd "../charon-intelligence" && bash scripts/run_full_pipeline.sh --days 1`
2. Read-only check against the refreshed snapshot:
   `sqlite3 -readonly -cmd '.timeout 5000' "data/vps-snapshots/latest/charon.sqlite" "select stage, action, reason_code, count(*) from screening_events where at_ms >= (strftime('%s','now')-86400)*1000 group by stage, action, reason_code order by count(*) desc limit 30;"`
3. Confirm there are recent rows:
   `sqlite3 -readonly -cmd '.timeout 5000' "data/vps-snapshots/latest/charon.sqlite" "select count(*), datetime(min(at_ms)/1000,'unixepoch'), datetime(max(at_ms)/1000,'unixepoch') from screening_events;"`

FILES_IN_SCOPE:
- `./src/db/connection.js`
- `./src/db/screeningEvents.js`
- `./src/signals/serverClient.js`
- `./src/pipeline/candidateBuilder.js`
- `./tests/screening-events.test.js`
- `./scripts/*` only if a read-only smoke check helper is needed
- `../charon-intelligence/scripts/analyze_filters.py` only if needed to consume the populated ledger in reports
- `../charon-intelligence/reports/*` generated outputs only

ACCEPTANCE_CRITERIA:
- Charon creates `screening_events` with compact normalized fields and useful indexes.
- Early signal gates write rows before `continue` for:
  - source count below active strategy minimum
  - fee claim missing when active strategy requires it
  - token age above active strategy maximum
- Candidate filtering writes one row for every built candidate after `filterCandidate` runs:
  - `action = passed` when filters pass
  - `action = filtered` when filters fail
  - `reason_code` is machine-readable and not only prose
  - `reason_text` preserves the concise human-readable failures
- The telemetry does not change trading decisions, filter behavior, LLM behavior, swaps, sizing, or Telegram commands.
- The telemetry stores only compact normalized facts; it must not store secrets, raw provider headers, raw `.env`, private keys, Telegram session contents, prompts, or full provider blobs.
- The deployed VPS bot is confirmed to be running the commit that contains the writer code, not only a DB schema with an empty table.
- After deployment and a bounded observation window, a fresh Charon Intelligence snapshot shows non-zero `screening_events` rows.
- If Charon Intelligence is updated in this ticket, `latest_filter_analysis` should distinguish:
  - early pre-candidate skips
  - candidate filter rejects
  - LLM PASS/WATCH/BUY outcomes

REQUIRED_CHECKS:
- `node --check src/db/screeningEvents.js`
- `node --check src/signals/serverClient.js`
- `node --check src/pipeline/candidateBuilder.js`
- `node --check src/db/connection.js`
- Run the targeted screening telemetry test, or add one if missing.
- Run existing relevant targeted tests for candidate filtering and signal server behavior if available.
- Verify no secret-bearing fields are included in inserted `provider_fields_json` or `config_snapshot_json`.
- Before deploy, show the exact diff and branch/commit.
- On VPS after deploy, verify the active repo commit contains:
  - import/use of `logScreeningEvent` in `src/signals/serverClient.js`
  - import/use of `logScreeningEvent` or `logCandidateFilterOutcome` in `src/pipeline/candidateBuilder.js`
  - `src/db/screeningEvents.js`
- Restart Charon only through the approved safe restart path and only after owner approval if positions are open or runtime state is risky.
- After observation, run the approved Charon Intelligence pipeline and provide the read-only row-count query results.

RISKS:
- The current local worktree contains many dirty/untracked files. Coder must isolate this ticket and avoid unrelated changes.
- A table existing in the DB does not prove the deployed runtime writes to it. Verifier must check deployed code and live post-restart rows.
- If the bot does not receive enough fresh signals during the observation window, row count may remain low. In that case, prove deployed writer presence and continue observation rather than claiming behavioral failure.
- If the insert payload is too large or includes raw provider data, the telemetry can bloat SQLite or leak sensitive runtime context. Keep the ledger compact.
- If `reason_code` remains absent or generic, Charon Intelligence still cannot rank blockers reliably.

ESCALATE_IF:
- Implementing telemetry requires reading `.env`, secrets, private keys, Telegram session contents, or provider keys.
- The patch touches live trading behavior, entry approval, swap execution, position closing, or Telegram sends.
- The VPS deployed code differs from local expectations and cannot be reconciled safely.
- `screening_events` still has zero rows after deployed restart and enough fresh signals/candidates are observed.
- Tests cannot run because of native dependency or Node version issues; report the exact blocker and use the repo-supported Node version if available.
- Verifier cannot prove that new rows came from live runtime after deployment.
