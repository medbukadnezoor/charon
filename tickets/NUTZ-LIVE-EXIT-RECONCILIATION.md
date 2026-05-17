# NUTZ Live Exit Reconciliation — Architect Ticket

**Type:** Architect (Planner Output)
**Parent handoff:** `.ai/handoffs/NUTZ_LIVE_EXIT_RECONCILIATION_PLANNER_HANDOFF.md`
**Status:** Open
**Created:** 2025-05-15

---

## Context

On 2026-05-15, Charon closed NUTZ position #19 via SL at ~94.2k mcap. Jupiter `/execute` returned `Success` with signature `2WXMm6...`. However, the wallet still held ~32,132 NUTZ tokens after the sell. Charon then re-entered the same mint twice more (positions #21, #22), each closing within seconds via SL with PnL values that don't match their configured thresholds.

The owner manually sold the residual NUTZ via Trojan. No funds were lost, but the incident exposes four live-safety gaps.

---

TICKET_ID: NUTZ-EXIT-RECON-1
END_GOAL_LINK: Live trading safety — Charon must not believe exposure is closed while residual token balance remains in the wallet.
GOAL: Patch the live sell close path so Charon verifies post-sell token balance before marking a position closed. Add residual handling and operator alert.
WHY_NOW: This is a live-money safety bug. Without this fix, every future live SL/TP exit can silently leave residual exposure in the wallet while Charon's DB says the position is closed.
OWNER_VISIBLE_OUTCOME: After patch, when a live sell leaves residual token balance above dust threshold, the position stays open (or moves to a `partial_exit` status), a Telegram alert fires, and the owner can see the mismatch without reading code or DB.
OWNER_PROOF: Unit tests pass showing: (a) zero/dust balance → position closes normally, (b) residual balance → position stays open + alert sent. On VPS after deploy, any future residual exit produces a Telegram message the owner can read.
OWNER_CHECK_STEPS:
  1. Run `npm test -- --run tests/liveSellReconciliation.test.js` — all pass.
  2. After VPS deploy, trigger a test sell (or wait for next live exit) and confirm Telegram alert behavior matches: clean exit = normal close message, residual = explicit residual warning message.

FILES_IN_SCOPE:
  - `src/execution/positions.js` (refreshPosition live sell branch)
  - `src/liveExecutor.js` (fetchLiveTokenBalance already exists, will be used post-sell)
  - `src/execution/router.js` (executeLiveSell — may need to return richer result)
  - `src/telegram/send.js` (new residual alert message)
  - `src/db/positions.js` (if schema change needed for partial_exit status)
  - `src/db/connection.js` (if migration needed)
  - `tests/liveSellReconciliation.test.js` (new test file)

ACCEPTANCE_CRITERIA:
  1. After `executeLiveSell` returns success, `fetchLiveTokenBalance(position.mint)` is called.
  2. If remaining balance > dust threshold (configurable, default 1000 raw units), position is NOT marked `closed`.
  3. Position gets updated `token_amount_raw` to the remaining balance and stays `open` or moves to a new `partial_exit` status (Coder decides smallest safe change).
  4. A Telegram alert is sent to the operator with position ID, mint, expected sell amount, remaining balance, and exit signature.
  5. If remaining balance ≤ dust threshold, position closes normally as before.
  6. The dust threshold is configurable via `settings` table (key: `live_sell_dust_threshold_raw`, default: `1000`).
  7. Unit tests cover both paths with mocked `fetchLiveTokenBalance`.
  8. `node --check` passes on all modified files.

REQUIRED_CHECKS:
  - `node --check src/execution/positions.js`
  - `node --check src/liveExecutor.js`
  - `node --check src/execution/router.js`
  - `npm test -- --run` (full test suite)
  - Manual review: no secrets read, no runtime started, no `.env` accessed.

RISKS:
  - Adding a post-sell RPC call adds latency (~1-3s) to the exit path. Acceptable for safety.
  - If RPC is down/rate-limited, `fetchLiveTokenBalance` returns `null`. Coder must decide: fail-open (close anyway + warn) or fail-closed (keep open + warn). Recommendation: fail-open with explicit Telegram warning that balance check failed.
  - Partial exit status may interact with `monitorPositions` re-triggering SL on the same position. Coder must ensure a position in partial_exit state is not immediately re-sold in the next monitor cycle without a cooldown or explicit re-evaluation.

ESCALATE_IF:
  - Schema change is needed that would break existing position queries across the codebase.
  - The `fetchLiveTokenBalance` function proves unreliable in testing (always null).
  - Coder discovers that Jupiter `/execute` can return Success without actually landing the transaction on-chain (would require a deeper fix involving `confirmTransaction`).

---

