# WP-M5-4: Jupiter PnL multi-address batching + priority queue + Charon DB write

**Type:** Coder
**Parent plan:** `SMART_WALLET_ARCH_PLAN.md`
**Status:** Open

---

## Goal

Upgrade `scripts/refresh_wallet_pnl.js` to:
1. Batch up to 5 addresses per Jupiter request (comma-separated `addresses` param)
2. Run at 2 req/sec by default (configurable via `--rate`)
3. Apply a priority queue so high-value wallets refresh first
4. Write refreshed PnL back to Charon `saved_wallets.jup_*` columns in addition to
   the existing harvester DB write

Effective throughput: 10 wallets/sec → full 800-wallet refresh in ~80s vs ~13 min.

## Owner-visible outcome

After this ticket:
1. `node scripts/refresh_wallet_pnl.js --limit=50 --dry-run` prints batched output
   showing 5 addresses per request at 2 req/sec.
2. `node scripts/refresh_wallet_pnl.js --limit=50 --commit` writes to both harvester
   DB and Charon `saved_wallets` (jup_total_pnl, jup_winrate, jup_total_trades,
   jup_snapshot_at).
3. `--batch-size=N` and `--rate=N` flags work.
4. Priority queue: owner-labeled → recently-overlapped → tier A/B → KOL-tagged →
   high winrate → all others.
5. `node --check` passes.

---

## What to implement

### Refactor `scripts/refresh_wallet_pnl.js`

Keep the existing file structure and all existing flags. Add/change the following:

#### New CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--batch-size=N` | `5` | Addresses per Jupiter request |
| `--rate=N` | `2` | Requests per second |
| `--charon-db=` | `./charon.sqlite` | Path to Charon DB (also reads `CHARON_DB_PATH` env) |
| `--commit` | — | Write to DBs (replaces the old implicit write; `--dry-run` remains the default) |

Note: the existing `--dry-run` flag already exists. The existing `--limit`, `--harvester-db`,
`--fresh-hours`, `--min-interval-ms` flags must still work. `--min-interval-ms` is now
superseded by `--rate` but keep it as a fallback: if `--rate` is set, derive
`minIntervalMs = Math.floor(1000 / rate)` per batch; if only `--min-interval-ms` is set,
use it as the inter-batch delay.

#### New `fetchBatchPnl(addresses)` function

Replace the single-address `fetchWalletPnl(address)` with a batch version:

```js
async function fetchBatchPnl(addresses) {
  // addresses: string[] of 1-5 wallet addresses
  const url = new URL(JUPITER_PNL_URL);
  url.searchParams.set('addresses', addresses.join(','));
  url.searchParams.set('includeClosed', 'false');

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });

  if (res.status === 429) {
    const resetHeader = Number(res.headers.get('x-ratelimit-reset') || 0);
    const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
    const retryAfterMs = Number(res.headers.get('retry-after') || 0) * 1000;
    const backoffMs = Math.max(
      retryAfterMs,
      resetMs > Date.now() ? resetMs - Date.now() : 0,
      30_000,
    );
    return { rateLimited: true, backoffMs };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
  }

  const data = await res.json();
  // Return per-address summaries
  const results = {};
  for (const address of addresses) {
    results[address] = extractWalletSummary(data, address);
  }
  return { results };
}
```

Keep the existing `extractWalletSummary(payload, address)` function unchanged.

#### Priority queue: `prioritizeWallets(wallets, charonRows)`

Add this function. It sorts the wallet list before batching:

```js
function prioritizeWallets(wallets, charonRows) {
  // charonRows: Map<address, saved_wallets row> from Charon DB (may be empty Map)
  const priority = (w) => {
    const charon = charonRows.get(w.address);
    if (charon?.owner_label) return 0;           // P0: owner-labeled
    if (charon?.tier === 'A') return 2;           // P2: tier A
    if (charon?.tier === 'B') return 2;           // P2: tier B
    const tags = parseTags(charon?.tags_json);
    if (tags.some(t => /kol|renowned|influencer|caller|alpha/i.test(t))) return 3; // P3: KOL
    const wr = Number(charon?.gmgn_winrate ?? charon?.okx_winrate ?? 0);
    if (wr > 0.5) return 4;                       // P4: high winrate
    return 5;                                     // P5: all others
  };
  return [...wallets].sort((a, b) => priority(a) - priority(b));
}

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}
```

#### Updated `main()` function

Replace the existing `main()` with this structure:

