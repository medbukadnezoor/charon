# Charon

Charon is a Telegram trench agent for screening noisy Pump-token flow with overlap signals, strategy gates, LLM selection, and dry-run/confirm/live execution.

# ALERT
This Codebase is on testing-period, developer doesn't guarantee of any result.


## Flow

1. Charon polls the Charon signal server every `SIGNAL_POLL_MS`.
2. The active strategy gates source count, fee requirement, token age, market cap, holders, fees, trend quality, ATH distance, and position caps.
3. Passing candidates are enriched with token info, Jupiter asset/holders/chart data, saved-wallet exposure, and fxtwitter narrative when available.
4. The LLM screens up to `LLM_CANDIDATE_PICK_COUNT` recent candidates and may pick one `BUY`.
5. Charon routes approved buys through `dry_run`, `confirm`, or `live`.
6. Open positions are monitored every `POSITION_CHECK_MS` for TP, SL, trailing TP, max hold, and partial TP rules.

## Access

Charon requires a signal server URL and API key. The signal server aggregates fee-claim, graduated, and trending data from Pump.fun in real time — without it Charon has nothing to screen.

To get access, contact the maintainer. Once you have credentials, set them in `.env`:

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_key_here
```

## Install

```bash
git clone git@github.com:yunus-0x/charon.git
cd charon
npm install
cp .env.example .env
```

Edit `.env` with your credentials, then run:

```bash
npm start
```

For PM2:

```bash
pm2 start index.js --name charon
pm2 save
```

## Required Config

```env
TELEGRAM_BOT_TOKEN=
SHADOW_TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

`TELEGRAM_CHAT_ID` is the chat or group ID where Charon sends alerts and accepts commands. Only messages from this chat are processed.
Shadow mode can use `SHADOW_TELEGRAM_BOT_TOKEN` for a separate Telegram bot. If it is unset, shadow mode falls back to `TELEGRAM_BOT_TOKEN`; primary mode always uses `TELEGRAM_BOT_TOKEN`.

