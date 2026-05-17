# Charon VPS Settings Rollback Commands

Created: 2026-05-13 18:08 +0700

## Current VPS State Checked

- Active strategy: `sniper`
- Runtime mode: `dry_run`
- Global agent: `agent_enabled=true`
- `sniper.min_saved_wallet_holders=1`
- `sniper.use_llm=true`
- `sniper.llm_min_confidence=50`
- `degen.min_saved_wallet_holders=0`
- `degen.use_llm=false`
- `degen.llm_min_confidence=0`

## Telegram Commands To Return To Current Settings

Send these in the Charon Telegram chat to return after the degen smart-wallet test:

```text
/stratset degen min_saved_wallet_holders 0
/stratset degen use_llm false
/stratset degen llm_min_confidence 0
/strategy sniper
```

Optional status checks:

```text
/strategy
/filters
/menu
```

## Notes

- These are Telegram commands, not shell commands.
- They do not inspect or print `.env` or secrets.
- They do not change `trading_mode`; VPS currently reports `dry_run`.
