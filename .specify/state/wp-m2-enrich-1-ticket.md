# Architect Ticket: WP-M2-ENRICH-1

## Title

Add GMGN + OKX wallet-profile enrichment to the harvester; wire enriched data into Charon LLM reviewer and priority export (read-only)

## Goal

Eliminate false `insufficient_data` LLM verdicts by enriching the harvester DB
with wallet-level analytics from GMGN (primary, batch) and OKX (fill-in for
mcap distribution, paced), then having Charon scripts read the result.

## Design Principle

- The harvester owns all GMGN and OKX API calls, using its own keys.
- Charon scripts only read `harvester.db` — zero provider calls from Charon.
- GMGN is primary because it supports batch queries (multiple wallets per call).
- OKX fills in `preferredMarketCap` and `buysByMarketCap` that GMGN does not
  return. OKX is 1-wallet-per-call so it must be paced separately.
- KOL detection uses existing harvester data: wallets with `twitter_username`
  and `wallet_label` are public KOL wallets. The `provider_tags` field already
  has 121 wallets tagged `kol`. The GMGN `common.tags` response reinforces this.

## Depends On

M1a (landed), M2a `llm_wallet_reviewer.js` (landed)

## Safety Boundaries

Follow `./AGENTS.md` and
`../moonbags/AGENTS.md`.

Do not:
- Read, print, copy, validate, or modify any `.env` file
- Print API keys, auth headers, OKX signatures, or raw environment values
- Start Charon, PM2, Telegram, trading, signing, or swaps
- Install new dependencies
- Run unbounded API calls — always require `--limit`
- Auto-delete or auto-remove wallets based on any enrichment result

---

## Part A — Harvester Side (Writes)

### A1. New table: `wallet_profiles` in `harvester.db`

```sql
CREATE TABLE IF NOT EXISTS wallet_profiles (
  address                    TEXT PRIMARY KEY,

  -- GMGN fields (GET /v1/user/wallet_stats)
  gmgn_realized_profit_usd   REAL,
  gmgn_unrealized_profit_usd REAL,
  gmgn_pnl_ratio             REAL,
  gmgn_winrate               REAL,
  gmgn_total_cost_usd        REAL,
  gmgn_buy_count             INTEGER,
  gmgn_sell_count            INTEGER,
  gmgn_tags                  TEXT NOT NULL DEFAULT '[]',
  gmgn_twitter_username      TEXT,
  gmgn_twitter_name          TEXT,
  gmgn_followers_count       INTEGER,
  gmgn_is_blue_verified      INTEGER,
  gmgn_created_token_count   INTEGER,
  gmgn_wallet_created_at     INTEGER,
  gmgn_period                TEXT NOT NULL DEFAULT '7d',
  gmgn_snapshot_at           INTEGER NOT NULL,

  -- OKX fields (GET /api/v6/dex/market/portfolio/overview)
  okx_realized_pnl_usd      REAL,
  okx_win_rate               REAL,
  okx_buy_tx_count           INTEGER,
  okx_sell_tx_count          INTEGER,
  okx_buy_tx_volume_usd     REAL,
  okx_sell_tx_volume_usd    REAL,
  okx_avg_buy_value_usd     REAL,
  okx_preferred_mcap         TEXT,
  okx_buys_by_mcap_json      TEXT,
  okx_token_count_by_pnl_json TEXT,
  okx_time_frame             TEXT NOT NULL DEFAULT '3',
  okx_snapshot_at            INTEGER
);
```

- `INSERT OR REPLACE` on re-runs.
- All numeric fields use `nullableGmgnNumber` pattern — never convert missing to 0.
- `gmgn_tags` and OKX JSON fields are stored as JSON text arrays/objects.
- `okx_preferred_mcap` stores the bucket label: `<100K`, `100K-1M`, `1M-10M`,
  `10M-100M`, `>100M` (translated from OKX enum 1-5).
- `okx_snapshot_at` is nullable — OKX fill-in may not have run yet.

### A2. New table: `owner_labels` in `harvester.db`

```sql
CREATE TABLE IF NOT EXISTS owner_labels (
  address        TEXT PRIMARY KEY,
  manual_label   TEXT,
  manual_notes   TEXT,
  labeled_at_ms  INTEGER NOT NULL
);
```

