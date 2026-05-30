# Birdeye-Efficient Observation Layer

Date: 2026-05-21

## Problem

The original observation layer was built as a broad telemetry collector. For each due
token it called Birdeye market data, holders, OHLCV, and token transactions fallback,
then repeated that across short follow-up buckets. Running primary and shadow
collectors together multiplied the same pattern across two databases.

That is too expensive for the current Birdeye budget. The reverse-engineering goal is
not continuous real-time monitoring. The useful label is whether a token ran after
Charon first saw it, plus the rough path to peak/drawdown for indicator analysis.

## Hypothesis

For token-watch reverse engineering, delayed OHLCV snapshots carry most of the value.
Market data and holder concentration are useful secondary enrichments, but Charon
already has cheap first-sighting snapshots from signal/Jupiter/GMGN paths. Birdeye
should therefore be reserved for normalized OHLCV outcome labeling, then escalated to
extra endpoints only for high-value cohorts or confirmed runners.

## Tonight Mode

Run observation collectors in `outcome_ohlcv` mode:

- Queue all normal Charon watch targets, but only collect tier `A` rows.
- Do not observe immediately.
- First Birdeye pull after 6 hours.
- Second pull after 24 hours.
- Pull only `/defi/v3/ohlcv`.
- Disable `/defi/v3/token/txs` fallback by default.
- Keep collector pacing at 60 seconds between provider calls.
- Hard-stop per DB when the daily Birdeye network-call cap is reached.

Current proposed caps:

| Collector | Daily Birdeye network calls | Purpose |
| --- | ---: | --- |
| primary observation | 250 | Live candidate outcome labels |
| shadow observation | 100 | Shadow-only sample, lower priority |

These are intentionally conservative. They can be raised after checking the Birdeye
dashboard's actual CU-per-endpoint cost.

## Process Model

The two Charon bot processes are still distinct concerns:

- `charon` generates primary live/dry-run candidates and queues primary watch rows.
- `charon-shadow` generates shadow candidates and queues shadow watch rows.

The two collector processes exist only because the current code opens one DB through
module-level `DB_PATH`. They are not conceptually required. A future unifying wrapper
can run primary and shadow collector passes serially under one PM2 process, with a
shared global Birdeye budget. That wrapper should not change trading behavior.

## Provider Policy

Birdeye:

- Primary use: OHLCV/backtest-style outcome labeling.
- Avoid for routine market/holder data.
- Token transaction fallback is off unless a special cohort needs it.

Jupiter:

- Use for cheap asset/holder/chart context already needed in candidate execution.
- Watch for 429s and cache/backoff behavior, but do not replace Birdeye OHLCV labels
  with Jupiter unless accuracy is validated.

GMGN:

- Use for token info, trend/risk/fee context, and harvester wallet discovery.
- Keep existing delays/caps; add provider ledger only if it starts rate limiting.

OKX:

- Current harvester use is wallet discovery/profile fill-in, not OHLCV.
- Later, add a dedicated OKX key for shadow if it can supply reliable candles or
  portfolio/holder enrichment cheaper than Birdeye.
- Do not make OKX required for tonight.

Helius:

- Useful for raw transaction history and wallet trade reconstruction.
- Not a normalized OHLCV replacement.

## Escalation Design

After the OHLCV-only labels exist, add a second-stage enrichment job:

- Identify runners, near-runners, LLM BUYs, high-confidence WATCHes, and strong
  saved-wallet cohorts.
- For those only, optionally fetch Birdeye market data, holders, and token txs.
- Persist explicit cohort reason and provider cost in `provider_call_ledger`.
- Keep this as a separate bounded job, not part of every due observation row.

## Success Criteria

- Observation layer can run overnight without exceeding configured daily caps.
- `provider_call_ledger` shows mostly `/defi/v3/ohlcv`, with no token-txs fallback
  unless explicitly enabled.
- `token_observations` gains 6h/24h OHLCV rows for tier-A primary candidates.
- Shadow observation volume is intentionally lower than primary.
- No Birdeye calls come from wallet auto-sync.

