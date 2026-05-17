# CHARON-ENTRY-EXIT-QC-T3-BREAKEVEN-LOCK

## Dependency

Follows T2 no-TP time stop.

## Goal

Add no-partial-sell break-even/profit-lock behavior.

## Why Now

Owner does not want partial TP, but wants the TP1-then-SL-to-entry concept as a lock/floor instead of selling half.

## Owner-Visible Outcome

After a position reaches configured profit, Charon arms a break-even lock; if it later falls to the configured floor, Charon closes with `BREAKEVEN_LOCK`.

## Owner Proof

Tests show arm at `+50%`, no partial sell, later close at `0%` or configured lock percent.

## Owner Check Steps

- Run focused position tests.
- Inspect `dry_run_positions` columns/position output showing `breakeven_armed` state.

## Files In Scope

- `src/db/connection.js`
- `src/db/positions.js`
- `src/execution/positions.js`
- `src/telegram/menus.js`
- `src/telegram/commands.js`
- `src/telegram/callbacks.js`
- `tests/positionPnlTrigger.test.js`
- `tests/liveSellReconciliation.test.js`

## Acceptance Criteria

- Add `breakeven_after_profit_percent` default `0`.
- Add `breakeven_lock_percent` default `0`.
- Add durable columns `breakeven_armed`, `breakeven_armed_at_ms`, `breakeven_lock_percent`.
- Do not use `partial_tp_done`.
- Never call partial sell logic for this feature.

## Required Checks

- `npm run check`
- focused breakeven tests
- `node --test tests/liveSellReconciliation.test.js`
- `git diff --check`

## Risks

Conflict with trailing TP, partial TP legacy fields, or live residual sell reconciliation.

## Escalate If

Existing partial TP behavior cannot be isolated, or live-mode test paths would require real selling/signing.