TICKET_ID: NUTZ-EXIT-RECON-2
END_GOAL_LINK: Live trading accuracy — SL/TP triggers must reflect the individual position's PnL, not aggregate wallet history.
GOAL: Remove or gate wallet-level Jupiter PnL as the live SL/TP trigger source. Use position-scoped mcap-derived PnL for trigger decisions. Keep wallet PnL as optional diagnostic telemetry only.
WHY_NOW: Position #21 closed SL 11 seconds after entry with entry/exit mcap equal but PnL showing -0.66%, which doesn't match its -30% SL config. This is because wallet-level PnL is aggregate across all historical trades for that mint, not scoped to the current position's entry.
OWNER_VISIBLE_OUTCOME: After patch, live positions trigger SL/TP based on their own entry mcap vs current mcap (same as dry-run). The owner can verify by checking that future live exits show exit_mcap values that actually correspond to the configured SL/TP thresholds relative to entry_mcap.
OWNER_PROOF: Unit tests pass showing position-scoped PnL is used for trigger decisions. Historical comparison: position #21 would NOT have triggered SL at -0.66% with a -30% threshold under the new logic.
OWNER_CHECK_STEPS:
  1. Run `npm test -- --run tests/positionPnlTrigger.test.js` — all pass.
  2. After VPS deploy, next live position exit should show `pnl_percent` consistent with `(exit_mcap / entry_mcap - 1) * 100` within slippage tolerance.

FILES_IN_SCOPE:
  - `src/execution/positions.js` (refreshPosition — remove/gate jupiterPnl override, monitorPositions — stop passing wallet PnL as trigger)
  - `tests/positionPnlTrigger.test.js` (new test file)

ACCEPTANCE_CRITERIA:
  1. `refreshPosition` no longer replaces mcap-derived `pnlPercent` with `jupiterPnl.totalPnlPercentageNative` for SL/TP trigger decisions.
  2. Wallet-level Jupiter PnL may still be fetched and logged (in `dry_run_trades.payload_json` or a telemetry field) but does NOT influence `slHit` or `tpHit` booleans.
  3. Live positions use `(currentMcap / entryMcap - 1) * 100` for SL/TP trigger, same formula as dry-run.
  4. Unit tests verify: a position with entry_mcap=100k, current_mcap=95k, SL=-30% does NOT trigger SL (only -5%). A position with current_mcap=70k DOES trigger SL (-30%).
  5. `node --check` passes on all modified files.

REQUIRED_CHECKS:
  - `node --check src/execution/positions.js`
  - `npm test -- --run`

RISKS:
  - Wallet-level PnL was presumably added to account for actual swap slippage/fees that mcap-derived PnL misses. After this change, live SL/TP triggers will be based on theoretical mcap movement, not realized swap value. This is acceptable because: (a) the current wallet-level PnL is provably wrong for repeated same-mint positions, (b) realized PnL is still computed correctly at exit time from actual `receivedSol`.
  - If a future ticket wants position-scoped realized PnL for triggers (e.g., tracking actual token value via Jupiter price API), that's a separate enhancement.

ESCALATE_IF:
  - Removing wallet PnL from triggers causes a cascade of test failures in unrelated areas.
  - Owner explicitly wants wallet-level PnL kept as a trigger (would need a different fix for the same-mint problem).

---

TICKET_ID: NUTZ-EXIT-RECON-3
END_GOAL_LINK: Live trading safety — prevent duplicate exposure to the same token.
GOAL: Add a same-mint exposure guard that blocks opening a new live position for a mint when an existing open/partial_exit position exists for that mint, or when the wallet holds a non-dust token balance for that mint.
WHY_NOW: NUTZ had positions 19, 21, and 22 for the same mint. Positions 21 and 22 were opened after position 19 was (incorrectly) marked closed. With ticket NUTZ-EXIT-RECON-1 keeping residual positions open, this guard prevents the re-entry that caused compounding confusion.
OWNER_VISIBLE_OUTCOME: After patch, Charon will not buy the same token twice while it already holds exposure. If it tries, the candidate is skipped with a logged reason the owner can see in decision_logs or Telegram.
OWNER_PROOF: Unit tests pass showing: (a) open position for mint X blocks new entry for mint X, (b) wallet balance > dust for mint X blocks new entry for mint X, (c) no open position and zero wallet balance allows entry.
OWNER_CHECK_STEPS:
  1. Run `npm test -- --run tests/sameMintGuard.test.js` — all pass.
  2. After VPS deploy, check `decision_logs` for any `same_mint_blocked` entries (proves the guard is active).

FILES_IN_SCOPE:
  - `src/execution/router.js` (executeLiveBuy — add guard before swap)
  - `src/db/positions.js` (add `hasOpenPositionForMint(mint)` query)
  - `src/liveExecutor.js` (fetchLiveTokenBalance already exists)
  - `src/db/decisions.js` (log blocked entry)
  - `tests/sameMintGuard.test.js` (new test file)

ACCEPTANCE_CRITERIA:
  1. Before executing a live buy, check `hasOpenPositionForMint(mint)` — if true, skip with logged reason.
  2. Before executing a live buy, check `fetchLiveTokenBalance(mint)` — if > dust threshold, skip with logged reason.
  3. Skipped entries are logged to `decision_logs` with action `same_mint_blocked` and reason.
  4. Dry-run positions are NOT affected by this guard (dry-run can still open multiple same-mint positions for backtesting purposes).
  5. Confirmed intent flow (`executeConfirmedIntent`) also respects this guard.
  6. `node --check` passes on all modified files.

