# Re-Entry Rule — Planning Artifact

Status: ON HOLD — implement after fee-claim secondary path is live and validated.

## Problem

15/75 runner tokens (20%) hit the -60% SL before reaching +200% TP.
These are NOT pure losers — every single one eventually ran to 3x+.
They are timing-error entries: screened at a local top, dumped immediately,
then recovered hours/days later.

Key stats from dip depth analysis:
- Median drawdown before recovery: 73.2%
- Average drawdown: 76.5%
- 12/15 hit SL in 0 minutes (same signal batch — entered at local top)
- sl_to_tp recovery time: 64min to 8231min (median ~519min / ~8.5h)

Top missed peaks from SL-first cases:
- 5gsDMgG3: 1241k peak (dd=68.2%, sl_to_tp=2168min)
- CvXyWJRq: 1231k peak (dd=87.1%, sl_to_tp=7570min)
- 25JUPL6k: 817k peak (dd=96.6%, sl_to_tp=987min)
- UitvQfHb: 536k peak (dd=73.2%, sl_to_tp=519min)
- 6MipUvJW: 518k peak (dd=62.0%, sl_to_tp=64min)

## Why Not Just Widen SL?

Widening SL to -80% would save 11/15 cases but requires holding through
70-96% drawdowns for hours/days. That's a different risk profile entirely
and would hurt the 60/75 clean runners (median 2.6% drawdown) by keeping
capital locked in underwater positions.

## Proposed Solution: Re-Entry Rule

When a position hits SL, instead of forgetting the mint:
1. Store the stopped-out mint in a `reentry_watchlist` table
2. Monitor signal_events for the mint for up to 24h
3. If the mint reappears at >= entry_mcap (recovery signal), re-evaluate
4. Run OHLCV entry confirmation (existing gate) before re-entering
5. Re-enter with same TP/SL parameters
6. Max 1 re-entry per mint per 24h window

## Architecture

### New table: `reentry_watchlist`
```sql
CREATE TABLE reentry_watchlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  original_position_id INTEGER NOT NULL,
  entry_mcap REAL NOT NULL,
  sl_mcap REAL NOT NULL,
  stopped_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,   -- stopped_at_ms + 86400000 (24h)
  reentry_triggered INTEGER DEFAULT 0,
  reentry_position_id INTEGER,
  created_at_ms INTEGER NOT NULL
);
```

### Flow
```
Position hits SL
  → if reentry_enabled AND reentry_checks < max_reentries
    → INSERT INTO reentry_watchlist (mint, entry_mcap, expires_at_ms)
    → continue normal SL exit

Signal pipeline (processCandidateFromSignals)
  → check if mint is in active reentry_watchlist
  → if yes AND current_mcap >= original_entry_mcap
    → run OHLCV entry confirmation
    → if confirmed → open new position (flagged as reentry)
    → mark reentry_watchlist.reentry_triggered = 1
```

### Config params (add to sniper strategy config_json)
```javascript
reentry_enabled: true,
reentry_window_ms: 86400000,    // 24h watch window
reentry_min_mcap_recovery: 1.0, // must recover to >= entry mcap
reentry_max_per_mint: 1,        // only re-enter once per mint
```

## Files to Change

| File | Change |
|------|--------|
| `src/db/connection.js` | Add reentry_watchlist table |
| `src/execution/positions.js` | On SL exit, insert into reentry_watchlist |
| `src/pipeline/orchestrator.js` | Check reentry_watchlist in processCandidateFromSignals |
| `src/db/reentry.js` | New module: CRUD for reentry_watchlist |
| `scripts/deploy_runner_capture_config.js` | Add reentry config params |

## Expected Recovery

Based on sl_to_tp data:
- 6MipUvJW: 64min recovery → likely caught in 24h window
- D7JzuyEn: 82min recovery → likely caught
- 3y3X6Bk6: 105min recovery → likely caught
- 4J3PB871: 117min recovery → likely caught
- 28Q3ToLk: 530min recovery → likely caught
- UitvQfHb: 519min recovery → likely caught
- 67ScNH8s: 458min recovery → likely caught
- 25JUPL6k: 987min recovery → likely caught
- 5gsDMgG3: 2168min recovery → likely caught
- HnXDnwTa: 2558min recovery → borderline (42.6h > 24h window)
- F3UfckxL: 8231min recovery → outside 24h window
- CvXyWJRq: 7570min recovery → outside 24h window

Estimated 8-10 of 15 SL-first cases recoverable within 24h window.

## Notes

- The OHLCV entry confirmation gate (already live) will filter re-entries
  that are still at a local top — this is the key safety mechanism.
- Re-entries should be flagged in Telegram notifications.
- Track re-entry outcomes separately in decision_logs for analysis.
- Consider: should re-entries bypass the LLM (rule-based) or go through LLM?
  Recommendation: bypass LLM for re-entries (the original LLM already approved
  the mint; re-entry is a timing correction, not a new decision).

## Prerequisites

- Fee-claim secondary path live and validated (current work)
- At least 2 weeks of live data with new TP/SL/soft-cutoff parameters
- Owner approval for re-entry logic (new trading behavior)