Created in this ticket. Read by Charon scripts. Population is manual SQLite
inserts or a follow-up ticket.

### A3. New file: `src/enrichWalletProfile.ts` in the wallet-harvester

Location: `../moonbags/tools/wallet-harvester/src/enrichWalletProfile.ts`

#### GMGN enrichment (primary)

Endpoint: `GET /v1/user/wallet_stats`
- Auth: same `X-APIKEY` + `timestamp` + `client_id` the harvester already uses
  via `gmgnGet` / `addGmgnNormalAuthQuery` in `src/discovery.ts`.
- Params: `chain=sol`, `wallet_address` (array — supports batch), `period=7d`
- Weight: 3 per call. Bucket: rate=10, capacity=10.
- Batch: up to 10 wallet addresses per call.
- Response fields used:
  - `realized_profit`, `unrealized_profit`, `winrate`, `total_cost`,
    `buy_count`, `sell_count`, `pnl`
  - `common.tags`, `common.twitter_username`, `common.twitter_name`,
    `common.followers_count`, `common.is_blue_verified`,
    `common.created_token_count`, `common.created_at`
- The `common` block may be absent — handle gracefully, store nulls.

Implementation:
- Reuse `gmgnGet` from `src/discovery.ts` (import it — it's already exported).
- Build the query with `wallet_address` as array param for batch.
- Rate limit via existing `gmgnPace`.
- 908 wallets ÷ 10 per batch = ~91 calls. At harvester's pacing this is
  manageable in a sparse scheduled run.
- Target wallets with oldest or missing `gmgn_snapshot_at` first.

#### OKX enrichment (fill-in, paced)

Endpoint: `GET https://web3.okx.com/api/v6/dex/market/portfolio/overview`
- Auth: OKX HMAC signature — harvester already has `OKX_API_KEY`,
  `OKX_SECRET_KEY`, `OKX_PASSPHRASE` in its own `.env` and an existing OKX
  request signing pattern. Reuse the existing OKX auth infrastructure from the
  harvester's OKX extractor code.
- Params: `chainIndex=501` (Solana), `walletAddress`, `timeFrame=3` (7D)
- No batch — 1 wallet per call.
- Response fields used:
  - `realizedPnlUsd`, `winRate`, `buyTxCount`, `sellTxCount`,
    `buyTxVolume`, `sellTxVolume`, `avgBuyValueUsd`
  - `preferredMarketCap` (enum 1-5 → translate to label)
  - `buysByMarketCap` (array of `{marketCapRange, buyCount}`)
  - `tokenCountByPnlPercent` (object with distribution buckets)

Implementation:
- Separate `--okx` flag enables OKX fill-in. Without it, only GMGN runs.
- OKX is paced at existing `cfg.okxMinIntervalMs` (default 1200ms).
- `--okx-limit=N` caps OKX calls per run (default 25).
- Only enrich wallets that already have a GMGN profile but are missing
  `okx_snapshot_at` or have the oldest OKX snapshot.
- OKX rate limit errors (50011/429) stop the OKX pass for that run.

#### CLI flags

```bash
# GMGN-only, dry run
npm run enrich:profiles -- --dry-run --limit=10

# GMGN batch enrichment (25 wallets, oldest snapshot first)
npm run enrich:profiles -- --limit=25

# GMGN + OKX fill-in
npm run enrich:profiles -- --limit=50 --okx --okx-limit=25

# Single wallet (both providers)
npm run enrich:profiles -- --wallet-address=2NuAgVk3... --okx

# 30-day period instead of 7d
npm run enrich:profiles -- --limit=25 --period=30d

# Custom DB path
HARVESTER_DB_PATH=/path/to/harvester.db npm run enrich:profiles -- --limit=25
```

#### Logging rules

Log only:
- Address (truncated: first 6 + last 4 chars)
- Provider name, HTTP status code, field count
- Snapshot timestamp
- Batch ID, wallets-per-batch count
- Rate limit warnings (cooldown duration, not headers)

Never log:
- Raw response bodies
- API keys, auth headers, OKX signatures
- Raw environment variables
- Full wallet addresses in bulk (truncate)

### A4. npm script in wallet-harvester

```json
"enrich:profiles": "tsx src/enrichWalletProfile.ts"
```

---

## Part B — Charon Side (Read-Only)

### B1. Wire `wallet_profiles` into `scripts/llm_wallet_reviewer.js`

New function `fetchWalletProfiles(harvesterDb, addresses)`:
- Query `wallet_profiles` table for each address in the batch.
- Zero GMGN/OKX API calls from this script.

Add `wallet_analytics` block to `buildWalletContext` output:

```js
wallet_analytics: {
  gmgn: {
    available: true/false,
    snapshot_age_days: N,
    period: '7d',
    realized_profit_usd: ...,
    unrealized_profit_usd: ...,
    pnl_ratio: ...,
    winrate: ...,
    total_cost_usd: ...,
    buy_count: ...,
    sell_count: ...,
    tags: [...],
    twitter_username: ...,
    followers_count: ...,
    is_blue_verified: ...,
    created_token_count: ...,
  },
  okx: {
    available: true/false,
    snapshot_age_days: N,
    realized_pnl_usd: ...,
    win_rate: ...,
    buy_tx_count: ...,
    sell_tx_count: ...,
    avg_buy_value_usd: ...,
    preferred_mcap: '<100K' | '100K-1M' | ... ,
    buys_by_mcap: [...],
  },
  kol_like: true/false,
}
```

KOL detection logic (no new API call needed):
```
kol_like = true if ANY of:
  - existing provider_tags includes 'kol' or 'renowned'
  - gmgn common.tags includes 'kol'
  - wallet has twitter_username AND wallet_label (public named wallet)
```

Update `data_quality.harvester_context`:
- If `wallet_analytics.gmgn.available === true` and snapshot < 3 days:
  context is `'standard'` even if sightings are sparse.
- If neither GMGN nor OKX available, keep existing sparse/partial logic.
- New limitation string when profiles are stale (> 7 days) or missing.

Update LLM system prompt — add these instructions:
- "When `wallet_analytics.gmgn.available` is true, use those metrics as
  primary evidence for wallet quality. Do not mark a wallet as
  `insufficient_data` when wallet-level analytics exist."
- "When `wallet_analytics.kol_like` is true, classify the wallet as a
  KOL/influencer type. Assess whether the KOL is profitable or noisy based
  on PnL and win rate. Do not use generic `insufficient_data`."
- "When `wallet_analytics.okx.preferred_mcap` is available, use it to assess
  whether the wallet's buying behavior matches the target strategy (<100K
  or 100K-1M mcap range)."

