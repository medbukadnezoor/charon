# CHARON-ENTRY-EXIT-QC-T5-BLACKLIST-TELEMETRY

## Dependency

Follows T1-T4 evidence.

## Goal

Add exact-mint blacklist and deployer observation telemetry without deployer auto-blacklisting.

## Why Now

Owner wants hard rug learning, but correctly flagged that deployer and runner may not be the same actor.

## Owner-Visible Outcome

After a severe loss, Charon can record mint/deployer observations; exact blacklisted mints are blocked, but deployers are not auto-blocked.

## Owner Proof

Tests showing exact mint blacklist blocks re-entry, hard-loss observation is recorded, and deployer is not blocked by default.

## Owner Check Steps

- Inspect blacklist/observation table rows.
- Run focused blacklist tests.

## Files In Scope

- `src/db/connection.js`
- `src/pipeline/candidateBuilder.js`
- `src/execution/positions.js`
- `src/db/*blacklist*` if added
- `src/telegram/menus.js` only if owner-facing controls are included
- `tests/*blacklist*`

## Acceptance Criteria

- Add exact mint blacklist path.
- Add deployer observation fields/table: mint, deployer/creator if available, exit reason, loss severity, rug/top-holder/bundler context, timestamp.
- No deployer auto-block in first pass.
- Any future deployer block must require repeated evidence and explicit config.

## Required Checks

- `npm run check`
- focused blacklist tests
- screening/filter tests
- `git diff --check`

## Risks

Over-blocking good tokens, unreliable deployer identity, or turning observations into live filters too early.

## Escalate If

Deployer identity is unavailable/unreliable, blacklist would require live DB mutation during implementation, or any path auto-blocks deployers by default.
