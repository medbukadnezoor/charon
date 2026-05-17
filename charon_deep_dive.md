# Charon — Plain English Reference

---

## What Charon actually does

Charon watches Pump.fun tokens in real time. When a token looks interesting, it gathers data about it, runs it through a series of filters, hands the best candidates to an AI for a final pick, and then either paper-trades or executes a real buy — depending on your mode.

The whole thing runs in 5 stages:

```
1. WATCH    — listen for signals (fee claims, trending, graduated)
2. GATHER   — pull data on the token from 5 sources
3. FILTER   — kill it if it fails any hard rule
4. AI PICK  — LLM picks the single best token from the queue
5. TRADE    — dry-run paper trade, ask for approval, or buy live
```

After a position is open, Charon monitors it every 10 seconds and closes it automatically when TP, SL, or trailing stop is hit.

---

## Stage 1 — Watching for signals

Charon has 3 eyes:

### Eye 1: Fee Claims (real-time, instant)
Charon is connected to the Solana blockchain via WebSocket. It watches every Pump.fun transaction and specifically listens for **fee distribution events** — these happen when a token's creator collects fees from traders. A large fee claim means real trading volume happened.

- If the fee is **less than 2 SOL** → ignored immediately, no further processing
- If the fee is **≥ 2 SOL** → potential signal, checks the other two eyes

### Eye 2: Graduated coins (checked every 30s)
Charon polls Pump.fun's API for coins that have **graduated** (crossed the Pump.fun bonding curve and launched on Raydium). It keeps a rolling 2-hour window of recently graduated tokens in memory.

### Eye 3: Trending tokens (checked every 60s)
Charon polls Jupiter's trending tokens list — top 100 tokens sorted by volume in the last 5 minutes. It filters out anything that's not a `.pump` address, or that has too high a rug ratio or bundler rate. The filtered list stays in memory for 10 minutes.

### The overlap rule
For the **Sniper** strategy, a token must appear in **at least 2 of the 3 eyes** before it's treated as a serious candidate. A fee claim alone isn't enough — the token must also be graduated OR trending.

This is why most tokens never make it past Stage 1.

---

## Stage 2 — Gathering data (Enrichment)

Once a token passes the overlap check, Charon fetches everything it can about it from 5 sources, in parallel:

| Source | What it gets |
|---|---|
| **GMGN** | Price, market cap, liquidity, total lifetime fees earned, trade fees, holder count, social links (Twitter/Telegram/website). Rate-limited — one request every 2.5s. |
| **Jupiter Asset** | Token name, symbol, market cap, FDV, liquidity, USD price, social links |
| **Jupiter Holders** | List of top token holders with their wallet addresses and balances |
| **Jupiter Chart** | Where the current price is vs the all-time high (ATH), 24h candle data (high/low), whether the token is near a "top blast" risk zone |
| **Saved Wallets** | Cross-references the holder list against your 750 saved wallets — tells Charon how many of your tracked smart money wallets are holding this token, and which ones |
| **Twitter/fxtwitter** | Scrapes the token's Twitter for any narrative or recent posts |

**Price and market cap priority:** If GMGN has data, use it. If not, fall back to Jupiter. If not, fall back to trending data. First non-null value wins.

---

## Stage 3 — Filters (hard rules)

Every enriched token goes through a checklist. **Fail any one item → rejected immediately.** The reason is logged.

### Your current Sniper filter settings:

| Rule | Threshold | What it means |
|---|---|---|
| Fee claim required | Yes | Must have had a fee claim event |
| Min fee claim | 0.5 SOL | The fee event must have distributed at least 0.5 SOL |
| Min GMGN lifetime fees | 10 SOL | The token must have earned at least 10 SOL total in trading fees ever (only checked if GMGN returned data) |
| Min market cap | $7,000 | Token must be worth at least $7K |
| Max market cap | $200,000 | Token must be worth at most $200K |
| Token age | < 1 hour | Token must be less than 1 hour old |
| Rug ratio | < 0.3 | Less than 30% of volume is rug-related (from trending data) |
| Bundler rate | < 0.5 | Less than 50% of supply is bundled (from trending data) |
| Wash trading | Flagged = reject | Any wash trading flag = automatic rejection |

Two additional rules exist but are currently **disabled** (set to 0 / 100%):
- Min holders (0 = off)
- Max top-holder concentration (100% = off — no limit)
- Min saved wallet holders (0 = off)
- Min ATH distance (0 = off, only used by Dip Buy strategy)

---

## Stage 4 — The AI picks one

Tokens that pass all filters go into a **queue**. The queue holds up to 10 tokens and only keeps tokens from the last 10 minutes.

Every time a new token passes filters, Charon sends the **entire current queue** to the AI (Mimo v2.5-pro) in one batch call.

### What the AI sees per token:
- Name, mint address, Twitter handle
- Market cap, price, liquidity, holder count, fee amounts
- Fee claim details (how much SOL was distributed and to whom)
- Trending rank, volume, swap count, rug ratio, bundler rate
- Chart: how far the current price is from the all-time high (so the AI knows if entry is late)
- Which of your 750 saved wallets are holding this token (and their labels)
- Any Twitter narrative found
- Up to 6 **active lessons** — things the AI learned from past trades (from `/learn`)
- Which strategy filters passed/failed

