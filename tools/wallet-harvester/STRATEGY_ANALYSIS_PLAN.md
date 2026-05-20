# Smart Wallet Strategy Analysis Plan

Created: 2026-05-12
Status: Planning
Location: tools/wallet-harvester (expansion of existing harvester tooling)

## Objective

Reverse-engineer the trading strategies used by the 908+ smart wallets in the
harvester DB. For each wallet, determine:

- Entry strategy: single entry, DCA, scaling in, snipe-at-graduation?
- Exit strategy: single TP, multiple partial TPs, trailing stop, time-based?
- SL behavior: hard stop, no stop (diamond hands), averaging down?
- Position sizing: fixed SOL, fixed USD, percentage of portfolio?
- Token selection: mcap range, age, volume thresholds, sector bias?
- Timing: which technical indicators align with their entries/exits?
- Classification: bot vs. manual, strategy archetype

The deliverable is a per-wallet strategy profile and aggregate statistics that
inform what SL/TP/trailing parameters Charon should use.

## What exists today

### Data already in harvester DB
- 908 wallets with tags (smart_degen, renowned, kol, smart_money, whale, etc.)
- 1337 sightings across 76 tokens (action: buy/sell/hold, amount_usd,
  token_mcap_usd, timestamp)
- Aggregate PnL, win rate, avg buy size per wallet (from GMGN snapshots)

### What's missing for strategy analysis
- **Individual trade history**: actual buy/sell transactions with exact
  timestamps, prices, amounts, tx signatures — the sightings table only has
  point-in-time snapshots from harvester runs, not the full trade log
- **OHLCV price context**: what the chart looked like when they entered/exited
  — needed to compute technical indicators at time of trade
- **Position reconstruction**: grouping buys and sells into coherent positions
  (open -> partial TPs -> close) rather than isolated transactions
- **Multi-entry detection**: did they buy once or scale in across multiple txs?

## Data sources

### 1. Helius Enhanced Transactions API (on-chain trade history)

Helius is already configured in Charon (`HELIUS_API_KEY`). The
`getSignaturesForAddress` + `parseTransaction` endpoints give us:

- Every swap transaction a wallet has made
- Exact token amounts in/out, SOL amounts, timestamps
- Program IDs (Jupiter, Raydium, Pump.fun AMM) to identify swap routes
- Transaction signatures for audit trail

**Rate limits:** Helius free tier allows ~10 req/sec on enhanced APIs. Paid
tier is higher. For 908 wallets with pagination, budget ~30 minutes for a full
historical pull at conservative pacing.

**Alternative:** Jupiter DCA/limit order history via their API if available, but
Helius gives the raw on-chain truth.

### 2. Birdeye BDS OHLCV V3 (price context at trade time)

Already implemented in the lab Birdeye client (`src/lab/birdeye.ts`). The BirdeyeClient
supports:
- `getOhlcvV3(address, type, timeFrom, timeTo)` — candles at 1m, 5m, 15m, 1h,
  4h, 1d granularity
- `getTokenTransactions(address)` — token-level swap feed
- CU-capped, batch_only state, retry on 429

For strategy analysis we need OHLCV at the time of each trade so we can compute
indicators. Budget: ~1 CU per OHLCV call. With 100K daily cap and ~5K-10K
trades to contextualize, this is well within limits.

### 3. Jupiter PnL API (aggregate wallet performance)

Already used in harvester enrichment. Gives per-wallet, per-token PnL without
needing to reconstruct from raw transactions. Useful as a cross-check against
our reconstructed positions.

### 4. GMGN wallet activity (supplementary)