REQUIRED_CHECKS:
  - `node --check src/execution/router.js`
  - `node --check src/db/positions.js`
  - `npm test -- --run`

RISKS:
  - The wallet balance check adds an RPC call to the buy path. If RPC is slow/down, it could delay entries. Recommendation: if `fetchLiveTokenBalance` returns null (RPC failure), allow the entry but log a warning.
  - Edge case: if the owner intentionally wants to DCA into the same token, this guard blocks it. For now this is the safe default. A future ticket can add a `allow_same_mint_dca` setting if needed.

ESCALATE_IF:
  - Owner explicitly wants same-mint re-entry allowed in some cases (needs a design discussion).
  - The guard causes false positives due to stale DB state (positions stuck open that should be closed).

---

TICKET_ID: NUTZ-EXIT-RECON-4
END_GOAL_LINK: Operator visibility — the owner can inspect live position health without reading code or raw DB.
GOAL: Add a read-only reconciliation report script that compares live wallet token balances against Charon DB positions and exposes any mismatch.
WHY_NOW: The NUTZ incident was only caught because the owner manually checked Trojan. A reconciliation report would have surfaced the mismatch immediately. This is the owner's primary inspection tool going forward.
OWNER_VISIBLE_OUTCOME: Running `node scripts/reconcile_positions.js` prints a clear table showing each recent live position, its DB status, recorded token amount, current wallet balance, and reconciliation state (matched/residual/missing/unknown).
OWNER_PROOF: Script runs successfully against the VPS DB and produces readable output. Owner can run it anytime via SSH.
OWNER_CHECK_STEPS:
  1. `node --check scripts/reconcile_positions.js` passes.
  2. `node scripts/reconcile_positions.js --help` shows usage.
  3. On VPS: `node scripts/reconcile_positions.js` produces a table with NUTZ positions 19/21/22 showing their current reconciliation state (likely all `matched` now since owner manually sold).

FILES_IN_SCOPE:
  - `scripts/reconcile_positions.js` (new file)
  - `src/liveExecutor.js` (reuse `fetchLiveTokenBalance`)

ACCEPTANCE_CRITERIA:
  1. Script reads `dry_run_positions` where `execution_mode = 'live'` and `closed_at_ms > (now - 24h)` OR `status != 'closed'`.
  2. For each position, fetches current wallet token balance via RPC.
  3. Prints a table with columns: `id | mint | symbol | status | token_amount_raw | wallet_balance | exit_sig | recon_state`.
  4. `recon_state` values: `matched` (closed + zero balance), `residual` (closed + non-zero balance), `open_holding` (open + has balance), `missing_balance` (open + zero balance), `unknown` (RPC failed).
  5. Script does NOT mutate DB. Read-only.
  6. Script accepts `--hours=N` flag to control lookback window (default 24).
  7. Script accepts `--all-open` flag to include all open positions regardless of age.
  8. Exit code 0 if all matched, exit code 1 if any residual/missing found.
  9. `node --check scripts/reconcile_positions.js` passes.

REQUIRED_CHECKS:
  - `node --check scripts/reconcile_positions.js`
  - `node scripts/reconcile_positions.js --dry-run` (if DB available locally) or `node --check` only.

RISKS:
  - RPC rate limits if many positions are checked. Recommendation: pace requests (1 per 200ms).
  - Script needs DB path. Follow existing pattern: `--charon-db=` or `CHARON_DB_PATH` env var, default `./charon.sqlite`.

ESCALATE_IF:
  - Owner wants this to run automatically on a schedule (separate ticket for PM2 cron integration).
  - Owner wants auto-repair (DB mutation) — that requires a separate owner-approved ticket.

---

## Suggested Execution Order

1. **NUTZ-EXIT-RECON-2** (PnL trigger fix) — smallest change, no schema impact, fixes the false SL triggers.
2. **NUTZ-EXIT-RECON-1** (sell reconciliation guard) — core safety fix, may add a status value.
3. **NUTZ-EXIT-RECON-3** (same-mint guard) — depends on #1's residual handling being in place.
4. **NUTZ-EXIT-RECON-4** (reconciliation report) — independent, can be done in parallel with any of the above.

## Safety Boundaries (inherited from project AGENTS.md)

- Do not run live trading, signing, swaps, or Telegram commands during implementation.
- Do not read `.env` or secrets.
- Do not start services or PM2.
- VPS deploy requires separate owner approval after all tickets pass locally.
- DB mutations require owner approval (the reconciliation script is read-only by design).

## Verification Note

The owner can verify the NUTZ incident claim by running on VPS:
```bash
sqlite3 /opt/trading-data/charon.sqlite "SELECT id, mint, status, exit_reason, exit_mcap, token_amount_raw, exit_signature FROM dry_run_positions WHERE mint LIKE 'C9jeb%' ORDER BY id"
```
This should show positions 19, 21, 22 all closed with the evidence described in the handoff.
