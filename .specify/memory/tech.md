# Tech Context

Updated: 2026-05-11 06:55 +0700

## Stack
- Python CLI runtime: Workflow Manager v2 commands are provided by the local `workflow` CLI.
- zsh shell wrapper signal: generated tool shims and shell-facing wrappers are CLI-owned compatibility surfaces.
- Node.js ESM application.
- Documented dependencies include Solana web3, axios, better-sqlite3, dotenv, Telegram bot API, and ws.
- Runtime configuration is environment-driven and secret-sensitive.
- SQLite runtime state is documented by the README but is not approved for inspection in this slice.

## Core commands
- `workflow init`
- `workflow sync`
- `workflow status`
- `workflow doctor`

## Approved commands in current slice
- `workflow init --path "." --adopt-manual`
- `workflow sync --path "."`
- `workflow status --path "."`
- `workflow doctor --path "." --write-report`
- Git metadata reads

## Not approved yet
- `npm install`
- `npm run check`
- `npm start`
- PM2
- Provider, Telegram, wallet, swap, SQLite runtime, or app execution commands

## Important files
- `AGENTS.md`
- `README.md`
- `package.json`
- `.env.example`
- `.specify/*`