The harvester already pulls GMGN data. The holder/trader endpoints give
point-in-time snapshots. Not granular enough for strategy analysis but useful
for cross-referencing.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Strategy Analysis Pipeline                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  S1: Trade History Collector                                    │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐      │
│  │ Helius API   │───>│ Raw trades   │───>│ trades table │      │
│  │ (per wallet) │    │ parser       │    │ (harvester   │      │
│  └──────────────┘    └──────────────┘    │  DB)         │      │
│                                          └──────┬───────┘      │
│                                                 │               │
│  S2: Position Reconstructor                     │               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────┴───────┐      │
│  │ Group trades │───>│ Build        │───>│ positions    │      │
│  │ by wallet +  │    │ positions    │    │ table        │      │
│  │ token        │    │ (open/close) │    └──────┬───────┘      │
│  └──────────────┘    └──────────────┘           │               │
│                                                 │               │
│  S3: OHLCV Context Enrichment                   │               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────┴───────┐      │
│  │ Birdeye BDS  │───>│ Indicator    │───>│ trade_context│      │
│  │ OHLCV V3     │    │ calculator   │    │ table        │      │
│  └──────────────┘    └──────────────┘    └──────┬───────┘      │
│                                                 │               │
│  S4: Strategy Classifier                        │               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────┴───────┐      │
│  │ Pattern      │───>│ Archetype    │───>│ wallet_      │      │
│  │ detector     │    │ classifier   │    │ strategies   │      │
│  └──────────────┘    └──────────────┘    │ table        │      │
│                                          └──────┬───────┘      │
│                                                 │               │
│  S5: Report Generator                           │               │
│  ┌──────────────┐                        ┌──────┴───────┐      │
│  │ Aggregates   │───────────────────────>│ reports/     │      │
│  │ + per-wallet │                        │ *.csv *.json │      │
│  └──────────────┘                        └──────────────┘      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Milestones

### S1 — Trade history collector

**Goal:** Pull the complete swap history for every wallet from on-chain data.

**New file:** `src/tradeHistory.ts`

**What:**
- For each wallet in the harvester DB:
  - Call Helius `getSignaturesForAddress` to get all transaction signatures
  - Filter to swap-related programs (Jupiter, Raydium, Pump.fun AMM, Orca)
  - Parse each transaction to extract: token mint, side (buy/sell), token
    amount, SOL amount, USD value (from price at time), timestamp, program
  - Paginate until we hit a configurable lookback window (default: 30 days)
- Store in new `trades` table:

```sql
CREATE TABLE IF NOT EXISTS trades (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address  TEXT NOT NULL,
  signature       TEXT NOT NULL UNIQUE,
  mint            TEXT NOT NULL,
  side            TEXT NOT NULL,          -- 'buy' | 'sell'
  token_amount    REAL NOT NULL,
  sol_amount      REAL NOT NULL,
  usd_amount      REAL,
  price_usd       REAL,
  price_sol       REAL,
  timestamp       INTEGER NOT NULL,       -- unix seconds
  program         TEXT,                   -- 'jupiter' | 'raydium' | 'pump' | ...
  slot            INTEGER,
  collected_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_wallet ON trades(wallet_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_mint ON trades(mint, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_wallet_mint ON trades(wallet_address, mint, timestamp);
```

**Rate limiting:**
- Helius: 2 req/sec with backoff (conservative, avoids 429s)
- For 908 wallets, ~20-30 signatures per wallet on average = ~20K-30K
  signature fetches + transaction parses
- Estimated runtime: 30-60 minutes for full historical pull
- Incremental mode: on re-run, only fetch signatures newer than last
  `collected_at_ms` per wallet

**Best practices:**
- Store raw transaction data (signature, slot) so you can re-parse later if
  the parser improves
- Normalize USD amounts using SOL price at the time of trade, not current price
- Handle failed/reverted transactions (Helius marks these)
- Skip non-swap transactions (transfers, staking, NFT, etc.)

**Depends on:** Helius API key configured (already in Charon .env).

---

### S2 — Position reconstructor

**Goal:** Group individual trades into coherent positions: a position starts
with a buy, may have additional buys (DCA/scaling), partial sells (partial TP),
and ends when the wallet's balance for that token reaches zero or near-zero.

**New file:** `src/positionBuilder.ts`

**What:**
- For each (wallet, mint) pair in the trades table:
  - Sort trades by timestamp ascending
  - Walk forward, building position state:
    - First buy opens a position
    - Subsequent buys increase position size (flag as DCA/scale-in)
    - Sells reduce position size (flag as partial TP or full exit)
    - Position closes when cumulative sells >= cumulative buys (within tolerance)
    - A wallet can have multiple sequential positions on the same token
  - For each position compute:
    - Entry: avg entry price (volume-weighted), total SOL in, number of buys
    - Exit: avg exit price, total SOL out, number of sells
    - PnL: realized SOL, realized USD, realized percentage
    - Timing: hold duration, time between entries, time between exits
    - Strategy flags (see below)

**Position schema:**

