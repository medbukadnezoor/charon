# Charon VPS PM2 Commands

Updated: 2026-05-13 10:05 +0700

VPS host alias: `moonbags`

PM2 process name: `charon`

Runtime path: `/home/opc/charon`

Data paths:

- Charon DB: `/opt/trading-data/charon.sqlite`
- Harvester DB: `/opt/trading-data/harvester.db`

## Shortcuts

These work directly over SSH, Meridian-style:

| Command | Action |
| --- | --- |
| `ssh moonbags chs` | PM2 status, filtered to Charon-relevant rows |
| `ssh moonbags chl` | Charon logs, 50 lines |
| `ssh moonbags chll` | Charon logs, 200 lines |
| `ssh moonbags chr` | Restart Charon with updated env |
| `ssh moonbags chstop` | Stop Charon |
| `ssh moonbags chstart` | Start Charon from PM2 ecosystem |
| `ssh moonbags chready` | DB-only dry-run readiness check |
| `ssh moonbags chmatrix` | Provider-stubbed strategy matrix check |

The same names are also available as interactive aliases after SSH login.

## Guardrails

`/home/opc/charon/start-charon.sh` refuses to start unless:

- `/home/opc/charon/.env` exists
- `TRADING_MODE=dry_run`
- `TELEGRAM_BOT_TOKEN` is present
- `TELEGRAM_CHAT_ID` is present
- either `HELIUS_API_KEY` is present, or both `SOLANA_RPC_URL` and `SOLANA_WS_URL` are present

It defaults:

- `DB_PATH=/opt/trading-data/charon.sqlite`
- `HARVESTER_DB_PATH=/opt/trading-data/harvester.db`
- `TRADING_MODE=dry_run`

## Current State

The PM2 process is registered and saved, but stopped:

- `charon`: `stopped`

The env file is currently missing:

- `/home/opc/charon/.env`

Template:

- `/home/opc/charon/.env.operator.example`

After creating `/home/opc/charon/.env`, start with:

```bash
ssh moonbags chstart
```

Then check:

```bash
ssh moonbags chs
ssh moonbags chl
```
