# CHARON-ENTRY-EXIT-QC-T4-EARLY-WIDE-SL-SHADOW

## Dependency

Follows T2/T3 and should start shadow/lab-first.

## Goal

Design and implement early-token wide stop-loss as shadow/effective-SL evidence first, only when paired with no-TP time stop.

## Why Now

Owner is interested in wider SL for very early tokens, but latest 24h losses were already poor, so this needs guarded evidence before live policy.

## Owner-Visible Outcome

Owner can see whether a position would have used early wide SL, why, and what effective SL was persisted at entry.

## Owner Proof

Tests and report/snapshot fields showing normal SL vs early-token effective SL selection.

## Owner Check Steps

- Run focused effective-SL tests.
- Inspect one position snapshot showing `effective_sl_percent` and early-token reason.

## Files In Scope

- `src/db/connection.js`
- `src/db/positions.js`
- `src/execution/positions.js`
- `src/pipeline/orchestrator.js` or entry path as needed
- `tests/positionPnlTrigger.test.js`

## Acceptance Criteria

- Add `early_token_age_ms` default `0`.
- Add `early_token_sl_percent` default `null`/off.
- Apply only at position creation when token age is less than or equal to `early_token_age_ms` and `max_hold_if_no_tp_ms > 0`.
- Persist effective SL on position.
- Do not widen existing open positions retroactively.
- Prefer shadow/report-only unless owner approves live use.

## Required Checks

- `npm run check`
- focused effective-SL tests
- `node --test tests/positionPnlTrigger.test.js`
- `git diff --check`

## Risks

Wider SL can worsen loss tails if time stop does not work, token age is unreliable, or market-cap sampling is stale.

## Escalate If

Token age is missing/untrusted, no-TP time stop is not already proven, or implementation would alter existing open positions.
