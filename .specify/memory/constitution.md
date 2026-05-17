# Constitution

Updated: 2026-05-11 06:55 +0700
Primary source: `AGENTS.md`

## Non-negotiables
- Keep `AGENTS.md` as the canonical cross-tool contract.
- Global workflow rules live in `~/AGENTS.md`; canonical role definitions live in `~/ROLES.md`.
- Do not redefine Architect / Coder / Verifier roles inside Charon.
- Do not run live trading, confirm trading, wallet signing, swap execution, Telegram command flows, app runtime, PM2, dependency installs, or runtime checks without a future owner-approved ticket.
- Do not set, read, print, copy, validate, or modify `.env`, wallet/private keys, Telegram tokens, provider keys, API keys, credentials, SQLite runtime state, or runtime logs.

## Continuity contract
- `AGENTS.md` is the only hand-edited cross-tool contract.
- Run `workflow sync` after any change to `AGENTS.md`.
- Treat `.specify/memory/*` and `.specify/state/*` as the primary v2 continuity layer.
- Treat generated mirrors, lock state, and repo-local `ROLES.md` as CLI-owned.
- Prefer truthful safety state over broad execution.
