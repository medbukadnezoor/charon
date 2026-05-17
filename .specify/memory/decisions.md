# Decisions

Updated: 2026-05-12 15:16 +0700

## Durable decisions
- `AGENTS.md` remains the canonical contract for cross-tool instructions.
- Workflow Manager v2 CLI-managed mode is active because `workflow status --path` works for this repo and `workflow init --adopt-manual` was used.
- `CLAUDE.md`, `GEMINI.md`, `.claude/`, `.gemini/`, `.kiro/`, `.opencode/`, `.factory/`, `.workflow/*`, and repo-local `ROLES.md` are CLI-owned generated surfaces.
- Session continuity must live in repo-local files instead of chat memory alone.
- The current active task is wallet-pipeline implementation from `WALLET_PIPELINE_PLAN.md`.
- Owner confirmed the priority wallet scoring matched wallets they want to follow, so A/B priority tiers are acceptable for manual import preview.
- On 2026-05-12, 70 A/B priority wallets were imported into Charon `saved_wallets`.

## Open questions
- M2 LLM reviewer needs an explicit secret-safe API-key handling path before implementation or execution.
- Runtime and secrets risk remains out of scope until a future owner-approved runtime ticket.
