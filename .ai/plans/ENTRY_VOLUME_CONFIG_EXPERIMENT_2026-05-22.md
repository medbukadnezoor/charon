# Entry Volume Config Experiment - 2026-05-22

## Goal

Increase live sniper entry attempts from near-zero toward roughly one OHLCV-tested opportunity per hour without disabling the main quality stack.

This is a configuration experiment, not a code change. The goal is to let more candidates reach LLM approval and OHLCV entry confirmation, while preserving fresh filters, OHLCV local-top rejection, max-open-position checks, and execution guards.

## Pre-change observation

Window checked: 2026-05-21 16:38 UTC to 2026-05-22 04:38 UTC.

- Candidates created: 3,035
- Filtered before entry: 3,018
- Candidate status `watch`: 17
- Candidate-filter passes: 52
- LLM BUY decisions: 1
- Entries opened: 0
- Trade intents: 0
- OHLCV entry-confirm rows: 0
- Entry watch rows: 0

The only LLM BUY had confidence 63 while live sniper required 65, so it stopped before fresh filters and OHLCV confirmation.

Dominant blockers were alt-gate concentration and alt-gate saved-wallet requirements.

## Deployed changes

Target DB: `/opt/trading-data/charon.sqlite`

Strategy: `sniper`

| Key | Before | After | Reason |
| --- | ---: | ---: | --- |
| `llm_min_confidence` | 65 | 60 | Allow near-miss BUY decisions like the 63-confidence NBA case to reach downstream checks. |
| `fee_claim_alt_max_top20_holder_percent` | 40 | 50 | Reduce over-filtering on the no-fee-claim alt path while keeping a concentration cap. |
| `fee_claim_alt_min_saved_wallet_holders` | 2 | 1 | Allow single saved-wallet overlap to reach LLM/OHLCV instead of hard reject. |
| `min_gmgn_total_fee_sol` | 6 | 4 | Admit earlier fee activity before the token has fully matured. |
| `entry_watch_enabled` | unset/false | true | Watch LLM BUY + OHLCV timing rejects for a better entry after dip/recovery. |
| `entry_watch_max_active` | unset | 10 | Bound active watched names. |
| `entry_watch_window_ms` | unset | 3,600,000 | Watch each rejected entry for 60 minutes. |
| `entry_watch_recheck_ms` | unset | 300,000 | Recheck every 5 minutes. |
| `entry_watch_max_attempts` | unset | 6 | Bound Birdeye CU burn per watch. |
| `entry_watch_min_entry_score` | unset | 45 | Require acceptable OHLCV score before re-entry. |
| `entry_watch_min_pullback_pct` | unset | 8 | Avoid re-entering without a real dip from the rejection high. |
| `entry_watch_max_pullback_pct` | unset | 45 | Avoid catching extreme breakdowns. |
| `entry_watch_require_fresh_filters` | unset | true | Re-run fresh filters before any watched entry. |

Global CU controls already present:

- `entry_watch_birdeye_daily_cu_cap = 300`
- `entry_watch_eval_interval_ms = 60000`
- `entry_watch_eval_limit = 3`
- `entry_watch_budget_cooldown_ms = 3600000`

## Expected behavior

More candidates should reach LLM and more LLM BUY decisions should reach OHLCV entry confirmation. Bad timing should be rejected by OHLCV or moved into `entry_watchlist` instead of becoming immediate entries.

This experiment does not make LLM WATCH decisions buyable. The confidence threshold only applies to LLM BUY decisions.

## Rollback values

Set these strategy keys back on `sniper`:

```json
{
  "llm_min_confidence": 65,
  "fee_claim_alt_max_top20_holder_percent": 40,
  "fee_claim_alt_min_saved_wallet_holders": 2,
  "min_gmgn_total_fee_sol": 6,
  "entry_watch_enabled": false
}
```

The extra `entry_watch_*` tuning keys can remain inert if `entry_watch_enabled` is false.

## Monitoring

Watch for:

- `entry_not_approved` count dropping
- `entry-confirm` logs appearing again
- new rows in `entry_watchlist`
- `entry_watch_birdeye_daily_cu_cap_reached` in `provider_call_ledger`
- any rapid rise in live entries from highly concentrated tokens

