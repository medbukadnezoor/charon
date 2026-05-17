# Planner Handoff: Live Exit Reconciliation Bug

## Objective

Plan the proper patch for Charon live-position accounting after the NUTZ incident. The owner observed NUTZ still present in the live wallet/Trojan after Charon marked the position closed via `SL`.

This is a live-trading safety issue: Charon can believe exposure is closed while residual token balance remains in the wallet, and it can later re-enter the same token while prior exposure is not fully reconciled.

## Safety Boundaries

- Do not trade, sign, swap, or send Telegram commands.
- Do not read or print `.env`, private keys, API keys, provider keys, Telegram session contents, or raw secrets.
- DB inspection must be read-only unless the owner explicitly approves a migration/repair script.
- No direct manual SQLite mutation for live state repair without a separate owner-approved plan.
- Treat Charon live runtime as sensitive; prefer read-only DB/log/RPC checks and patch planning first.

## Confirmed Incident Evidence

Owner-provided Trojan CA for NUTZ:

```text
C9jebncmq16vegznKqpEWBWk1NaLnYBoXxMQqvbBpump
```

Trojan screenshot/export filename also contained:

```text
BU6Hp6KE7krATMRrNYgVPv6RmaA4oUDjTB1q2CAJtNPX
```

That second address is the Pump AMM pool address, not the token mint. Charon correctly tracked the token mint `C9jeb...pump`.

VPS DB showed three live NUTZ positions for the same mint:

```text
id 19: opened 2026-05-15T13:41:34Z, closed 2026-05-15T13:48:49Z, exit SL, exit mcap 94,181.21
id 21: opened 2026-05-15T13:51:38Z, closed 2026-05-15T13:51:49Z, exit SL
id 22: opened 2026-05-15T13:55:22Z, closed 2026-05-15T13:55:29Z, exit SL
```

Position 19 matching the owner’s “SL at 94.2k”:

```text
mint: C9jebncmq16vegznKqpEWBWk1NaLnYBoXxMQqvbBpump
entry_mcap: 116,939.96
exit_mcap: 94,181.21
entry_signature: 5GAwmd...
exit_signature: 2WXMm6...
token_amount_raw: 34344930082
recorded received SOL: 0.024796164
Jupiter execute status in DB payload: Success
```

Public RPC check after the first recorded sell showed the wallet still had NUTZ balance in the post-token balances:

```text
owner: 39cFva36qiu9FXn7Ngu2Yg7YeHUvimajCZ5cRohxT7Vf
post sell balance after 2WXMm6...: 32132.228742 NUTZ
```

Later public RPC check after owner’s manual Trojan cleanup showed the token account amount was `0`, so the immediate exposure was cleaned up manually by owner.

## Suspected Root Causes

1. Charon closes live positions immediately after Jupiter `/execute` returns a signature/status success.
   - Relevant code: `src/execution/positions.js`
   - Live close path starts around `refreshPosition()` live branch.
   - It calls `executeLiveSell(position, exitReason)`, then updates `dry_run_positions.status = 'closed'` without verifying final token balance.

2. Live exit success is based on Jupiter response, not independent wallet reconciliation.
   - Relevant code: `src/liveExecutor.js`
   - `executeJupiterSwap()` accepts Jupiter execute response when `status === Success` and signature exists.
   - No `confirmTransaction`, parsed transaction validation, or post-sell token-balance check is performed before DB close.

3. Repeated same-token entries are allowed after a DB position is marked closed, even if the wallet still holds residual balance for the same mint.
   - NUTZ had positions 19, 21, and 22 for the same mint.
   - The chart showing multiple buys/sells is consistent with Charon DB evidence.

4. Live SL/TP trigger may be using wallet-level Jupiter PnL for a single DB position.
   - Relevant code: `src/execution/positions.js`
   - `monitorPositions()` fetches `fetchJupiterWalletPnl(pubkey)` and passes `walletPnlData[position.mint]?.pnl` into `refreshPosition()`.
   - `refreshPosition()` replaces position-level mcap-derived PnL with `jupiterPnl.totalPnlPercentageNative` when present.
   - This is unsafe for repeated same-token positions or residual balances because wallet-level PnL is aggregate/stale across the whole wallet-mint history.
   - Position 21 closed `SL` roughly 11 seconds after entry with entry and exit mcap equal, but final PnL `-0.66%`, which does not match its configured `-30%` SL. That points to a trigger/accounting mismatch.