Signal server (required — see [Access](#access) above):

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=
SIGNAL_POLL_MS=30000
```

RPC endpoint (required for live execution):

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
PUMP_HELIUS_RPC_URL=
PUMP_HELIUS_WS_URL=
```

If `SOLANA_RPC_URL`/`SOLANA_WS_URL` are not set, Charon falls back to Helius mainnet URLs and requires:

```env
HELIUS_API_KEY=
```

Optional Pump-specific fallback endpoints can be set for Pump log / transaction
lookup contexts only. They are never used for holder-history, wallet-balance, or
execution RPC contexts:

```env
PUMP_HELIUS_RPC_URL=
PUMP_HELIUS_WS_URL=
```

Check routing behavior without live provider calls:

```bash
CHARON_SKIP_DOTENV=true node scripts/check_rpc_routing_shadow.js
```

## GMGN Enrichment

```env
GMGN_ENABLED=true
GMGN_API_KEY=
```

GMGN enriches candidates with holder count, liquidity, fee data, and social links. Set `GMGN_ENABLED=false` to skip it — Charon falls back to Jupiter/server data and the status line shows `off`. GMGN has aggressive rate limits; keep `GMGN_REQUEST_DELAY_MS` at 2500+ ms.

## LLM Config

```env
ENABLE_LLM=true
LLM_PROVIDER_ORDER=mimo,cliproxy
MIMO_LLM_BASE_URL=https://token-plan-sgp.xiaomimimo.com/v1
MIMO_LLM_MODEL=mimo-v2.5-pro
MIMO_LLM_API_KEY=
CLIPROXY_LLM_BASE_URL=http://127.0.0.1:8317/v1
CLIPROXY_LLM_MODEL=gpt-5.5
CLIPROXY_LLM_API_KEY=NO_API_KEY
LLM_BASE_URL=http://127.0.0.1:8317/v1
LLM_API_KEY=NO_API_KEY
LLM_MODEL=gpt-5.5
LLM_REASONING_EFFORT=low
LLM_TIMEOUT_MS=90000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
```

`LLM_PROVIDER_ORDER` controls failover order for all runtime LLM calls. The current primary route is Xiaomi MiMo token plan (`mimo-v2.5-pro` at `https://token-plan-sgp.xiaomimimo.com/v1`) when a MiMo key is configured, with VPS-local CLIProxyAPI on `127.0.0.1:8317` as fallback. Accepted MiMo key env names are `MIMO_LLM_API_KEY`, `MIMO_API_KEY`, `XIAOMIMIMO_API_KEY`, `MIMO_TOKEN_PLAN_API_KEY`, or `TOKEN_PLAN_API_KEY`.

Legacy `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` remain supported by setting `LLM_PROVIDER_ORDER=legacy`. Shadow mode defaults to `LLM_PROVIDER_ORDER=legacy,cliproxy`, which means `SHADOW_LLM_BASE_URL` / `SHADOW_LLM_API_KEY` / `SHADOW_LLM_MODEL` are tried first and CLIProxyAPI is fallback. The current intended shadow endpoint is `https://integrate.api.nvidia.com/v1` with `meta/llama-4-maverick-17b-128e-instruct`.

Set `ENABLE_LLM=false` to disable LLM globally. Individual strategies also have a `use_llm` flag — strategies with `use_llm: false` (e.g. `degen`) auto-approve any candidate that passes filters without calling the LLM.

Each strategy has its own `llm_min_confidence` threshold. Configure it from `/menu → Strategy`, or:

```bash
/stratset sniper llm_min_confidence 70
```

## Execution Modes

```env
TRADING_MODE=dry_run
```

- `dry_run`: stores simulated buys/sells in SQLite. No wallet needed.
- `confirm`: sends a Telegram trade intent with approve/reject buttons. Executes live only after you confirm.
- `live`: signs and executes Jupiter Ultra swaps immediately after strategy and LLM approval.

Live and confirm modes require:

```env
SOLANA_PRIVATE_KEY=
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02
```

`LIVE_MIN_SOL_RESERVE` is the minimum SOL kept in the wallet after any buy. Charon refuses to execute if the balance would fall below this.

Swaps use Jupiter Ultra mode — slippage and routing are handled automatically by Jupiter. No manual slippage config needed.

## Strategies

Use `/menu → Strategy` or commands:

```bash
/strategy
/strategy sniper
/strategy dip_buy
/strategy smart_money
/strategy degen
/stratset sniper tp_percent 75
```

Default strategies:

- `sniper`: fee-claim overlap, immediate entry, LLM on.
- `dip_buy`: waits for ATH-distance dip alerts.
- `smart_money`: stricter holder/trending quality, partial TP support.
- `degen`: lower source threshold, rule-based (no LLM).

Strategy settings are stored in SQLite and hot-read. Menu changes apply without restart.

## Telegram Commands

```bash
/menu
/strategy
/stratset <strategy_id> <key> <value>
/positions
/candidate <mint>
/filters
/pnl
/learn <window>
/lessons
/walletadd <label> <address>
/walletremove <label>
/wallets
```

## Storage

Charon uses `charon.sqlite` as source of truth. It stores:

- candidates and filter results
- LLM decisions and batches
- decision logs
- dry-run/live positions and trades
- trade intents
- saved wallets
- strategy configs
- price alerts
- learning runs and lessons

Open positions resume monitoring after restart.

## Verification

```bash
npm run check
```

## Config Reloading

SQLite/menu settings are hot-read by the bot. API keys, wallet key, RPC URLs, Jupiter base URL, and polling intervals are `.env` values and require restart.

## API Usage Notes

- **GMGN**: Rate-limited. Keep `GMGN_REQUEST_DELAY_MS=2500` or higher. Running many instances or lowering the delay will get your key banned.
- **Jupiter**: `fetchJupiterAsset` and `fetchJupiterHolders` are called per candidate and per position refresh cycle. At high throughput, you may hit 429s — Charon backs off automatically and retries from cache.
- **Helius RPC**: Position monitoring polls every `POSITION_CHECK_MS` (default 10s). Use a paid Helius plan for live trading; free tier will throttle under load.
- **Pump RPC fallback**: `PUMP_HELIUS_RPC_URL` / `PUMP_HELIUS_WS_URL` are optional Pump-only fallback endpoints. They are only eligible for Pump contexts such as fee logs and Pump transaction lookup; holder intelligence, wallet balance checks, and live execution stay on the general RPC route.
- **LLM**: One API call per batch cycle (up to `LLM_CANDIDATE_PICK_COUNT` candidates per call). Live defaults to MiMo token plan with CLIProxyAPI fallback; shadow defaults to the free shadow endpoint with CLIProxyAPI fallback.

## Notes

- Live execution uses `@solana/web3.js` v1 (legacy SDK). It works, but a future version may migrate to `@solana/kit`.
- The position monitor sends a Telegram alert after 3 consecutive failures on any polling loop.
