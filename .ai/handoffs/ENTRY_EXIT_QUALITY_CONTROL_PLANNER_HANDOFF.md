# Entry/Exit Quality Control Planner Handoff

Created: 2026-05-16 Asia/Jakarta
Repo: `.`
Intelligence repo: `../charon-intelligence`

## Objective

Plan a safer Charon milestone for:

1. Better market-cap sampling before entry and during position monitoring.
2. Time-based close only when a position fails to reach TP/runner state.
3. Optional early-token wide-SL framework, but only with a time stop.
4. Break-even/profit-lock behavior without partial TP.
5. Blacklist telemetry that avoids over-blocking deployers too early.

The user wants higher entry quality and better exits, not simply more buys.

## Owner Preferences

- User changed `min_saved_wallet_holders` to `1` and `llm_min_confidence` to `65` via Telegram.
- User does **not** like partial TP.
- User is unsure about deployer blacklist because token deployer and token runner may not be the same actor.
- User is interested in the idea:
  - early token: wider SL
  - close if no TP within ~30 minutes
  - auto-blacklist after hard rug
  - TP1 at 50%, then SL moves to entry
- Preferred interpretation: no partial sell; use break-even/profit lock instead.

## Current Confirmed Live Config

Read-only VPS check against `/opt/trading-data/charon.sqlite` on `moonbags` showed:

```json
{
  "id": "sniper",
  "min_saved_wallet_holders": 1,
  "llm_min_confidence": 65,
  "max_hold_ms": 0,
  "partial_tp": false,
  "tp_percent": 50,
  "sl_percent": -25,
  "trailing_enabled": true,
  "trailing_percent": 20
}
```

The latest Charon Intelligence snapshot before this live config change was `20260516T105908Z`, synced `2026-05-16T10:59:17Z`.

## Evidence From Charon Intelligence

Fresh pipeline run in `../charon-intelligence`:

```bash
bash scripts/run_full_pipeline.sh --days 1
```

Pipeline passed. Key files:

- `reports/latest_trade_analysis.md`
- `reports/latest_filter_analysis.md`
- `reports/latest_llm_audit.md`
- `reports/latest_consult_packet.md`
- `data/vps-snapshots/latest/`

Key 24h stats from the fresh report:

- 8 closed trades.
- Win rate: 12.5% (1W / 7L).
- Total PnL: -0.0636 SOL.
- Avg PnL: -15.9%.
- Routes:
  - `fee_trending`: 4 trades, 25.0% win, avg -6.9%.
  - `fee_graduated_trending`: 4 trades, 0.0% win, avg -24.9%.
- Exits:
  - SL: 5, avg -27.0%.
  - MANUAL: 2, avg -32.9%.
  - TP: 1, +73.2%.
- LLM:
  - 173 batches.
  - BUY 35, WATCH 28, PASS 110.
  - Confidence was weakly calibrated; the only TP was from a 65% confidence batch.

Filter report said active filters were protective in the losing window:

- `min_saved_wallet_holders`: 205 rejects, +0.6866 SOL estimated protection.
- `min_gmgn_total_fee_sol`: 144 rejects, +0.4347 protection.
- `min_mcap_usd`: 119 rejects, +0.4858 protection.
- `max_mcap_usd`: 110 rejects, +0.2769 protection.
- `require_fee_claim`: 105 rejects, +0.3149 protection.
- `max_top20_holder_percent`: 103 rejects, +0.3260 protection.
- `min_holders`: 74 rejects, +0.1987 protection.

Planner should not recommend broad filter loosening unless a newer snapshot disproves this.

## Telegram Channel Context

Fresh Telegram ingest had 1,385 messages in the latest 1-day window, but much is noisy Meridian/API support chatter. Relevant extracted themes:

- Practical advice: strategy filters should reject candidates before LLM to save tokens. This supports keeping raw filters strict while testing lower LLM confidence.
- Smart-wallet convergence theme: “smart pool sniper” idea tracks early wallets and enters only after several tracked wallets enter. This supports wallet-overlap gating.
- Current mcap accuracy concern: one user reported bad current-mcap feed causing bad entries; another suggested checking range movement before accepting entries.
- Rug risk remains a common warning. This argues against relaxing holder concentration/rug/bundler protection casually.
- Exit idea discussed: `profit_lock`, not partial TP. Let winners run and raise the exit floor after profit milestones.

## Existing Code Surfaces

Read these first:

- `src/pipeline/candidateBuilder.js`
- `src/execution/positions.js`
- `src/execution/router.js`
- `src/db/connection.js`
- `src/db/positions.js`
- `src/telegram/menus.js`
- tests:
  - `tests/positionPnlTrigger.test.js`
  - `tests/liveSellReconciliation.test.js`
  - `tests/sameMintGuard.test.js`

Current candidate market-cap source order in `buildCandidate`:

```js
GMGN market cap
-> Jupiter mcap
-> Jupiter fdv
-> trending market_cap
-> graduated marketCap/usd_market_cap
```

Current pre-execution refresh source order in `refreshCandidateForExecution`:

```js
GMGN market cap
-> Jupiter mcap
-> Jupiter fdv
-> live trending market_cap
-> original candidate mcap
```

Current position monitoring in `refreshPosition`:

```js
Jupiter mcap
-> Jupiter fdv
-> high_water_mcap
-> entry_mcap
```

So entry has a fresh check, but exit monitoring is Jupiter-only and can fall back to stale high-water/entry values.

Existing exit controls:

- `max_hold_ms` exists in strategy config and Telegram menu.
- Current behavior is blunt:
  - if `max_hold_ms` elapsed, close with `MAX_HOLD`.
  - It does not distinguish “never reached TP” from “already reached TP/trailing armed.”