```sql
CREATE TABLE IF NOT EXISTS positions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address    TEXT NOT NULL,
  mint              TEXT NOT NULL,
  status            TEXT NOT NULL,        -- 'open' | 'closed'
  -- Entry metrics
  entry_count       INTEGER NOT NULL,     -- number of buy txs
  first_entry_ts    INTEGER NOT NULL,     -- unix seconds
  last_entry_ts     INTEGER NOT NULL,
  avg_entry_price   REAL,
  total_sol_in      REAL NOT NULL,
  total_token_in    REAL NOT NULL,
  entry_mcap_usd    REAL,                 -- mcap at first entry
  -- Exit metrics
  exit_count        INTEGER NOT NULL,     -- number of sell txs
  first_exit_ts     INTEGER,
  last_exit_ts      INTEGER,
  avg_exit_price    REAL,
  total_sol_out     REAL NOT NULL,
  total_token_out   REAL NOT NULL,
  -- PnL
  realized_sol      REAL,
  realized_usd      REAL,
  realized_pct      REAL,
  -- Timing
  hold_duration_s   INTEGER,              -- last_exit - first_entry
  entry_spread_s    INTEGER,              -- last_entry - first_entry (0 = single entry)
  exit_spread_s     INTEGER,              -- last_exit - first_exit (0 = single exit)
  -- Strategy flags
  is_dca            INTEGER NOT NULL DEFAULT 0,  -- entry_count > 1
  is_scale_in       INTEGER NOT NULL DEFAULT 0,  -- buys at increasing prices
  is_partial_tp     INTEGER NOT NULL DEFAULT 0,  -- exit_count > 1
  is_full_exit      INTEGER NOT NULL DEFAULT 0,  -- sold everything
  is_trailing_like  INTEGER NOT NULL DEFAULT 0,  -- exits after price drop from peak
  -- Metadata
  trade_ids_json    TEXT NOT NULL,        -- array of trade IDs in this position
  built_at_ms       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_positions_wallet ON positions(wallet_address);
CREATE INDEX IF NOT EXISTS idx_positions_mint ON positions(mint);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
```

**Strategy flag detection logic:**
- `is_dca`: entry_count > 1 AND buys at roughly the same price (within 20%)
- `is_scale_in`: entry_count > 1 AND later buys at higher prices (conviction
  scaling)
- `is_partial_tp`: exit_count > 1 (took profit in chunks)
- `is_trailing_like`: the exit happened after price dropped X% from the
  position's high-water mark (computed from OHLCV in S3)
- `is_full_exit`: total_token_out >= 95% of total_token_in

**Best practices:**
- Use a tolerance for "fully closed" (95% sold, not 100%) because of rounding,
  fees, and dust
- Handle the case where a wallet sells more than it bought on-chain (tokens
  received via transfer, airdrop, or LP)
- Separate distinct position cycles: if a wallet buys, fully sells, then buys
  again later, that's two positions
- Store trade_ids_json so every position is auditable back to raw transactions

**Depends on:** S1.

---

### S3 — OHLCV context enrichment

**Goal:** For each trade, pull OHLCV candles around the trade timestamp and
compute technical indicators. This tells us what the chart looked like when the
wallet decided to enter or exit.

**New file:** `src/tradeContext.ts`

**What:**
- For each trade (or at least each position entry/exit):
  - Call Birdeye BDS OHLCV V3 for the token mint
  - Pull candles surrounding the trade: 60 candles before and 30 after at
    the appropriate timeframe (5m for recent, 1h for older)
  - Compute indicators at the candle containing the trade timestamp:

**Indicators to compute:**
- **RSI(14)** — momentum; did they enter oversold or overbought?
- **VWAP** — did they enter above or below VWAP?
- **Bollinger Bands(20,2)** — entry near lower band = dip buy, upper = chase
- **Volume ratio** — current volume vs. 20-period average (spike detection)
- **EMA(9) vs EMA(21) cross** — trend direction at entry
- **Distance from recent high/low** — are they buying the dip or chasing ATH?
- **ATR(14)** — volatility context for SL sizing
- **Price change % over last 5/15/60 candles** — momentum at entry

**Trade context schema:**

