# CHARON-ENTRY-EXIT-QC-T1-MCAP-SAMPLER

## End Goal

Entry/exit quality control milestone from `.ai/handoffs/ENTRY_EXIT_QUALITY_CONTROL_PLANNER_HANDOFF.md`.

## Goal

Create one canonical market-cap sampler used by candidate build, pre-execution refresh, and position monitoring.

## Why Now

Current entry and exit paths use different market-cap source order, and recent evidence shows market cap can move sharply between scans.

## Owner-Visible Outcome

Owner can see which market-cap source Charon trusted, what other sources said, and whether the reading was stale or disputed.

## Owner Proof

Sampler tests plus candidate/position snapshot JSON containing source readings, chosen source, disagreement percent, sampled timestamp, and fallback flags.

## Owner Check Steps

- Run `npm run check`.
- Run focused sampler tests.
- Inspect one sample/report showing GMGN, Jupiter, trending, and fallback readings.

## Files In Scope

- `src/enrichment/mcapSampler.js`
- `src/pipeline/candidateBuilder.js`
- `src/execution/positions.js`
- `src/db/positions.js`
- `tests/*mcap*` or focused existing position tests

## Acceptance Criteria

- Sampler priority is fresh GMGN, Jupiter market cap, Jupiter FDV, live trending market cap, then existing fallback.
- Pre-execution and monitoring request uncached sources where practical.
- Near-threshold/high-disagreement samples are logged.
- No filter loosening or exit policy change.

## Required Checks

- `npm run check`
- focused sampler tests
- `node --test tests/positionPnlTrigger.test.js`
- `node --test tests/liveSellReconciliation.test.js`
- `node --test tests/sameMintGuard.test.js`
- `git diff --check`

## Risks

Provider disagreement, rate limits, and accidentally changing buy/exit behavior while refactoring source order.

## Escalate If

Fresh sampling needs secrets/live runtime, disagreement would block many candidates, or tests require trading/runtime execution.
