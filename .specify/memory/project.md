# Project Memory

Updated: 2026-05-12 15:16 +0700
Primary source: `AGENTS.md`

## What this project is
Charon is an early-trenching Telegram trench agent for Pump-token flow. It screens noisy Pump-token signals with overlap data, strategy gates, LLM selection, and dry-run / confirm / live execution paths.

## Stable facts
- Repo path: `.`
- Fork posture: `origin` is `medbukadnezoor/charon`; `upstream` is `yunus-0x/charon`.
- This repo is now Workflow Manager v2 managed.

## Current status snapshot
Workflow Manager v2 scaffold is active. The current active work is the smartwallet pipeline in `WALLET_PIPELINE_PLAN.md`: keep broad wallet harvest data outside Charon, rank wallets for under-200K Charon targets, and import only owner-approved priority wallets into Charon `saved_wallets`.

## Next validation step
For wallet pipeline continuation, validate local scripts with `node --check scripts/*.js` and dry-run imports before any `--commit`. For Workflow Manager continuity changes, run `workflow sync --path "."` and health checks.