```js
async function main() {
  const harvesterDbPath = path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB));
  const charonDbPath = path.resolve(argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB));
  const limit = Math.floor(argNumber('limit', 100));
  const batchSize = Math.min(10, Math.max(1, Math.floor(argNumber('batch-size', 5))));
  const rate = Math.max(0.1, argNumber('rate', 2));           // req/sec
  const batchDelayMs = Math.floor(1000 / rate);
  // Legacy --min-interval-ms overrides only if --rate not explicitly set
  const hasRate = process.argv.some(a => a.startsWith('--rate='));
  const minIntervalMs = hasRate ? batchDelayMs : Math.floor(argNumber('min-interval-ms', batchDelayMs));
  const maxFreshAgeMs = Math.floor(argNumber('fresh-hours', 24)) * 60 * 60 * 1000;
  const dryRun = !hasFlag('commit');   // dry-run is default; --commit required to write

  if (!fs.existsSync(harvesterDbPath)) throw new Error(`Harvester DB not found: ${harvesterDbPath}`);

  // Open harvester DB
  const harvDb = new Database(harvesterDbPath);
  const rawWallets = selectWallets(harvDb, limit, maxFreshAgeMs);

  // Load Charon saved_wallets for priority + write-back (optional — graceful if missing)
  let charonDb = null;
  let charonRows = new Map();
  let charonHasJupCols = false;
  if (fs.existsSync(charonDbPath)) {
    try {
      charonDb = new Database(charonDbPath);
      const rows = charonDb.prepare('SELECT * FROM saved_wallets').all();
      charonRows = new Map(rows.map(r => [r.address, r]));
      // Check if jup columns exist (M5-1 migration may not have run yet)
      const cols = charonDb.prepare('PRAGMA table_info(saved_wallets)').all().map(r => r.name);
      charonHasJupCols = cols.includes('jup_total_pnl');
    } catch (err) {
      console.log(`[pnl-refresh] Charon DB open skipped: ${err.message}`);
      charonDb = null;
    }
  }

  // Apply priority queue
  const wallets = prioritizeWallets(rawWallets, charonRows);

  // Prepare DB statements
  const harvUpdate = harvDb.prepare(`
    UPDATE wallets
    SET pnl_usd = COALESCE(?, pnl_usd),
        win_rate = COALESCE(?, win_rate),
        pnl_snapshot_at = ?
    WHERE address = ?
  `);

  const charonUpdate = (charonDb && charonHasJupCols)
    ? charonDb.prepare(`
        UPDATE saved_wallets
        SET jup_total_pnl    = COALESCE(?, jup_total_pnl),
            jup_winrate      = COALESCE(?, jup_winrate),
            jup_total_trades = COALESCE(?, jup_total_trades),
            jup_snapshot_at  = ?
        WHERE address = ?
      `)
    : null;

  let updated = 0;
  let noData = 0;
  let errors = 0;
  let rateLimits = 0;
  const totalBatches = Math.ceil(wallets.length / batchSize);

  console.log(`Refreshing ${wallets.length} wallets in ${totalBatches} batches (size=${batchSize}, rate=${rate}/s)`);
  console.log(`Mode: ${dryRun ? 'dry-run' : 'commit'}; fresh-hours=${maxFreshAgeMs / 3_600_000}`);
  if (charonDb && charonHasJupCols) {
    console.log(`Charon write-back: enabled (${charonDbPath})`);
  } else if (charonDb) {
    console.log(`Charon write-back: skipped (jup columns not found — run M5-1 migration first)`);
  } else {
    console.log(`Charon write-back: skipped (DB not found at ${charonDbPath})`);
  }

  // Chunk wallets into batches
  for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
    const batch = wallets.slice(batchIdx * batchSize, (batchIdx + 1) * batchSize);
    const addresses = batch.map(w => w.address);
    const batchLabel = `[batch ${batchIdx + 1}/${totalBatches}]`;

    let result;
    let retried = false;
    while (true) {
      result = await fetchBatchPnl(addresses);
      if (!result.rateLimited) break;
      rateLimits++;
      console.log(`${batchLabel} 429 backing off ${Math.ceil(result.backoffMs / 1000)}s`);
      await sleep(result.backoffMs);
      retried = true;
    }

    if (result.error) {
      errors += batch.length;
      console.log(`${batchLabel} error: ${result.error}`);
    } else {
      const snapshotAt = Date.now();
      for (const wallet of batch) {
        const summary = result.results[wallet.address];
        if (!summary) {
          noData++;
          console.log(`  ${wallet.address.slice(0, 8)}... no-data`);
          continue;
        }
        const { pnlUsd, winRate, totalTrades } = summary;
        if (!dryRun) {
          harvDb.transaction(() => {
            harvUpdate.run(pnlUsd, winRate, snapshotAt, wallet.address);
          })();
          if (charonUpdate && charonRows.has(wallet.address)) {
            charonDb.transaction(() => {
              charonUpdate.run(pnlUsd, winRate, totalTrades ?? null, snapshotAt, wallet.address);
            })();
          }
        }
        updated++;
        console.log(`  ${wallet.address.slice(0, 8)}... pnl=${pnlUsd ?? 'n/a'} win=${winRate ?? 'n/a'} trades=${totalTrades ?? 'n/a'}`);
      }
    }

    if (batchIdx < totalBatches - 1) await sleep(minIntervalMs);
  }

  harvDb.close();
  if (charonDb) charonDb.close();

  console.log(`\nDone: ${updated} ${dryRun ? 'would update' : 'updated'}, ${noData} no-data, ${errors} errors, ${rateLimits} rate-limit events.`);
  if (dryRun) console.log('Pass --commit to write.');
}
```

Also add the `DEFAULT_CHARON_DB` constant near the top with the other constants:
```js
const DEFAULT_CHARON_DB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'charon.sqlite');
```

---

## What NOT to do

- Do not call any external provider other than Jupiter PnL endpoint
- Do not read `.env` or secrets
- Do not run Charon, PM2, Telegram, trading, signing, or swaps
- Do not install dependencies
- Do not modify `src/enrichment/wallets.js` or any hot-path code

---

## Verification

1. `node --check scripts/refresh_wallet_pnl.js` passes
2. Script prints batched output with `[batch N/M]` labels when run with `--dry-run`
3. `--batch-size` and `--rate` flags are accepted
4. `--commit` flag is required to write (dry-run is default)

---

## Files to modify

| File | Change |
|------|--------|
| `scripts/refresh_wallet_pnl.js` | Add batching, rate control, priority queue, Charon write-back |

## Files to read (context)

| File | Why |
|------|-----|
| `scripts/refresh_wallet_pnl.js` | Full current implementation |
| `SMART_WALLET_ARCH_PLAN.md` sections 5a–5c | Batching design, priority queue, freshness contract |