Also read `owner_labels` table and include in context if present:
```js
owner_label: { manual_label: ..., manual_notes: ... }
```

### B2. Wire `wallet_profiles` + `owner_labels` into `scripts/export_wallet_priority.js`

Read `wallet_profiles` and `owner_labels` from harvester DB (already opened
read-only). Add new **output-only** CSV/JSON columns:

- `gmgn_realized_profit_usd`
- `gmgn_pnl_ratio`
- `gmgn_winrate`
- `gmgn_buy_count`
- `gmgn_sell_count`
- `okx_win_rate`
- `okx_avg_buy_value_usd`
- `okx_preferred_mcap`
- `okx_buy_tx_count`
- `kol_like`
- `owner_manual_label`
- `owner_manual_notes`

**No scoring formula changes** in this ticket. These are visibility columns
for the owner to audit. Scoring calibration is a separate ticket.

---

## Forbidden Actions

- Do not read, print, copy, validate, or modify any `.env` file from Charon
  or harvester
- Do not make any GMGN or OKX API calls from Charon scripts — all provider
  calls stay in the harvester
- Do not print API keys, auth headers, OKX signatures, or raw response bodies
- Do not start Charon, PM2, Telegram, trading, signing, or swaps
- Do not install new dependencies — use existing `gmgnGet`, `gmgnPace`,
  OKX auth utils, `better-sqlite3`, `pino` from the harvester
- Do not auto-delete or auto-remove wallets based on enrichment results
- Do not change the scoring formula in `export_wallet_priority.js`

## Owner Approval Needed Before

- Running `enrich:profiles` with `--limit` > 50 for first GMGN pass
- Running `--okx --okx-limit` > 25 for first OKX pass
- Any scoring formula changes based on new profile fields (separate ticket)

---

## Verifier Checklist