```sql
CREATE TABLE IF NOT EXISTS trade_context (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id        INTEGER NOT NULL REFERENCES trades(id),
  position_id     INTEGER REFERENCES positions(id),
  mint            TEXT NOT NULL,
  -- Price context
  candle_open     REAL,
  candle_high     REAL,
  candle_low      REAL,
  candle_close    REAL,
  candle_volume   REAL,
  -- Indicators at trade time
  rsi_14          REAL,
  vwap            REAL,
  bb_upper        REAL,
  bb_middle       REAL,
  bb_lower        REAL,
  bb_position     REAL,           -- 0.0 = at lower band, 1.0 = at upper band
  volume_ratio    REAL,           -- current / 20-period avg
  ema_9           REAL,
  ema_21          REAL,
  ema_trend       TEXT,           -- 'bullish' | 'bearish' | 'crossing'
  distance_from_high_pct REAL,    -- from 60-candle high
  distance_from_low_pct  REAL,    -- from 60-candle low
  atr_14          REAL,
  momentum_5      REAL,           -- % change over 5 candles
  momentum_15     REAL,
  momentum_60     REAL,
  -- Metadata
  timeframe       TEXT NOT NULL,  -- '5m' | '1h'
  candles_used    INTEGER,
  computed_at_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tc_trade ON trade_context(trade_id);
CREATE INDEX IF NOT EXISTS idx_tc_position ON trade_context(position_id);
```

**Birdeye CU budget:**
- Each OHLCV call = 1 CU
- Batch by (mint, timeframe) — one OHLCV pull covers many trades on the same
  token if they're within the candle window
- For ~76 tokens, need ~76-150 OHLCV calls (multiple timeframes) = well within
  100K daily cap
- Cache OHLCV data locally: if two wallets traded the same token in the same
  window, reuse the candles

**Indicator implementation:**
- Implement indicators as pure functions over candle arrays — no external
  library dependency for the core set (RSI, EMA, BB, ATR are all simple)
- Keep the indicator module standalone and testable
- Each function takes candle[] and returns a number or null

**Best practices:**
- Use the right timeframe for the trade's context: 5m candles for trades
  within the last 7 days, 1h for older trades (Birdeye may not have 5m
  data far back)
- Handle missing candle data gracefully (new tokens may not have enough
  history for 14-period RSI)
- Cache aggressively: OHLCV data doesn't change after the candle closes
- Indicator values should be stored, not recomputed — they're tied to a
  specific candle at a specific time

**Depends on:** S1, S2, Birdeye API key configured.

---

### S4 — Strategy classifier

**Goal:** Using the reconstructed positions and indicator context, classify
each wallet into strategy archetypes and extract the parameters they use.

**New file:** `src/strategyClassifier.ts`

**What:**

#### Per-position classification

For each closed position, classify:

| Pattern | Detection logic |
|---------|----------------|
| Single entry, single exit | entry_count=1, exit_count=1 |
| Single entry, multiple TP | entry_count=1, exit_count>1 |
| DCA entry, single exit | entry_count>1, prices similar, single exit |
| Scale-in, single exit | entry_count>1, prices ascending |
| DCA entry, multiple TP | entry_count>1, exit_count>1 |
| Snipe-at-graduation | entry within 60s of token graduating from Pump |
| Trailing exit | exit follows drop from peak (needs OHLCV high-water) |
| Hard SL | exit at roughly fixed % below entry |
| Time-based exit | exit after consistent hold duration regardless of price |
| Diamond hands | no exit (position still open after significant time) |

#### Entry condition analysis

Using trade_context indicators, cluster entries by:

- RSI at entry: oversold (<30), neutral (30-70), overbought (>70)
- BB position: lower band (dip buy), middle, upper band (momentum)
- Volume spike: was volume >2x average at entry?
- EMA trend: buying in bullish or bearish trend?
- Distance from high: buying the dip (>20% below high) or chasing?

#### Exit condition analysis

For each exit, determine what triggered it:

- **Fixed TP:** exits cluster at similar % above entry (e.g., always sells
  at +50%, +100%)
- **Trailing TP:** exit price is below a recent high by a consistent
  percentage (e.g., always exits after 20% drawdown from peak)
- **Fixed SL:** exits cluster at similar % below entry
- **Time-based:** hold duration is consistent regardless of PnL
- **Panic exit:** exit during sharp volume spike + price drop

#### Per-wallet strategy profile

Aggregate across all positions for a wallet:

```sql
CREATE TABLE IF NOT EXISTS wallet_strategies (
  wallet_address      TEXT PRIMARY KEY,
  -- Sample size
  total_positions     INTEGER NOT NULL,
  closed_positions    INTEGER NOT NULL,
  open_positions      INTEGER NOT NULL,
  -- Entry style
  single_entry_pct    REAL,       -- % of positions with 1 buy
  dca_pct             REAL,       -- % with multiple buys at similar prices
  scale_in_pct        REAL,       -- % with ascending buy prices
  avg_entries_per_pos REAL,
  -- Exit style
  single_exit_pct     REAL,       -- % with 1 sell
  partial_tp_pct      REAL,       -- % with multiple sells
  trailing_exit_pct   REAL,       -- % where exit follows peak drawdown
  avg_exits_per_pos   REAL,
  -- TP/SL parameters (median across positions)
  median_tp_pct       REAL,       -- median realized gain on winners
  p25_tp_pct          REAL,
  p75_tp_pct          REAL,
  median_sl_pct       REAL,       -- median realized loss on losers
  p25_sl_pct          REAL,
  p75_sl_pct          REAL,
  -- Trailing detection
  trailing_detected   INTEGER NOT NULL DEFAULT 0,
  trailing_drop_pct   REAL,       -- estimated trailing % (median peak-to-exit drop)
  -- Timing
  median_hold_s       INTEGER,
  avg_hold_s          INTEGER,
  median_entry_hour   INTEGER,    -- UTC hour they tend to trade
  -- Token selection
  median_entry_mcap   REAL,
  avg_entry_mcap      REAL,
  pct_under_200k      REAL,       -- % of positions in <200K mcap tokens
  -- Performance
  win_rate            REAL,
  avg_pnl_pct         REAL,
  median_pnl_pct      REAL,
  sharpe_like         REAL,       -- mean(pnl) / stddev(pnl) across positions
  -- Classification
  archetype           TEXT,       -- 'sniper_bot', 'dca_trader', 'momentum_scalper', etc.
  is_likely_bot       INTEGER NOT NULL DEFAULT 0,
  confidence          REAL,
  -- Metadata
  analyzed_at_ms      INTEGER NOT NULL,
  analysis_version    INTEGER NOT NULL DEFAULT 1
);
```

#### Bot detection heuristics

| Signal | Bot indicator |
|--------|--------------|
| Entry within <5s of token event (graduation, listing) | Likely bot |
| Consistent sub-second entry timing | Automated |
| Exact same position size every trade | Automated |
| Trading 24/7 with no time-of-day pattern | Automated |
| Very high trade frequency (>20 positions/day) | Automated |
| Consistent SL/TP percentages (low variance) | Scripted strategy |
| Human-like time-of-day pattern, variable sizes | Manual |

#### Archetype definitions

| Archetype | Entry | Exit | Hold time | Mcap |
|-----------|-------|------|-----------|------|
| `sniper_bot` | Single, <5s after event | Single TP or trailing | <1h | <100K |
| `dca_accumulator` | Multiple buys over hours/days | Partial TPs | days | any |
| `momentum_scalper` | Single, on volume spike | Quick TP <30min | <1h | <500K |
| `dip_buyer` | Single, RSI<30 or BB lower | TP at mean reversion | hours | any |
| `trend_follower` | EMA cross / breakout | Trailing stop | hours-days | any |
| `copy_trader` | Entries cluster with other known wallets | Varies | varies | any |
| `diamond_hands` | Any | Rarely sells / never | weeks+ | any |
| `pump_dumper` | Very early, insider-like timing | Quick full exit | <15min | <50K |

**Depends on:** S2, S3.

---

### S5 — Report generator

**Goal:** Produce actionable reports for the owner and feed back into Charon's
configuration.

**New file:** `src/strategyReport.ts`

**Reports:**

#### 1. Per-wallet strategy card (JSON + CSV)
For each wallet: archetype, entry/exit style, median TP/SL, hold time,
performance, bot probability, sample size.

#### 2. Aggregate strategy distribution
How many wallets use each archetype? What's the distribution of TP/SL
parameters across all profitable wallets?

#### 3. Optimal SL/TP analysis
Across all profitable closed positions in the target mcap range (<200K):
- What TP % captures the most value? (histogram of exit gains)
- What SL % avoids the most damage? (histogram of exit losses)
- Is trailing TP better than fixed TP? (compare realized PnL)
- What trailing % is most common among winners?
- Suggested Charon defaults with confidence intervals

#### 4. Entry indicator analysis
Which indicator conditions at entry correlate with profitable outcomes?
- RSI range at entry for winners vs. losers
- Volume ratio at entry for winners vs. losers
- BB position at entry for winners vs. losers
- EMA trend at entry for winners vs. losers

#### 5. Anomaly report
Wallets that don't fit any archetype, or that show copy-trading patterns
(entries within seconds of each other on the same token).