- `partial_tp` exists but user does not want partial TP.
- `trailing_armed` already marks that TP threshold was reached when trailing is enabled.

## Mcap Sampling Evidence

Read-only snapshot check showed repeated candidate samples can move sharply between scans. Examples from latest snapshot:

- `DkaY3z9h...`: 16.2k -> 148.7k mcap, +816%.
- `6MipUvJW...`: 39.9k -> 140.9k mcap, +252%.
- `BnK8QgRW...`: 82.4k -> 198.6k mcap, +141%.
- `EFo8xw99...`: 4.0k -> 35.4k mcap, +786%.

This supports a shared market-cap sampler with source disagreement logging and near-threshold second-sampling.

## Proposed Planner Milestone Shape

### Ticket 1: Shared Mcap Sampler

Goal: one canonical sampling path for candidate build, pre-execution, and position monitor.

Design:

- Add `src/enrichment/mcapSampler.js` or similar.
- Inputs: mint, optional candidate/trending/graduated fallback, context label.
- Fetch:
  - GMGN token info, uncached for pre-execution if possible.
  - Jupiter asset, uncached for pre-execution/monitoring if possible.
  - current trending cache if available.
- Return:
  - `marketCapUsd`
  - `priceUsd`
  - `source`
  - all source readings
  - source spread / disagreement percent
  - sampledAtMs
  - stale/fallback flags
- Use the sampler in:
  - `buildCandidate`
  - `refreshCandidateForExecution`
  - `refreshPosition`
- Store/log source details in candidate and trade/position payload JSON.
- If mcap is near threshold, planner should consider requiring a second fresh sample before buy.

Acceptance:

- Existing tests still pass.
- New tests cover source priority, disagreement logging, and fallback behavior.
- No secrets or live trading calls in tests.

### Ticket 2: Time Stop Only If TP Was Never Reached

Goal: implement user’s “30 minutes no TP close” without blunt max-hold behavior.

New config fields:

- `max_hold_if_no_tp_ms`
- optional display label: “No-TP Hold”

Behavior:

- If position age >= `max_hold_if_no_tp_ms`
- and TP/trailing has **not** been reached/armed
- then exit with reason `TIME_STOP_NO_TP`.
- If TP was reached (`trailing_armed = 1` or a future profit-lock flag is set), do not time-close.

Do not replace existing `max_hold_ms`; keep it as the blunt global max hold for users who explicitly want it.

Acceptance:

- Unit test: closes after 30m if no TP.
- Unit test: does not close after 30m if trailing is armed.
- Telegram menu can show/configure it, or planner can decide to make it script-only first.

### Ticket 3: Break-Even Lock Without Partial Sell

Goal: replace partial TP preference with no-partial break-even behavior.

New config fields:

- `breakeven_after_profit_percent` (example: 50)
- `breakeven_lock_percent` (example: 0)

Behavior:

- When PnL reaches `breakeven_after_profit_percent`, arm break-even lock.
- If price later falls to `breakeven_lock_percent` or below, close with `BREAKEVEN_LOCK`.
- Do not sell partially.

Implementation detail:

- Requires durable per-position state. Current `dry_run_positions` has `partial_tp_done` but no generic lock flag.
- Add columns such as:
  - `breakeven_armed INTEGER DEFAULT 0`
  - optional `breakeven_armed_at_ms INTEGER`
  - optional `breakeven_lock_percent REAL`
- Avoid overloading `partial_tp_done`.

Acceptance:

- Unit test: arms at +50%, remains open.
- Unit test: later falls to 0% and closes.
- Unit test: does not partial sell in live mode.

### Ticket 4: Early Wide SL With Time Stop Guard

Goal: allow early-token wider SL only when paired with `TIME_STOP_NO_TP`.

Design:

- New optional fields:
  - `early_token_age_ms`
  - `early_token_sl_percent`
- On position creation, persist effective SL into `dry_run_positions.sl_percent`.
- Only apply wide SL if:
  - token age <= `early_token_age_ms`
  - `max_hold_if_no_tp_ms > 0`
- Do not widen existing open positions retroactively.

Risk:

- Last 24h loss profile was already poor. Planner should recommend shadow/lab test first or very conservative values.

Acceptance:

- Unit tests for effective SL selection.
- Tests prove wide SL requires time-stop config.

### Ticket 5: Blacklist Telemetry First

Goal: avoid unsafe deployer over-blocking.

Design:

- Add immediate mint blacklist first:
  - table or setting-backed list.
  - blocks exact mint re-entry.
- Add deployer observations only:
  - mint
  - deployer/creator if available
  - loss severity
  - exit reason
  - rug/top-holder/bundler context
  - timestamp
- Do not auto-block deployer on first hard loss.
- If deployer block is later added, require repeated evidence.

Reason:

User correctly noted deployer and token runner may not be same entity.

Acceptance:

- Hard-rug/SL event can create observation.
- Exact mint blacklist blocks entry.
- No deployer auto-block unless explicitly configured and tested.

## Safety Boundaries

- No trading.
- No swaps/signing.
- No Telegram sends.
- No `.env` reads or secret printing.
- No direct Charon SQLite mutation while planning.
- SQLite reads must use read-only mode or Charon Intelligence snapshot.
- Any implementation should go through Architect -> Coder -> Verifier.
- Deploy/restart only after explicit owner approval.

## Suggested Next Step For Planner

Produce a phased implementation plan and tickets, not code.

Required planner output:

1. Clarify exact config names and defaults.
2. Decide whether `max_hold_if_no_tp_ms` should be Telegram-configurable in the first patch.
3. Decide mcap sampler source priority and disagreement behavior.
4. Decide position schema additions.
5. Decide test matrix.
6. Identify which work should be shadow-only first.

Do not recommend enabling partial TP. Do not recommend deployer auto-blacklist as the first implementation.