1. `grep -r "gmgnGet\|gmgn.*fetch\|GMGN_API\|okx.*fetch\|OKX_API" scripts/llm_wallet_reviewer.js scripts/export_wallet_priority.js` returns **nothing** — Charon makes zero provider calls
2. `src/enrichWalletProfile.ts` uses the harvester's existing `gmgnGet` + `gmgnPace` for GMGN and existing OKX auth infrastructure for OKX — no new secret mechanism
3. `--dry-run` runs without any HTTP calls and logs the plan
4. `--wallet-address=2NuAgVk3...` fetches exactly 1 GMGN batch (1 wallet); with `--okx` adds exactly 1 OKX call
5. `wallet_profiles` table created with correct schema, all numerics nullable
6. No API key, auth header, OKX signature, or raw response body in stdout/stderr
7. `llm_wallet_reviewer.js` dry-run JSON for `2Nu...` shows `wallet_analytics.gmgn.available: true` after GMGN enrichment
8. `llm_wallet_reviewer.js` dry-run JSON for `719...` shows `wallet_analytics.kol_like: true`
9. With OKX enrichment done, `wallet_analytics.okx.preferred_mcap` is populated
10. `export_wallet_priority.js` CSV includes the new columns
11. `owner_labels` table exists and is read by both Charon scripts (even if empty)
12. LLM system prompt has: "do not mark `insufficient_data` when analytics exist" and "classify KOL separately"
13. No scoring formula changes in `export_wallet_priority.js`
14. OKX calls respect `--okx-limit` and stop on 429/50011

## Acceptance Criteria (Owner-Checkable)

- After `enrich:profiles` for `2NuAgVk3...`, LLM dry-run no longer says `insufficient_data`
- `719sfKU...` classified as KOL/noisy, not generic `insufficient_data`
- `6EDa...` shows as KOL with PnL data visible for downstream rules
- Priority CSV has the new `gmgn_*`, `okx_*`, and `owner_*` columns
- No provider calls when running Charon scripts — only when running harvester enrichment
- No wallet auto-deleted by any script

---

## API Reference (for Coder)

### GMGN wallet_stats

Source: [GMGN OpenAPI gmgn-skills repo](https://github.com/GMGNAI/gmgn-skills)

```
GET {gmgnBaseUrl}/v1/user/wallet_stats
Headers: X-APIKEY: {cfg.gmgnApiKey}, Content-Type: application/json
Query: chain=sol, wallet_address=[addr1,addr2,...], period=7d|30d,
       timestamp={unix_seconds}, client_id={uuid}

Response (per wallet):
  realized_profit, unrealized_profit, winrate (0-1), total_cost,
  buy_count, sell_count, pnl (ratio = realized/cost)
  common: { tags[], twitter_username, twitter_name, followers_count,
            is_blue_verified, created_token_count, created_at,
            fund_from, fund_from_address }

Rate: weight 3, bucket rate=10 capacity=10
      ~3.3 req/sec sustained, batch up to ~10 wallets per call
```

### OKX portfolio overview

Source: [OKX OnchainOS docs](https://web3.okx.com/onchainos/dev-docs/market/market-portfolio-reference)

```
GET https://web3.okx.com/api/v6/dex/market/portfolio/overview
Headers: OK-ACCESS-KEY, OK-ACCESS-SIGN, OK-ACCESS-PASSPHRASE, OK-ACCESS-TIMESTAMP
Query: chainIndex=501, walletAddress={addr}, timeFrame=3 (7D)
       timeFrame enum: 1=1D, 2=3D, 3=7D, 4=1M, 5=3M

Response:
  realizedPnlUsd, winRate, buyTxCount, sellTxCount,
  buyTxVolume, sellTxVolume, avgBuyValueUsd,
  preferredMarketCap (enum 1-5:
    1=<100K, 2=100K-1M, 3=1M-10M, 4=10M-100M, 5=>100M),
  buysByMarketCap: [{ marketCapRange, buyCount }],
  tokenCountByPnlPercent: { over500Percent, zeroTo500Percent,
    zeroToMinus50Percent, overMinus50Percent },
  top3PnlTokenList: [{ tokenContractAddress, tokenSymbol,
    tokenPnLUsd, tokenPnLPercent }]

Rate: 429 at code 50011. 1 wallet per call. Pace at cfg.okxMinIntervalMs.
```