**Output:** `reports/strategy-analysis-*.json` and `reports/strategy-analysis-*.csv`

**Depends on:** S4.

---

## Dependency chain

```
S1 (trade history from Helius)
 |
 +-- S2 (position reconstruction)
 |    |
 |    +-- S3 (OHLCV + indicators from Birdeye BDS)
 |         |
 |         +-- S4 (strategy classifier)
 |              |
 |              +-- S5 (reports)
```

S1 and S3 both make API calls but to different providers (Helius vs. Birdeye),
so the OHLCV pulls in S3 can start as soon as S1 has produced some trades,
even before S1 finishes all wallets.

## Implementation best practices

### Rate limiting
- Helius: 2 req/sec with exponential backoff on 429, cap at 60s
- Birdeye: respect CU caps already in BirdeyeClient, batch_only state
- Jupiter PnL: 1 req/sec (reuse pattern from harvester)
- All API calls go through a shared rate-limiter per provider
- Log every 429 and adjust pacing dynamically

### Incremental processing
- S1 stores `collected_at_ms` per wallet so re-runs only fetch new trades
- S2 can rebuild positions for a single wallet without re-running S1
- S3 caches OHLCV data by (mint, timeframe, time_range) — immutable after
  candle close
- S4 can re-classify a single wallet without recomputing all

### Data integrity
- Every table has audit columns (collected_at_ms, built_at_ms, analyzed_at_ms)
- Positions link back to trade IDs, trade context links back to both
- Raw Helius response can optionally be stored for re-parsing (large, consider
  a separate archive table or skip for now)

### Testing
- Each stage gets a check script (`npm run harvest:check-trades`, etc.)
- Use fixture data for indicator calculations (known RSI, known BB values)
- Position reconstructor needs edge-case tests: partial fills, transfers in,
  dust amounts, re-entry after full exit

### Indicator implementation
- Pure functions: `rsi(closes: number[], period: number): number | null`
- No external TA library — the indicators needed are simple enough to implement
  correctly in <200 lines total, and it avoids a dependency that may compute
  differently from what you expect
- If you later want more exotic indicators (Ichimoku, OBV, etc.), add them as
  new pure functions without changing the core

### Storage
- All new tables go in the existing `harvester.db` — this is the research
  database, not Charon's runtime DB
- The trades table will be the largest: estimate ~50K-200K rows for 908 wallets
  × 30 days. SQLite handles this fine with proper indexes
- OHLCV cache can go in a separate `ohlcv_cache.db` if size becomes an issue
  (candle data is bulky), but start in the same DB

## Files

| File | New/Existing | Stage |
|------|-------------|-------|
| `src/tradeHistory.ts` | New | S1 |
| `src/positionBuilder.ts` | New | S2 |
| `src/tradeContext.ts` | New | S3 |
| `src/indicators.ts` | New | S3 |
| `src/strategyClassifier.ts` | New | S4 |
| `src/strategyReport.ts` | New | S5 |
| `src/store.ts` | Existing, extend with new tables | S1-S4 |
| `src/birdeye.ts` | Reuse from lab Birdeye client or copy | S3 |

## External dependencies

| Provider | Stage | Rate limit | Cost |
|----------|-------|-----------|------|
| Helius Enhanced Transactions | S1 | 2 req/sec | Free tier or existing paid |
| Birdeye BDS OHLCV V3 | S3 | 100K CU/day | Existing paid key |
| Jupiter PnL API | Cross-check | 1 req/sec | Free |

## Open questions

1. **Lookback window:** 30 days is a good starting point, but some strategies
   only become visible over longer windows. Consider 90 days for wallets that
   trade infrequently.

2. **Copy-trader detection:** Detecting wallets that enter within seconds of
   each other requires cross-wallet analysis in S4. This is computationally
   heavier — consider deferring to S4b if S4 scope grows.

3. **Token lifecycle context:** Some strategies only make sense in the context
   of token events (graduation, listing, whale entry). Should we pull token
   event timelines and correlate? This adds significant complexity.

4. **LLM-assisted classification:** After S4 produces initial archetypes, an
   LLM pass (using Charon's MiniMax M2.7) could review edge cases and refine
   classifications. Defer to a future milestone.

5. **How to feed results back to Charon:** The simplest path is updating the
   wallet pipeline plan (WALLET_PIPELINE_PLAN.md) M2a to include strategy
   profile data in the LLM reviewer's context. The optimal SL/TP findings
   from S5 can directly update Charon's strategy config.
