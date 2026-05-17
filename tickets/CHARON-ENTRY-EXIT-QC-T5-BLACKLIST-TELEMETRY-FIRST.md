# CHARON-ENTRY-EXIT-QC-T5-BLACKLIST-TELEMETRY-FIRST

## Goal

Add blacklist telemetry that avoids unsafe deployer over-blocking.

## Required Behavior

- Add an exact mint blacklist first.
- Exact mint blacklist blocks re-entry into that mint.
- Add deployer observations only:
  - mint
  - deployer or creator if available
  - loss severity
  - exit reason
  - rug, top-holder, or bundler context
  - timestamp
- Do not auto-block a deployer on first hard loss.
- If deployer block is later added, require repeated evidence and explicit owner-approved configuration.

## Reason

The owner noted that token deployer and token runner may not be the same actor. This ticket should collect evidence before broad blocking.

## Explicit Non-Goals

- Do not implement deployer auto-block as the first patch.
- Do not change exit policy.
- Do not run live trading, PM2, Telegram flows, services, or runtime DB/log inspection.

## Acceptance

- Hard-rug or SL event can create an observation.
- Exact mint blacklist blocks entry.
- No deployer auto-block exists unless explicitly configured and tested.