### What the AI returns:
```
verdict:              BUY, WATCH, or PASS
selected_candidate:   which token (if BUY)
confidence:           0–100 (not probability — just how sure the AI is)
reason:               short explanation
risks:                list of risks it noticed
suggested_tp:         take profit % it recommends
suggested_sl:         stop loss % it recommends
```

### For a buy to actually execute:
- Verdict must be **BUY**
- Confidence must be **≥ 50%** (sniper threshold)
- Agent must be **enabled** (toggle in `/menu → Agent`)
- Open positions must be **< 3** (your current max)

If any of those fail, the candidate is logged as WATCH or PASS and nothing happens.

---

## Stage 5 — Execution

After the AI approves a buy, Charon checks the token **one more time** with fresh data (in case the mcap or filters changed since enrichment). If it still passes, it executes based on your mode:

| Mode | What happens |
|---|---|
| `dry_run` (current) | Creates a simulated position in the database. No real money moves. Position size = 0.1 SOL simulated. |
| `confirm` | Sends a Telegram message with Approve / Reject buttons. You decide. Only executes if you tap Approve. |
| `live` | Immediately signs and submits a Jupiter swap. No approval step. |

**Entry slippage simulation (CHARON-02):** In dry_run, the entry market cap is recorded as 1% higher than spot (simulating buy slippage). This makes the simulated P&L slightly more realistic.

---

## Position monitoring (every 10 seconds)

Once a position is open, Charon polls Jupiter every 10 seconds for the current price and market cap.

### Exit rules (Sniper defaults):

| Rule | Threshold | Behaviour |
|---|---|---|
| **Take Profit (TP)** | +50% | If mcap is 50% above entry → close position |
| **Stop Loss (SL)** | -25% | If mcap is 25% below entry → close position |
| **Trailing TP** | 20% pullback | Arms when TP is first hit. After that, if price drops 20% from its highest point → close |
| **Max Hold** | Off (0) | Not enabled. Would force-close after N minutes if set. |
| **Partial TP** | Off | Would sell a % at a target price and hold the rest. Off for Sniper. |

### How P&L is calculated:

```
pnl_percent = (current_mcap / entry_mcap - 1) × 100
pnl_sol     = position_size_sol × pnl_percent / 100
```

On exit (auto), slippage and fee are also deducted:
```
effective_exit_mcap = exit_mcap × 0.99         (1% exit slippage)
fee_deduction       = 0.1 SOL × 0.002          (0.2% fee)
final_pnl_sol       = simulated_pnl_sol - fee_deduction
```

**What dry run does NOT simulate:** the exact liquidity-based price impact of your own buy (which is why we use the flat 1% slippage penalty instead to be safe), Solana network gas fees (~0.000005 SOL per tx), or the fact that real fills aren't always at the quoted price.

---

## Your current numbers at a glance

| Setting | Value |
|---|---|
| Mode | dry_run |
| Position size | 0.1 SOL |
| Max open positions | 3 |
| LLM | Mimo v2.5-pro, min confidence 50% |
| LLM batch size | 10 candidates, max age 10 min |
| Signal poll | every 30s |
| Position check | every 10s |
| GMGN delay | 2500ms between calls |
| Entry slippage sim | 1% |
| Fee sim | 0.2% |
| Sniper mcap range | $7K – $200K |
| Sniper max token age | 1 hour |
| Sniper TP / SL | +50% / -25% |
| Sniper trailing stop | 20% pullback from peak |
| Min fee claim (pre-filter) | 2 SOL |
| Min fee claim (strategy) | 0.5 SOL |
| Min GMGN lifetime fees | 10 SOL |

---

## Telegram commands

| Command | What it does |
|---|---|
| `/menu` | Opens the main button menu |
| `/strategy` | Shows active strategy and its settings |
| `/strategy sniper` | Switches to the sniper strategy |
| `/stratset sniper tp_percent 75` | Changes sniper TP to 75% (no restart needed) |
| `/positions` | Lists last 12 positions with View buttons |
| `/filters` | Shows all current filter values |
| `/candidate <mint>` | Shows one specific token's data and AI decision |
| `/pnl` | Shows P&L for your saved wallets (from Jupiter) |
| `/learn 12h` | Runs a learning report on the last 12h of trades |
| `/lessons` | Shows the active lessons the AI is currently using |
| `/setfilter <key> <value>` | Changes a global filter setting live |
| `/walletadd <label> <address>` | Adds one wallet to saved wallets |
| `/wallets` | Lists all saved wallets |

---

## The 4 strategies (only Sniper is active)

| | Sniper | Dip Buy | Smart Money | Degen |
|---|---|---|---|---|
| **Entry trigger** | Fee claim + overlap | ATH dip ≥ 40% | Multi-source overlap | Any trending |
| **Min mcap** | $7K | $25K | $10K | $5K |
| **Max mcap** | $200K | $500K | $1M | $100K |
| **Fee required** | Yes | No | No | No |
| **Min holders** | None | None | 1,000 | None |
| **LLM** | Yes (≥50%) | Yes (≥60%) | Yes (≥70%) | No (auto-buy) |
| **TP / SL** | +50% / -25% | +30% / -20% | +100% / -25% | +30% / -15% |
| **Position size** | 0.1 SOL | 0.05 SOL | 0.1 SOL | 0.05 SOL |
| **Trailing** | 20% | 15% | Off | 10% |
| **Partial TP** | No | No | 50% at +100% | No |
