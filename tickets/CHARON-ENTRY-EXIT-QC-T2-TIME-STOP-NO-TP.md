# CHARON-ENTRY-EXIT-QC-T2-TIME-STOP-NO-TP

## Dependency

Depends on T1 market-cap sampler landing or being explicitly deferred.

## Goal

Add time-based close only for positions that never reached TP/trailing runner state.

## Why Now

Owner wants close if no TP within about 30 minutes, but current `max_hold_ms` is blunt and can close positions even after TP/trailing was reached.

## Owner-Visible Outcome

A position that never reaches TP closes with `TIME_STOP_NO_TP` after configured time; a runner that reached TP/trailing stays open.

## Owner Proof

Unit tests showing no-TP time stop closes one position and does not close a `trailing_armed` position.

## Owner Check Steps

- Inspect strategy menu or config showing `max_hold_if_no_tp_ms`.
- Run focused position tests.

## Files In Scope

- `src/execution/positions.js`
- `src/db/connection.js`
- `src/db/settings.js`
- `src/telegram/menus.js`
- `src/telegram/commands.js`
- `src/telegram/callbacks.js`
- `tests/positionPnlTrigger.test.js`

## Acceptance Criteria

- Add `max_hold_if_no_tp_ms` default `0`.
- Keep `max_hold_ms` unchanged.
- Close with `TIME_STOP_NO_TP` only when age threshold is reached and `trailing_armed` is false.
- Make Telegram-configurable in first patch because owner uses Telegram knobs.

## Required Checks

- `npm run check`
- `node --test tests/positionPnlTrigger.test.js`
- `node --test tests/liveSellReconciliation.test.js`
- `git diff --check`

## Risks

Mistaking a runner for a dead trade, or changing existing `max_hold_ms` semantics.

## Escalate If

Position state cannot reliably prove TP/trailing reached, or Telegram config change risks runtime mutation outside normal strategy settings.