## Files To Read First

- `src/execution/positions.js`
- `src/execution/router.js`
- `src/liveExecutor.js`
- `src/db/positions.js`
- `src/db/connection.js`
- `src/telegram/send.js`
- `src/telegram/commands.js`

Useful DB tables for read-only verification:

- `dry_run_positions`
- `dry_run_trades`
- `decision_logs`
- `candidates`
- `llm_decisions`

## Recommended Planner Output

Produce an Architect-ready patch plan with bounded tickets. The patch should not be a workaround and should preserve live safety.

Required design decisions:

1. Live sell confirmation model
   - After Jupiter execute returns a signature, confirm the transaction against RPC.
   - Fetch live token balance for the sold mint.
   - Decide dust threshold in raw amount or ui amount.
   - Only close the DB position when remaining token balance is zero or under dust.

2. Residual state model
   - If token balance remains after a sell, do not mark the position fully closed.
   - Options:
     - keep `status='open'` and update `token_amount_raw` to remaining balance
     - or add a new status such as `residual_exit_pending`
   - Planner should choose the smallest safe schema change.
   - Send Telegram alert when residual remains.

3. Same-mint exposure guard
   - Prevent opening a new live position for a mint if any open/residual position exists for that mint.
   - Also consider checking live wallet token balance before re-entry, because DB may be stale.

4. PnL trigger source
   - Stop using wallet-level Jupiter PnL as the primary SL/TP trigger for a Charon position.
   - Use position entry mcap/price versus current mcap/price for trigger decisions.
   - Keep wallet-level PnL only as diagnostic telemetry unless proven position-scoped.

5. Live position reconciliation command/report
   - Add a read-only command/script that compares open/recent closed live positions with current wallet token balances.
   - It should report:
     - DB position id
     - mint/symbol
     - DB status
     - token_amount_raw
     - current wallet balance
     - exit signature if present
     - reconciliation state: matched, residual, missing balance, unknown
   - Do not auto-mutate DB.

6. Tests
   - Unit-test live sell close behavior with mocked `executeLiveSell` and mocked `fetchLiveTokenBalance`.
   - Test residual balance does not close the position.
   - Test zero/dust balance closes the position.
   - Test wallet-level PnL does not trigger SL/TP for live positions unless explicitly enabled and position-scoped.
   - Test same-mint guard blocks re-entry when open/residual exposure exists.

## Suggested Ticket Split

### Ticket 1: Live Sell Reconciliation Guard

Patch `refreshPosition()` live sell branch so it verifies post-sell token balance before closing. Add residual handling and Telegram/operator alert.

### Ticket 2: Position-Scoped PnL Trigger

Remove or gate wallet-level Jupiter PnL as a live SL/TP trigger. Preserve it as telemetry only unless the data is proven position-scoped.

### Ticket 3: Same-Mint Exposure Guard

Prevent duplicate live entries for the same mint while DB or wallet shows active/residual exposure.

### Ticket 4: Reconciliation Report

Add a read-only script/operator command to compare live wallet balances against Charon DB positions and expose residual/closed mismatch.

## Verification Checklist

Before patch:

```bash
ssh moonbags 'cd ~/charon && node <read-only db/RPC inspection>'
```

Expected historical evidence:

```text
NUTZ positions 19/21/22 exist as closed live positions.
Position 19 exit signature is 2WXMm6...
Position 19 exit mcap is about 94.2k.
Owner manually sold remaining NUTZ later, so current live wallet token balance may be 0.
```

After patch, verify locally with tests first. VPS deploy/restart requires owner approval because it touches live runtime behavior.

## Open Caveats

- The exact first NUTZ buy signature in one quick public-RPC check was mistyped during ad hoc status lookup; use DB values as source of truth and re-query carefully if needed.
- Public Solana RPC rate-limited parsed transaction calls during investigation. A production verifier should use the configured RPC endpoint without printing credentials.
- Owner already manually sold residual NUTZ in Trojan; do not assume current live balance still reproduces the incident.
