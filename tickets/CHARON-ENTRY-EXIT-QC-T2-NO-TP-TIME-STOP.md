# CHARON-ENTRY-EXIT-QC-T2-NO-TP-TIME-STOP

## Goal

Implement a time stop that closes only when a position has failed to reach TP or runner state.

## Proposed Config

- `max_hold_if_no_tp_ms`
- Optional display label: `No-TP Hold`

## Required Behavior

- If position age is at least `max_hold_if_no_tp_ms`, and TP/trailing has not been reached or armed, close with reason `TIME_STOP_NO_TP`.
- If TP was reached, for example `trailing_armed = 1` or future profit-lock state is armed, do not time-close.
- Keep existing `max_hold_ms` as the blunt global max hold for users who explicitly want it.

## Explicit Non-Goals

- Do not replace existing `max_hold_ms`.
- Do not implement break-even lock.
- Do not add partial TP.
- Do not run live trading, PM2, Telegram flows, services, or runtime DB/log inspection.

## Acceptance

- Unit test: closes after configured time when TP was never reached.
- Unit test: does not close after configured time when trailing is armed.
- Telegram configurability may be deferred unless the Architect explicitly includes it in this ticket.
