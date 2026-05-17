# CHARON-ENTRY-EXIT-QC-T4-EARLY-WIDE-SL-GUARDED

## Goal

Allow early-token wider SL only when paired with a no-TP time stop guard.

## Proposed Config

- `early_token_age_ms`
- `early_token_sl_percent`

## Required Behavior

- On position creation, persist the effective SL into `dry_run_positions.sl_percent`.
- Apply wider SL only when:
  - token age is at most `early_token_age_ms`
  - `max_hold_if_no_tp_ms > 0`
- Do not widen existing open positions retroactively.

## Risk Note

Recent Charon Intelligence evidence showed a poor short-window loss profile. This ticket should be shadow/lab tested first or use conservative values unless the owner explicitly approves live config changes.

## Explicit Non-Goals

- Do not loosen entry filters.
- Do not implement no-TP time stop if T2 is not already present.
- Do not run live trading, PM2, Telegram flows, services, or runtime DB/log inspection.

## Acceptance

- Unit tests cover effective SL selection.
- Tests prove wider SL requires time-stop config.
