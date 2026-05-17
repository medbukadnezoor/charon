# Shadow Charon — Full Planner Deliverable (Revised v4)

Created: 2026-05-17
Revised: 2026-05-17 v2 — module-load order, lazy Telegram, test scripts, CI, risk, DB inventory
Revised: 2026-05-17 v3 — full bot import audit, DB-backed tradingMode guard, multi-site executeLiveBuy,
  runtime check removal from M1, risk language tightened, tp_sl_rules reclassified, price_alerts added,
  JUPITER_API_KEY dual-use addressed
Revised: 2026-05-17 v4 — raw/effective tradingMode split, DB count corrected to 20, shadow_overrides
  table separated, CHARON_SKIP_DOTENV in safety scripts, setupTelegram no-op, router guards throw
  instead of silent fallback, signal batch identity task added, M4 PM2 cron moved to M5
Revised: 2026-05-17 v5 — process-isolated tests (child-process per case), hasLiveWallet() instead of
  hasLiveWallet(), sync cron DB isolation rule, trading_mode as protected override, Telegram test
  stubbing requirement, dynamic import grep check, stale text fixes

Status: Ready for owner review, then Architect ticket execution

---

## 1. OWNER EXECUTIVE SUMMARY

**What this is:** A second copy of Charon that runs side-by-side with your live bot, using the same market data and wallet intelligence, but with different strategy settings and zero ability to trade real money.

**Why it matters:** Right now, if you want to test whether looser filters or a different confidence threshold would catch more winners, you have to change the live bot and hope you don't miss good trades (or take bad ones) during the experiment. Shadow Charon lets you run "what if" experiments forever without touching the live bot.

**What you'll see when it's done:**
- PM2 shows two processes: `charon` (your live bot) and `charon-shadow` (the experiment bot)
- Shadow writes to its own database — it cannot touch your live positions or wallet
- Shadow cannot trade even if misconfigured — multiple hardware-style safety locks prevent it
- You can change shadow's strategy settings independently via CLI commands
- A drift report tells you when shadow has fallen out of sync with primary (new wallets, schema changes)
- Charon Intelligence reports compare primary vs shadow: "shadow would have caught 3 extra winners this week"

**What won't change:** Your live Charon keeps running exactly as it does today. Shadow is additive only.

**Risk profile:**
- **Trading risk:** M1 proves local shadow safety invariants (all execution paths blocked in code). Production launch safety is verified separately in M5 when PM2 env and runtime isolation are confirmed on VPS.
- **Operational risk (low but nonzero, addressed per-milestone):**
  - Extra GMGN/Jupiter/LLM API calls — may approach rate limits during high-signal periods
  - Extra VPS CPU/memory for the second Node.js process (~50-80MB RSS)
  - Duplicate Telegram alerts if shadow send-mode is enabled without clear `[SHADOW]` tagging
  - Charon Intelligence must correctly separate primary vs shadow data or analysis is polluted
- **Mitigation:** Each operational risk has a specific verification check in the milestone where it's introduced.

---

## 2. SPEC — Shadow Charon Product Specification

### 2.1 Problem Statement

Charon's strategy tuning is a single-threaded experiment: change config, observe results, revert if bad. This creates three problems:
1. Opportunity cost during conservative configs (missed winners)
2. Risk during aggressive configs (taken losers)
3. No controlled comparison — you can't see what *would* have happened with the other config

### 2.2 Solution

An instance-profile architecture where the same codebase supports multiple named runtime profiles. Each profile has:
- its own SQLite database (strategy, positions, decisions)
- its own process identity (`INSTANCE_ID`)
- shared read access to harvester data and signal streams
- hard isolation from live execution

### 2.3 User Stories

| # | As the operator I want to... | So that... |
|---|------|------|
| U1 | Run a shadow bot with different filter thresholds | I can see what I'm missing without risking capital |
| U2 | See shadow's dry-run entries compared to primary's live entries | I can decide whether to adopt shadow's config |
| U3 | Change shadow config without touching primary | Experiments don't disrupt the live bot |
| U4 | Know that shadow literally cannot trade | I sleep well |
| U5 | Keep shadow's wallet data fresh from the same harvester | Comparisons are apples-to-apples |
| U6 | Get a drift report when primary changes that shadow hasn't absorbed | I know when shadow data is stale |
| U7 | Bootstrap shadow from primary's current state | I don't start from zero |

### 2.4 Out of Scope (v1)

- Shadow Telegram command control (v1 is CLI-only config)
- Multiple shadow instances (v1 supports exactly one)
- Auto-apply shadow results to primary
- Shadow live execution (never, by design)
- Birdeye integration (not currently implemented in primary)
- Shared enrichment cache between primary and shadow (v2 optimization)

### 2.5 Success Criteria

1. Shadow process runs for 7 days without crash or DB corruption
2. Shadow evaluates the same signal set as primary (signal parity proof)
3. Shadow produces dry-run positions with its own config
4. Charon Intelligence report distinguishes primary vs shadow candidates/decisions
5. Shadow cannot execute a swap under any configuration (safety proof)

---

## 3. TECH DESIGN

### 3.1 Instance Profile Architecture

```
Environment Variable          Primary              Shadow
─────────────────────────────────────────────────────────────
INSTANCE_ID                   primary              shadow
DB_PATH                       /opt/trading-data/   /opt/trading-data/
                              charon.sqlite        charon-shadow.sqlite
HARVESTER_DB_PATH             /opt/trading-data/harvester.db (shared, read-only)
TRADING_MODE                  dry_run (current)    dry_run (forced)
SHADOW_MODE                   (absent)             true
LIVE_EXECUTION_DISABLED       (absent)             true
TELEGRAM_POLLING_ENABLED      (absent/true)        false
SIGNAL_SERVER_URL             http://localhost:3456 (shared)
SIGNAL_SERVER_KEY             (shared)             (shared)
JUPITER_API_KEY               <key> (swap + data)  <key> (data only — see 3.10)
```

### 3.2 Hard Shadow Safety (Defense in Depth)

**Critical implementation constraint:** `src/config.js` exports `SOLANA_PRIVATE_KEY` as a module-level `const` on line 22. `src/liveExecutor.js` imports this value at module load (line 9). Because ES module imports are static bindings resolved at parse time, you cannot "scrub" the env var after config.js has already exported it. The safety design must account for this.

**Layer 1 — Config-level suppression (source of truth):**
In `src/config.js`, the `SOLANA_PRIVATE_KEY` export itself must be conditional:

```javascript
export const SHADOW_MODE = process.env.SHADOW_MODE === 'true';
export const SOLANA_PRIVATE_KEY = SHADOW_MODE
  ? ''  // hard empty — shadow never sees wallet material
  : (process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '');
```

This ensures that when `liveExecutor.js` imports `SOLANA_PRIVATE_KEY`, it receives `''` in shadow mode regardless of what's in the environment. The env var is never read into the exported constant.

**Layer 2 — initLiveExecution() kill switch:**
`src/liveExecutor.js` `initLiveExecution()` adds an explicit early-return:

```javascript
export function initLiveExecution() {
  if (process.env.LIVE_EXECUTION_DISABLED === 'true') {
    console.log('[shadow] live execution disabled by LIVE_EXECUTION_DISABLED');
    return;
  }
  if (!SOLANA_PRIVATE_KEY) return;
  // ... existing wallet loading logic
}
```

**Layer 3 — Startup assertion (uses raw DB value, not the overridden one):**
`src/app.js` after `initLiveExecution()` AND after `initDb()`:

```javascript
import { rawTradingMode } from './db/positions.js';

// After initDb() and initLiveExecution():
if (SHADOW_MODE && hasLiveWallet()) {
  console.error('[FATAL] shadow mode active but live wallet was loaded — aborting');
  process.exit(1);
}
const dbMode = rawTradingMode();
if (SHADOW_MODE && dbMode !== 'dry_run') {
  console.error('[FATAL] shadow DB has trading_mode=' + dbMode + ' — must be dry_run. Fix DB before starting shadow.');
  process.exit(1);
}
```

**Important design notes:**
- The startup assertion must read the *raw* DB value, not the overridden one. If `tradingMode()` always returns `'dry_run'` in shadow mode, the assertion would be masked and never fire. The raw check catches a bad bootstrap (e.g., someone cloned `settings.trading_mode = 'live'` from primary without resetting it).
- Use `hasLiveWallet()` (new boolean helper) for the assertion, NOT `getLiveWallet()`. Current code only exposes `liveWalletPubkey()` (returns pubkey string or null). Adding `getLiveWallet()` would expose the Keypair object unnecessarily. Instead add:
  ```javascript
  export function hasLiveWallet() { return liveWallet !== null; }
  ```
  This keeps the Keypair private to the module while allowing external assertion checks.

**Layer 4 — tradingMode() split into raw and effective:**
`src/db/positions.js` gains two functions:

```javascript
import { SHADOW_MODE } from '../config.js';

// Returns the actual DB value — used only for assertions and drift reports
export function rawTradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

// Returns the effective runtime mode — used for all execution branching
export function tradingMode() {
  if (SHADOW_MODE) return 'dry_run'; // hard override — shadow is always dry_run
  return rawTradingMode();
}
```

All existing callers of `tradingMode()` (orchestrator, callbacks.js, etc.) use the effective version — they always see `'dry_run'` in shadow mode. The startup assertion and drift reports use `rawTradingMode()` to detect misconfigured DB state.

**Layer 5 — All executeLiveBuy/executeLiveSell call sites guarded:**

There are multiple live execution call sites that must be guarded:

| Call site | Location | Guard needed |
|-----------|----------|--------------|
| `executeLiveBuy` (pipeline) | `src/pipeline/orchestrator.js:196` | Covered by `tradingMode()` override (Layer 4) — pipeline checks mode before calling |
| `executeLiveBuy` (manual Telegram callback) | `src/telegram/callbacks.js:105` | Covered by `tradingMode()` override — line 104 checks `tradingMode() === 'live'` |
| `executeLiveSell` (position monitoring) | `src/execution/positions.js:165,245` | Covered by position `execution_mode` field — shadow positions are always `'dry_run'` |
| `executeLiveSell` (Telegram command) | `src/telegram/commands.js:210` | Covered by `row.execution_mode === 'live'` check — shadow positions never have this |
| `executeLiveBuy` (router.js definition) | `src/execution/router.js:105` | Add shadow guard at top of function body as final defense |
| `executeLiveSell` (router.js definition) | `src/execution/router.js:143` | Add shadow guard at top of function body as final defense |

**Defense at the router function level (fail loudly, never silently convert):**

Reaching `executeLiveBuy()` or `executeLiveSell()` in shadow mode is an invariant violation — it means upstream guards (tradingMode override, position execution_mode checks) were bypassed. This must NOT silently create a dry-run position (which would hide the breach). Instead, throw a typed error that the safety verifier can test for:

```javascript
// src/execution/router.js
import { SHADOW_MODE } from '../config.js';

class ShadowExecutionBlockedError extends Error {
  constructor(fn) {
    super(`[FATAL] ${fn} called in SHADOW_MODE — invariant breach, all upstream guards failed`);
    this.name = 'ShadowExecutionBlockedError';
  }
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  if (SHADOW_MODE) {
    throw new ShadowExecutionBlockedError('executeLiveBuy');
  }
  // ... existing logic
}

export async function executeLiveSell(position, reason) {
  if (SHADOW_MODE) {
    throw new ShadowExecutionBlockedError('executeLiveSell');
  }
  // ... existing logic
}

export { ShadowExecutionBlockedError };
```

**Rationale:** Dry-run position creation happens only in the normal dry-run branch (orchestrator sees `tradingMode() === 'dry_run'`). If control somehow reaches the live function in shadow, that's a bug — fail loudly so it's caught in testing, not hidden behind a silent fallback.

**Layer 6 — Missing swap key (PM2 config level):**
Shadow PM2 profile intentionally omits `SOLANA_PRIVATE_KEY`. `JUPITER_API_KEY` IS provided for data access (see section 3.10), but `requireLiveExecution()` in `liveExecutor.js` will still throw because `SOLANA_PRIVATE_KEY` is empty (Layer 1) and `liveWallet` is null.

**Safety layer interaction:**

```
Shadow process starts
  → config.js: SOLANA_PRIVATE_KEY = '' (Layer 1)
  → config.js: SHADOW_MODE = true
  → liveExecutor imports '': no wallet material available
  → initLiveExecution(): LIVE_EXECUTION_DISABLED check (Layer 2) → early return
  → initDb(): schema created, settings loaded
  → app.js assertion: hasLiveWallet() === false ✓, rawTradingMode() === 'dry_run' ✓ (Layer 3)
  → tradingMode(): returns 'dry_run' always in shadow (Layer 4)
  → app.js assertion: liveWallet === null ✓, tradingMode() === 'dry_run' ✓ (Layer 3)
  → any candidate reaching orchestrator: tradingMode() === 'dry_run' → dry-run path (Layer 4)
  → any Telegram callback: tradingMode() === 'dry_run' → never calls executeLiveBuy (Layer 4)
  → if somehow reaching router functions: SHADOW_MODE guard → blocked (Layer 5)
  → if somehow reaching Jupiter swap: requireLiveExecution() throws — no wallet (Layer 6)
```

### 3.3 Telegram Isolation

**Critical implementation constraint:** `src/telegram/bot.js` line 4 creates the bot with polling at module import time:
```javascript
export const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
```

**Full audit of `bot` import sites (all must be migrated):**

| File | Import style | Usage |
|------|-------------|-------|
| `src/telegram/send.js:1` | `import { bot } from './bot.js'` | Sending messages |
| `src/telegram/commands.js:1` | `import { bot } from './bot.js'` | Handler registration (`bot.onText`, `bot.on`) |
| `src/telegram/callbacks.js:1` | `import { bot } from './bot.js'` | Callback query handling (`bot.on('callback_query')`) |
| `src/telegram/input.js:1` | `import { bot } from './bot.js'` | Message listener for numeric input |
| `src/learning/commands.js:1` | `import { bot } from '../telegram/bot.js'` | Learning command handlers |
| `src/telegram/menus.js:451,459` | `const { bot } = await import('./bot.js')` | Dynamic import for sendMessage/editMessageText |
| `src/execution/router.js:17` | `const { bot } = await import('../telegram/bot.js')` | Dynamic import for alert sending |

**Required restructuring — lazy bot factory:**

```javascript
// src/telegram/bot.js (revised)
import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_POLLING_ENABLED } from '../config.js';

let _bot = null;

export function getBot() {
  if (!_bot) {
    _bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
      polling: TELEGRAM_POLLING_ENABLED
    });
  }
  return _bot;
}

// Backward-compatible named export — getter-backed proxy
// This allows `import { bot } from './bot.js'` to keep working
// while deferring construction to first access.
export { getBot as bot };
```

**Wait — `export { getBot as bot }` won't work because callers use `bot.sendMessage()` not `bot().sendMessage()`.** The correct migration is:

**Option A (cleanest): Change all import sites to use `getBot()`.**

Every file that does `import { bot } from './bot.js'` changes to `import { getBot } from './bot.js'` and replaces `bot.xyz()` with `getBot().xyz()`. This is mechanical but touches 7 files.

**Option B (compatibility shim): Use a module-level Proxy.**

```javascript
// src/telegram/bot.js (revised — Proxy approach)
import TelegramBot from 'node-telegram-bot-api';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_POLLING_ENABLED } from '../config.js';

let _bot = null;

function ensureBot() {
  if (!_bot) {
    _bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
      polling: TELEGRAM_POLLING_ENABLED
    });
  }
  return _bot;
}

// Proxy allows `bot.sendMessage(...)` to work without changing import sites
export const bot = new Proxy({}, {
  get(_, prop) { return ensureBot()[prop]; }
});

export { ensureBot as getBot };
```

**Decision for ticket: Use Option A (explicit `getBot()` migration).** Proxies are fragile with `this` binding in class methods. The mechanical rename across 7 files is safer and more obvious.

**Migration checklist (all files):**
1. `src/telegram/bot.js` → lazy `getBot()` factory
2. `src/telegram/send.js` → `import { getBot } from './bot.js'`; use `getBot()` calls
3. `src/telegram/commands.js` → same pattern
4. `src/telegram/callbacks.js` → same pattern
5. `src/telegram/input.js` → same pattern
6. `src/telegram/menus.js` → dynamic imports already call `.bot`, change to `const { getBot } = await import('./bot.js'); const bot = getBot();`
7. `src/execution/router.js` → same dynamic import pattern
8. `src/learning/commands.js` → `import { getBot } from '../telegram/bot.js'`

**v1 decision:** Shadow Telegram polling disabled. Shadow can still send tagged alerts via `getBot().sendMessage()` (the bot object works for sending without polling). All shadow messages are prefixed `[SHADOW]`.

**Config default:** `TELEGRAM_POLLING_ENABLED` absent → `true` (backward compatible; primary behavior unchanged).

**setupTelegram() must be a no-op in shadow mode:**

`src/app.js` line 20 calls `setupTelegram()` unconditionally. Current `setupTelegram()` in `commands.js:270` calls `bot.setMyCommands()` and registers callback/message handlers. In shadow mode:
- `setMyCommands()` would mutate the shared Telegram bot's command menu (visible to user in chat)
- Handler registration is inert without polling, but still allocates listeners

**Required behavior:** `setupTelegram()` must early-return when `TELEGRAM_POLLING_ENABLED=false`:

```javascript
export function setupTelegram() {
  if (!TELEGRAM_POLLING_ENABLED) {
    console.log('[shadow] Telegram command registration skipped (polling disabled)');
    return;
  }
  getBot().setMyCommands([...]).catch(...);
  getBot().on('callback_query', ...);
  // ... existing handler registration
}
```

This prevents shadow from mutating Telegram command state or allocating inert handlers. Shadow's send-only path goes through `sendTelegram()` in `send.js` which calls `getBot().sendMessage()` directly — that works without handlers or polling.

### 3.4 Database Isolation & Drift Sync

**Shadow DB location:** `/opt/trading-data/charon-shadow.sqlite`

**Bootstrap process (one-time + on-demand):**

```
shadow_bootstrap.js --source /opt/trading-data/charon.sqlite
                    --target /opt/trading-data/charon-shadow.sqlite
                    --mode {clone | sync | report}
```

| Mode | Behavior |
|------|----------|
| `clone` | Creates fresh shadow DB from primary. Copies all baseline tables. Does NOT copy experiment-output tables. |
| `sync` | Updates shadow from primary: new wallets, schema migrations, baseline data (preserves shadow overrides). |
| `report` | Dry-run: shows what would change without writing. |

**Complete table inventory** (from `src/db/connection.js` — 20 tables + indexes):

| Category | Tables | Sync behavior | Rationale |
|----------|--------|---------------|-----------|
| **Baseline — always copy** | `saved_wallets` | Auto-sync: upsert new/updated wallets | Wallet intelligence must match primary for fair comparison |
| | `mint_blacklist` | Auto-sync: copy new entries | Blacklisted mints affect screening; shadow must reject the same bad mints |
| | `deployer_observations` | Auto-sync: copy new entries | Deployer reputation affects candidate scoring |
| | `learning_lessons` (status='active') | Auto-sync: copy active lessons | Active lessons influence LLM context and filter behavior |
| | `learning_runs` | Auto-sync: copy with lessons | Provides context for active lessons |
| **Baseline — copy with override protection** | `settings` | Sync non-overridden keys only | Shadow needs baseline config but owner-tuned values must be preserved |
| | `strategies` | Sync non-overridden strategies only | Same — shadow experiments with different strategy params |
| **Structural — always match** | Schema (all CREATE TABLE + CREATE INDEX statements) | Auto-sync via migration replay | Schema mismatch = runtime crash |
| **Experiment output — never copy** | `candidates` | Shadow-generated only | Shadow's own evaluation results |
| | `dry_run_positions` | Shadow-generated only | Shadow's own positions |
| | `dry_run_trades` | Shadow-generated only | Shadow's own trade events |
| | `tp_sl_rules` | Shadow-generated only | Keyed to `position_id` — shadow positions have their own TP/SL rules |
| | `llm_decisions` | Shadow-generated only | Shadow's own LLM verdicts |
| | `llm_batches` | Shadow-generated only | Shadow's own batch picks |
| | `llm_usage_events` | Shadow-generated only | Shadow's own LLM cost tracking |
| | `decision_logs` | Shadow-generated only | Shadow's own decision trail |
| | `signal_events` | Shadow-generated only | Shadow logs its own signal intake |
| | `screening_events` | Shadow-generated only | Shadow's own filter/screening audit trail |
| | `trade_intents` | Shadow-generated only | Shadow never creates confirm-mode intents (always dry_run) |
| **Operational — never copy** | `alerts` | Shadow-generated only | Shadow sends its own Telegram alerts |
| | `price_alerts` | Shadow-generated only | Shadow monitors its own dip-buy alerts independently |

**Notes on classification:**
- `tp_sl_rules`: Uses `position_id` as primary key. Since positions are not copied (they're experiment output), copying tp_sl_rules would create orphaned records pointing to nonexistent positions. Shadow generates its own tp_sl_rules for its own positions.
- `price_alerts`: Tracks dip-buy strategy price monitoring. Shadow should generate its own alerts based on its own strategy config, not inherit primary's alert state.
- `settings`: Baseline with override protection — the `_shadow_overrides` table marks which keys are owner-tuned.
- `alerts` (Telegram alerts table): Shadow-generated only — shadow sends its own notifications.
- Table count verification: settings, saved_wallets, candidates, alerts, llm_decisions, llm_batches, llm_usage_events, dry_run_positions, dry_run_trades, tp_sl_rules, trade_intents, decision_logs, signal_events, screening_events, mint_blacklist, deployer_observations, learning_runs, learning_lessons, strategies, price_alerts = **20 tables**.

**Override tracking — separate shadow-only metadata table:**

Adding `shadow_override` columns to `settings`/`strategies` would make the shadow schema diverge from primary's, contradicting the "schema must match" structural requirement. Instead, overrides are tracked in a shadow-only table that does not exist in primary:

```sql
CREATE TABLE IF NOT EXISTS _shadow_overrides (
  table_name TEXT NOT NULL,
  key_value TEXT NOT NULL,
  marked_at_ms INTEGER NOT NULL,
  PRIMARY KEY (table_name, key_value)
);
```

- `table_name` = 'settings' or 'strategies'
- `key_value` = the `key` (for settings) or `id` (for strategies)
- Sync checks this table before overwriting a row: if marked, preserve shadow value and report drift

**Schema parity rule:** All `CREATE TABLE` and `CREATE INDEX` statements in the main schema block must be identical between primary and shadow. The `_shadow_overrides` table is the only shadow-exclusive table, and it's explicitly whitelisted in the drift checker as "expected shadow-only schema delta."

**Drift report output:**

```
SHADOW DRIFT REPORT — 2026-05-17T14:30:00Z
──────────────────────────────────────────
Schema version:     primary=47  shadow=47  ✓ match
Wallet count:       primary=908 shadow=905 ⚠ 3 new in primary
Blacklist count:    primary=42  shadow=42  ✓ match
Active lessons:     primary=8   shadow=8   ✓ match
Deployer obs:       primary=156 shadow=153 ⚠ 3 new in primary
Settings drift:     2 keys differ (shadow overrides)
  - llm_min_confidence: primary=75, shadow=65 [OVERRIDE]
  - max_open_positions: primary=3, shadow=5 [OVERRIDE]
Strategy drift:     1 strategy differs
  - sniper.min_mcap_usd: primary=50000, shadow=30000 [OVERRIDE]
Provider freshness: GMGN cache <5m ✓ | Jupiter cache <20s ✓
Action:             Run `shadow_sync.js --mode sync` to pull 6 new baseline rows
```

### 3.5 Signal Stream Parity

**v1 decision: Both processes poll the same signal server independently.**

Rationale:
- Signal server is HTTP polling (every 30s), not websocket push
- Two pollers at 30s intervals on the same local signal server is negligible load
- Timing differences of up to 30s are acceptable for daily comparison
- A shared signal ledger adds complexity without proportional value in v1

**Parity verification:** Both instances must log a `signal_batch_id` so Charon Intelligence can compare overlap. However, the current `serverClient.js` does NOT produce a batch ID — it builds `signalMeta` without one and stores signal events without a batch identifier.

**Required task (M4 or M5 prerequisite):** Derive and persist a signal batch identity. Options:
- Use the signal server's response timestamp + content hash as a deterministic batch ID
- Use a server-provided ID if the signal server returns one in the response
- At minimum: store the poll timestamp as `batch_at_ms` in `signal_events` so both instances' signal intake can be compared by time window

This is NOT an M1 task (M1 is safety only), but must be completed before claiming signal parity proof in M5/M6. Add as an explicit M4 subtask.

### 3.6 Provider Rate Limit Strategy

| Provider | Current rate | Shadow impact | Mitigation |
|----------|-------------|---------------|------------|
| GMGN | 2.5s serial queue, backoff on 429/403 | Worst case: 2x calls when shadow evaluates different candidates than primary | Acceptable given 2.5s pacing per call; monitor 429 rate in shadow logs |
| Jupiter datapi | Backoff on 429 with `x-ratelimit-reset` | Worst case: 2x holder/chart calls | Jupiter is generous; independent backoff per process |
| Jupiter swap API | N/A for shadow | Zero — shadow never calls swap (no wallet, router guard blocks) | Hard guarantee |
| Signal server | Local, unlimited | Negligible — one extra 30s poll | No mitigation needed |
| LLM (MiniMax) | 90s timeout per call | Cost doubled for candidates evaluated by both | Owner should monitor LLM spend. Shadow LLM can be disabled via `ENABLE_LLM=false` if cost is a concern. |

**v2 optimization (out of scope):** A shared enrichment cache (SQLite WAL or file-based) could eliminate duplicate GMGN/Jupiter calls for the same mint within a time window.

### 3.7 Instance Identity in Outputs

Every log line and report output includes `INSTANCE_ID`:
- Logs: `[primary]` or `[shadow]` prefix on all console output
- Instance isolation is achieved via separate DB files, not per-row column markers
- Charon Intelligence identifies instance by which DB file it's reading
- Telegram alerts from shadow carry `[SHADOW]` prefix in message text

### 3.8 Charon Intelligence Integration

**Critical constraint:** Current Charon Intelligence helpers (`scripts/_common.py`) open a single hardcoded `charon.sqlite` path. `sync_vps.sh` pulls only the primary DB and WAL files. This is not a flag addition — it requires a multi-DB snapshot abstraction.

**Required changes (M6 scope):**

1. **Snapshot layer:** `sync_vps.sh` pulls both DBs into named subdirectories:
   ```
   data/vps-snapshots/latest/primary/charon.sqlite
   data/vps-snapshots/latest/shadow/charon-shadow.sqlite
   ```

2. **DB access abstraction:** `scripts/_common.py` gains a `get_db(instance='primary')` function that resolves the correct path. All analysis scripts that currently call `get_db()` continue to work (default=primary).

3. **Comparison mode:** New `scripts/compare_instances.py` that:
   - Opens both DBs read-only
   - Compares candidates by mint+time window (which mints did each instance evaluate?)
   - Compares filter outcomes (what did shadow pass that primary rejected, and vice versa?)
   - Compares dry-run PnL outcomes (shadow entries that would have been winners)
   - Produces `reports/latest_shadow_comparison.md`

4. **Existing scripts gain `--instance` flag:** `analyze_trades.py`, `analyze_filters.py`, `analyze_llm_decisions.py` accept `--instance {primary|shadow}` to scope analysis.

**This is a significant M6 task, not a trivial flag addition.** It should be its own bounded Architect ticket after M5 proves the shadow process is stable.

### 3.9 PM2 Configuration (Target State)

```javascript
// ecosystem.config.cjs addition (M5 scope — NOT implemented until safety is proven)
{
  name: "charon-shadow",
  cwd: "/home/opc/charon",
  script: "/home/opc/charon/start-charon.sh",
  autorestart: true,
  max_restarts: 5,
  restart_delay: 5000,
  env: {
    NODE_ENV: "production",
    INSTANCE_ID: "shadow",
    SHADOW_MODE: "true",
    LIVE_EXECUTION_DISABLED: "true",
    DB_PATH: "/opt/trading-data/charon-shadow.sqlite",
    HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
    TRADING_MODE: "dry_run",
    TELEGRAM_POLLING_ENABLED: "false",
    JUPITER_API_KEY: "<same data key — used for enrichment, NOT swaps>",
    // SOLANA_PRIVATE_KEY intentionally absent
  }
}
```

### 3.10 JUPITER_API_KEY: Data vs Swap Usage

**Problem:** `JUPITER_API_KEY` is used for two purposes:
1. **Swap execution** (in `src/liveExecutor.js`) — signs and submits Jupiter swap transactions
2. **Data access** (in `src/signals/trending.js`) — fetches Jupiter trending tokens for signal discovery

If shadow runs in signal-server mode (polling `SIGNAL_SERVER_URL`), it does NOT use the trending endpoint directly — the signal server provides those signals. However, if for any reason shadow needs standalone/trending mode, or if future enrichment uses the Jupiter authenticated endpoint, the key is needed for data.

**v1 Decision:**
- Shadow PM2 profile DOES include `JUPITER_API_KEY` for data access
- Shadow safety is NOT dependent on missing Jupiter key — it depends on Layers 1-5 (no wallet, no execution path)
- `requireLiveExecution()` in `liveExecutor.js` still throws for shadow because `liveWallet === null` (it checks both key AND wallet)
- The Layer 6 description is updated: the primary guard is missing wallet, not missing Jupiter key

**This is safer than omitting the key**, because:
- Omitting it could break enrichment/data paths in unexpected ways
- The 5 code-level safety layers are the real guarantees, not env-var omission
- If in the future Jupiter datapi requires auth, shadow won't silently degrade

---

## 4. REQUIREMENTS

### Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR1 | Shadow process starts from same codebase with different env profile | Must |
| FR2 | Shadow uses its own SQLite DB at a configurable path | Must |
| FR3 | Shadow cannot execute live swaps under any configuration | Must |
| FR4 | Shadow does not poll Telegram for commands | Must |
| FR5 | Shadow can send tagged `[SHADOW]` notifications to Telegram | Should |
| FR6 | Shadow evaluates same signal stream as primary | Must |
| FR7 | Shadow strategy/settings are independently configurable | Must |
| FR8 | Bootstrap script creates shadow DB from primary baseline | Must |
| FR9 | Sync script updates shadow with new wallets/schema/blacklist/lessons from primary | Must |
| FR10 | Sync preserves shadow-marked overrides | Must |
| FR11 | Drift report shows primary vs shadow state differences for all baseline tables | Must |
| FR12 | Instance ID appears in log prefix | Must |
| FR13 | Charon Intelligence can ingest both DBs via multi-DB abstraction and produce comparison reports | Should |
| FR14 | CLI tool to change shadow settings targeting shadow DB | Must |
| FR15 | Shadow startup fails hard if live wallet loaded or tradingMode() != dry_run | Must |
| FR16 | Telegram bot module restructured to lazy factory; all 7 import sites migrated | Must |
| FR17 | `tradingMode()` returns 'dry_run' unconditionally when SHADOW_MODE=true | Must |
| FR18 | `executeLiveBuy()` and `executeLiveSell()` have shadow guards at function definition | Must |

### Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF1 | Shadow adds <100MB RSS and <5% CPU overhead to VPS |
| NF2 | Shadow does not cause primary to hit provider rate limits it wouldn't hit alone |
| NF3 | Shadow DB corruption does not affect primary DB (separate file, no shared WAL) |
| NF4 | Shadow can be stopped/restarted independently of primary |
| NF5 | No code duplication — same source, different config |
| NF6 | Primary Charon behavior is unchanged when shadow env vars are absent |

---

## 5. TASK LIST / MILESTONE BREAKDOWN

### M0: Planning (this document) ✓

### M1: Instance Profile & Hard Shadow Safety

| Task | Description |
|------|-------------|
| M1.1 | Add `INSTANCE_ID`, `SHADOW_MODE`, `LIVE_EXECUTION_DISABLED`, `TELEGRAM_POLLING_ENABLED` to `src/config.js` with correct defaults (absent = primary behavior unchanged) |
| M1.2 | Implement Layer 1: conditional `SOLANA_PRIVATE_KEY` export — empty string when `SHADOW_MODE=true` |
| M1.3 | Implement Layer 2: `initLiveExecution()` early-return when `LIVE_EXECUTION_DISABLED=true` |
| M1.4 | Implement Layer 3: startup assertion in `src/app.js` — checks `hasLiveWallet()` and `rawTradingMode()` (raw DB value, not the overridden one) |
| M1.5 | Implement Layer 4: split `tradingMode()` into `rawTradingMode()` and `tradingMode()` in `src/db/positions.js`; effective version returns `'dry_run'` unconditionally when `SHADOW_MODE=true` |
| M1.6 | Implement Layer 5: `ShadowExecutionBlockedError` thrown at top of `executeLiveBuy()` and `executeLiveSell()` in `src/execution/router.js` — these are invariant-breach guards, not silent fallbacks |
| M1.7 | Restructure `src/telegram/bot.js` to lazy `getBot()` factory with `TELEGRAM_POLLING_ENABLED` control |
| M1.8 | Migrate all 7 `bot` import sites to use `getBot()`: send.js, commands.js, callbacks.js, input.js, menus.js, router.js, learning/commands.js |
| M1.9 | Add early-return to `setupTelegram()` when `TELEGRAM_POLLING_ENABLED=false` — skip `setMyCommands()` and handler registration; log `[shadow] Telegram command registration skipped` |
| M1.10 | Add `[INSTANCE_ID]` prefix to console log output |
| M1.11 | Write `scripts/verify_shadow_safety.js` — sets `CHARON_SKIP_DOTENV=true` before any imports; proves all layers hold under shadow env without reading `.env` |
| M1.12 | Write `tests/shadow-safety.test.js` — process-isolated test cases (each spawns child process with controlled env; see Test Harness Design below) |
| M1.13 | Add `"test"` script to `package.json`: `"node --test tests/"` |
| M1.14 | Verify: `npm run check` still passes (no syntax errors introduced) |
| M1.15 | Verify: grep confirms no file reads `process.env.SOLANA_PRIVATE_KEY` directly (bypassing config.js) |
| M1.16 | Verify: grep confirms no remaining `{ bot }` destructure (static or dynamic) from `bot.js` after migration |

**Owner-visible result:** Run `CHARON_SKIP_DOTENV=true SHADOW_MODE=true LIVE_EXECUTION_DISABLED=true node scripts/verify_shadow_safety.js` and see a green report confirming all safety layers are active.

**M1 scope boundary:** M1 is local code proof only. It does NOT start PM2, does NOT start the bot process, does NOT require VPS access, does NOT read `.env`. Runtime/PM2 verification belongs in M5 after DB bootstrap (M2) and config CLI (M3) are proven.

**Test Harness Design (critical for M1.12):**

ES modules cache at the process level. `SHADOW_MODE`, `SOLANA_PRIVATE_KEY`, `TELEGRAM_POLLING_ENABLED`, and `DB_PATH` are read once at import time in `config.js` and cached as module-level constants. You cannot change them between test cases within one process.

**Required approach: child-process test isolation.**

Each test case spawns a fresh `node` child process with the exact env vars for that scenario:

```javascript
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('Layer 1: config suppresses SOLANA_PRIVATE_KEY in shadow mode', async () => {
  const { stdout } = await exec('node', ['tests/cases/layer1_config_suppression.js'], {
    env: {
      ...minimalEnv(),
      CHARON_SKIP_DOTENV: 'true',
      SHADOW_MODE: 'true',
      SOLANA_PRIVATE_KEY: 'fake-key-material-for-test',
    }
  });
  assert.strictEqual(stdout.trim(), 'PASS');
});
```

Each `tests/cases/layerN_*.js` file is a standalone script that:
1. Sets `process.env.CHARON_SKIP_DOTENV = 'true'` (redundant safety)
2. Dynamically imports the module under test
3. Asserts the expected behavior
4. Prints `PASS` or throws

**validateConfig() dummy env requirement:** `src/app.js` line 13 calls `validateConfig()` at module scope. Any test that imports app.js transitively must provide non-secret dummy values for required vars:

```javascript
function minimalEnv() {
  return {
    PATH: process.env.PATH,
    CHARON_SKIP_DOTENV: 'true',
    TELEGRAM_BOT_TOKEN: 'test:dummy',
    TELEGRAM_CHAT_ID: '123',
    HELIUS_API_KEY: 'test-helius-dummy',
    DB_PATH: ':memory:',  // or temp file
  };
}
```

**Telegram test stubbing:** Tests that exercise `getBot()` or `setupTelegram()` must NOT hit the real Telegram API. Requirements:
- `getBot()` must accept an injectable constructor or respect a `NODE_ENV=test` / `TELEGRAM_BOT_TOKEN=test:*` pattern that creates the bot without connecting
- `node-telegram-bot-api` with `polling: false` and a test-prefixed token does NOT poll or connect — verify this behavior
- M1 tests must assert: zero outbound HTTP calls to `api.telegram.org` during test execution (verify via `--experimental-network-imports` or by stubbing `https.request`)

### M2: Shadow DB Bootstrap & Drift Sync

| Task | Description |
|------|-------------|
| M2.1 | Inventory all 20 tables from `src/db/connection.js` and confirm classification (per section 3.4 table) |
| M2.2 | Create `scripts/shadow_bootstrap.js` with clone/sync/report modes |
| M2.3 | Create shadow-only `_shadow_overrides` table (tracks which settings/strategies keys are owner-tuned) |
| M2.4 | Implement baseline table sync: `saved_wallets`, `mint_blacklist`, `deployer_observations`, `learning_lessons`+`learning_runs` |
| M2.5 | Implement override-aware settings/strategies sync (checks `_shadow_overrides` before overwriting); `settings.trading_mode` is ALWAYS forced to `'dry_run'` in shadow DB and auto-inserted into `_shadow_overrides` during bootstrap/sync — never copies primary's trading_mode value |
| M2.6 | Implement drift report generation (format per section 3.4); drift checker whitelists `_shadow_overrides` as expected shadow-only schema delta |
| M2.7 | Test: clone from primary, verify all 20 table schemas match, verify experiment tables are empty, verify tp_sl_rules and price_alerts are empty |
| M2.8 | Test: sync preserves overrides (entries in `_shadow_overrides`), pulls new wallets/blacklist/lessons |
| M2.9 | Test: adding a blacklisted mint in primary shows up in next sync report |

**Owner-visible result:** Run `node scripts/shadow_bootstrap.js --mode report` and see the drift report.

### M3: Shadow Config CLI

| Task | Description |
|------|-------------|
| M3.1 | Create `scripts/shadow_config.js` — reads/writes settings and strategies in shadow DB |
| M3.2 | Commands: `get <key>`, `set <key> <value>`, `list`, `diff` (vs primary), `mark-override <key>`, `clear-override <key>` |
| M3.3 | `set` automatically inserts/updates the key in `_shadow_overrides` table |
| M3.4 | Test: setting a value in shadow does not affect primary DB |
| M3.5 | Test: `diff` output clearly shows override vs baseline vs missing |

**Owner-visible result:** Run `node scripts/shadow_config.js diff` and see primary vs shadow settings side-by-side.

### M4: Data Enrichment Parity & Signal Identity

| Task | Description |
|------|-------------|
| M4.1 | Verify shadow process can open harvester DB read-only (same `HARVESTER_DB_PATH`) |
| M4.2 | Verify `loadWalletCache()` loads from shadow's own `saved_wallets` after sync |
| M4.3 | Create enrichment freshness report: for each provider (GMGN, Jupiter, OKX via harvester), show last data timestamp in shadow DB |
| M4.4 | Document which enrichment calls shadow will make independently vs. inherit from shared harvester |
| M4.5 | Verify `JUPITER_API_KEY` presence allows trending/enrichment calls without triggering swap paths |
| M4.6 | Add signal batch identity: derive and persist `batch_at_ms` (or content-hash batch ID) in `signal_events` during server polling in `serverClient.js` — enables parity comparison between instances |

**Owner-visible result:** Readiness report showing all data surfaces accessible and fresh. Signal events now carry batch identity for cross-instance comparison.

**Note:** M4 does NOT add PM2 processes. All verification is script-level. PM2 cron for shadow sync belongs in M5 alongside the shadow runtime launch.

### M5: Shadow Runtime (PM2 Process Launch)

| Task | Description |
|------|-------------|
| M5.1 | Add `charon-shadow` definition to `ecosystem.config.cjs` (per section 3.9) |
| M5.2 | Add `charon-shadow-sync` PM2 cron process (runs `shadow_bootstrap.js --mode sync` every 2h) |
| M5.3 | First supervised start of both shadow processes — requires explicit owner approval |
| M5.4 | Verify DB isolation per process: `charon-shadow` main runtime must NOT open `charon.sqlite` (`lsof -p <pid>` check); `charon-shadow-sync` MAY read `charon.sqlite` read-only but must NEVER write it (open with `?mode=ro` or `PRAGMA query_only=ON`) |
| M5.5 | Verify: shadow logs show `[shadow]` prefix on all output |
| M5.6 | Verify: shadow creates dry-run positions in shadow DB only |
| M5.7 | Verify: Telegram polling is NOT active (no command responses from shadow, no setMyCommands mutation) |
| M5.8 | Verify: primary continues unaffected (position monitoring, signal processing, Telegram commands) |
| M5.9 | Verify: PM2 env confirms SOLANA_PRIVATE_KEY absent, SHADOW_MODE=true, LIVE_EXECUTION_DISABLED=true |
| M5.10 | 24h soak test — no crashes, no primary interference, no rate-limit 429s beyond baseline |

**Owner-visible result:** `pm2 status` shows both processes running. Shadow log shows `[shadow]` prefix and dry-run positions appearing. Primary unaffected.

### M6: Charon Intelligence Shadow Comparison

| Task | Description |
|------|-------------|
| M6.1 | Update `sync_vps.sh` to pull shadow DB into `data/vps-snapshots/latest/shadow/` |
| M6.2 | Add `get_db(instance)` abstraction to `scripts/_common.py` (multi-DB snapshot support) |
| M6.3 | Add `--instance` filter to `analyze_trades.py`, `analyze_filters.py`, `analyze_llm_decisions.py` |
| M6.4 | Create `scripts/compare_instances.py` — candidates-by-mint overlap, filter outcome delta, PnL comparison |
| M6.5 | Generate `reports/latest_shadow_comparison.md` |
| M6.6 | Test: report correctly attributes candidates/positions to correct instance |

**Owner-visible result:** A report showing "shadow caught X candidates that primary filtered out; Y of those would have been profitable."

---

## 6. FIRST ARCHITECT TICKET

```
TICKET_ID: CHARON-SHADOW-M1-INSTANCE-PROFILE-AND-SAFETY

END_GOAL_LINK: Shadow Charon running safely beside primary for strategy A/B testing

GOAL: Add instance-profile environment support, restructure Telegram bot to
lazy initialization, implement all 6 hard shadow safety layers, and prove via
local verification that a process configured with SHADOW_MODE=true cannot execute
live trades under any code path — without reading .env or starting runtime.

WHY_NOW: This is the foundation. No other shadow work (DB bootstrap, config CLI,
PM2 launch) is safe until the hard safety layers are proven. It's also the
smallest meaningful unit — pure additive code with no runtime risk to primary.

OWNER_VISIBLE_OUTCOME: A verification script that proves shadow safety by
attempting each execution path and confirming it's blocked. Green output = safe.

OWNER_PROOF: Run the verification script and see all checks pass.

OWNER_CHECK_STEPS:
1. Run: CHARON_SKIP_DOTENV=true SHADOW_MODE=true LIVE_EXECUTION_DISABLED=true node scripts/verify_shadow_safety.js
2. See output: "6/6 safety layers verified ✓"
3. Confirm: no wallet loaded, no live execution path reachable, tradingMode() forced to dry_run,
   rawTradingMode() assertion would catch DB misconfiguration
4. Run: npm run check (existing syntax check still passes — no regression)
5. Run: npm test (new unit tests pass)

FILES_IN_SCOPE:
- src/config.js (add new env vars; conditional SOLANA_PRIVATE_KEY export)
- src/app.js (add startup assertion checking hasLiveWallet() and rawTradingMode())
- src/liveExecutor.js (add LIVE_EXECUTION_DISABLED early-return in initLiveExecution; add hasLiveWallet() boolean export)
- src/db/positions.js (split into rawTradingMode() and tradingMode(); shadow override in effective version)
- src/execution/router.js (add ShadowExecutionBlockedError thrown from executeLiveBuy/executeLiveSell; migrate dynamic bot import)
- src/telegram/bot.js (restructure to lazy getBot() factory with conditional polling)
- src/telegram/send.js (migrate to getBot())
- src/telegram/commands.js (migrate to getBot(); setupTelegram() early-return when polling disabled)
- src/telegram/callbacks.js (migrate to getBot())
- src/telegram/input.js (migrate to getBot())
- src/telegram/menus.js (migrate dynamic import to getBot())
- src/learning/commands.js (migrate to getBot())
- scripts/verify_shadow_safety.js (new — safety verification; sets CHARON_SKIP_DOTENV before imports)
- tests/shadow-safety.test.js (new — unit tests using node:test; sets CHARON_SKIP_DOTENV)
- package.json (add "test" script)

ACCEPTANCE_CRITERIA:
- [ ] INSTANCE_ID, SHADOW_MODE, LIVE_EXECUTION_DISABLED, TELEGRAM_POLLING_ENABLED exported from config.js
- [ ] When SHADOW_MODE=true: SOLANA_PRIVATE_KEY export is '' regardless of env var presence
- [ ] When SHADOW_MODE absent/false: SOLANA_PRIVATE_KEY export works exactly as before (no regression)
- [ ] initLiveExecution() returns early without loading wallet when LIVE_EXECUTION_DISABLED=true
- [ ] Startup assertion uses rawTradingMode() (raw DB value) and hasLiveWallet(): exits code 1 if shadow + wallet present, or shadow + DB trading_mode != 'dry_run'
- [ ] hasLiveWallet() exported from liveExecutor.js as boolean helper (does NOT expose Keypair object)
- [ ] rawTradingMode() reads DB directly without shadow override (for assertions and drift reports)
- [ ] tradingMode() (effective) returns 'dry_run' unconditionally when SHADOW_MODE=true (for all runtime branching)
- [ ] executeLiveBuy() and executeLiveSell() throw ShadowExecutionBlockedError when SHADOW_MODE=true — never silently fall back to dry-run
- [ ] All 7 bot import sites migrated to getBot() pattern — no remaining `import { bot }` from bot.js
- [ ] TELEGRAM_POLLING_ENABLED=false → getBot() creates bot without polling (send-only)
- [ ] TELEGRAM_POLLING_ENABLED absent or true → getBot() creates bot with polling (backward compatible)
- [ ] setupTelegram() early-returns without calling setMyCommands() or registering handlers when TELEGRAM_POLLING_ENABLED=false
- [ ] Primary Charon (no shadow env vars set) behaves identically to before this change
- [ ] verify_shadow_safety.js sets CHARON_SKIP_DOTENV=true before any dynamic import of src/ modules
- [ ] verify_shadow_safety.js exits 0 when all layers hold; exits 1 with explanation when any fails
- [ ] Unit tests are process-isolated: each test case spawns a child process with controlled env (ESM module cache requires this for env-dependent tests)
- [ ] Tests cover all 6 layers: config suppression, initLiveExecution kill switch, startup assertion (raw mode), tradingMode effective override, router ShadowExecutionBlockedError, telegram polling+setupTelegram gate — positive and negative cases
- [ ] Tests provide dummy non-secret values for validateConfig() (TELEGRAM_BOT_TOKEN='test:dummy', TELEGRAM_CHAT_ID='123', HELIUS_API_KEY='test-dummy')
- [ ] Tests make zero outbound HTTP calls to api.telegram.org (verified by stub or assertion)
- [ ] package.json has "test" script: "node --test tests/"
- [ ] npm run check passes (existing syntax validation)
- [ ] node --test tests/shadow-safety.test.js passes
- [ ] grep confirms no file reads process.env.SOLANA_PRIVATE_KEY or process.env.PRIVATE_KEY directly (all go through config.js)
- [ ] grep confirms no remaining `{ bot }` destructure from bot.js — static (`import { bot }`) OR dynamic (`const { bot } = await import`) — all migrated to `{ getBot }`

REQUIRED_CHECKS:
- npm run check (existing syntax check — must still pass)
- node --test tests/shadow-safety.test.js (new unit tests — all pass, process-isolated)
- CHARON_SKIP_DOTENV=true SHADOW_MODE=true LIVE_EXECUTION_DISABLED=true node scripts/verify_shadow_safety.js (all layers verified)
- grep -rn "process.env.SOLANA_PRIVATE_KEY\|process.env.PRIVATE_KEY" src/ (only config.js should match)
- grep -rn "{ bot }" src/ (zero matches after migration — catches both static and dynamic imports)

NOTE: This ticket does NOT require starting the bot process, PM2, or VPS runtime.
All verification is local/unit-level. The safety script sets CHARON_SKIP_DOTENV=true
to avoid reading .env (per repo safety boundary). Runtime launch is M5 scope after
DB bootstrap and config CLI are proven.

RISKS:
- Telegram bot.js restructuring touches 7+ files. The lazy factory pattern must
  preserve the exact behavior of command registration, callback handling, and
  input listeners. Specifically: commands.js and callbacks.js register handlers
  via bot.onText/bot.on — these must work with the getBot() instance. Test that
  handlers are actually registered and respond to mock messages.
- setupTelegram() currently uses `bot` directly (line 271: bot.setMyCommands).
  After migration it must use getBot(). The early-return for shadow must come
  before getBot() is called to avoid instantiating the bot at all if not needed.
  However: send.js may still call getBot() for alerts. That's fine — getBot()
  should still create a send-only bot; the early-return only skips command registration.
- The rawTradingMode()/tradingMode() split adds a config.js import to positions.js.
  Verify no circular dependency (positions.js → config.js → ? → positions.js).
- router.js has both a static import change (for SHADOW_MODE/ShadowExecutionBlockedError)
  and a dynamic import change (for bot migration). Both changes are in-scope but test independently.
- The ShadowExecutionBlockedError is an invariant-breach detector. In production shadow,
  it should never fire (tradingMode() prevents reaching executeLiveBuy). But it MUST fire
  in unit tests to prove the guard works. Test by directly calling executeLiveBuy() in
  shadow mode and asserting the error is thrown.
- If any file other than config.js reads process.env.SOLANA_PRIVATE_KEY or
  process.env.PRIVATE_KEY directly, those are bypass vectors. The grep check catches this.

ESCALATE_IF:
- Circular dependency detected between positions.js and config.js
- Telegram handler registration requires bot to exist at module-load time (not at
  setupTelegram() call time) — would need deeper restructuring
- More than the 7 identified files import bot from bot.js (grep may reveal more)
- executeLiveBuy or executeLiveSell have additional call sites beyond the 4 identified
- verify_shadow_safety.js cannot avoid loading .env even with CHARON_SKIP_DOTENV
  (e.g., if a transitive dependency loads dotenv unconditionally)
- node-telegram-bot-api with polling:false and test-prefixed token still makes
  network calls (would need a full stub/mock injection layer)
- Child-process test approach has reliability issues on CI (timing, exit codes)
  that prevent consistent green runs
```

---

## 7. VERIFICATION PLAN

### Safety Verification (M1 — proves shadow is isolated, local only, no .env read)

All M1 tests set `CHARON_SKIP_DOTENV=true` before importing any `src/` modules.

| Check | Method | Pass criteria |
|-------|--------|---------------|
| Config suppression | In shadow mode, import `SOLANA_PRIVATE_KEY` from config.js with env var set to real-looking value; assert it's `''` | Empty string |
| No wallet loaded | Call `initLiveExecution()` with `LIVE_EXECUTION_DISABLED=true`; check `hasLiveWallet()` | Returns `false` |
| rawTradingMode catches bad DB | Create temp DB with `settings.trading_mode = 'live'`; call `rawTradingMode()` | Returns `'live'` (proving the raw function does NOT mask it) |
| tradingMode effective override | Same temp DB; call `tradingMode()` in shadow mode | Returns `'dry_run'` (proving the effective override works) |
| Startup assertion fires on bad DB | With `SHADOW_MODE=true` + DB `trading_mode='live'`; simulate startup assertion logic; expect would-exit-1 | Assertion triggers |
| Router guard (buy) throws | Call `executeLiveBuy()` in shadow mode; assert `ShadowExecutionBlockedError` thrown | Error thrown with correct name |
| Router guard (sell) throws | Call `executeLiveSell()` in shadow mode; assert `ShadowExecutionBlockedError` thrown | Error thrown with correct name |
| No Telegram polling | In shadow mode, call `getBot()`; check bot's polling state | `polling === false` |
| setupTelegram no-op | In shadow mode, call `setupTelegram()`; verify `setMyCommands` not called | No command registration |
| Env bypass impossible | With `SHADOW_MODE=true`, set `SOLANA_PRIVATE_KEY=<value>` in env; verify config.js export is `''` | Empty string |
| No direct env reads | `grep -rn "process.env.SOLANA_PRIVATE_KEY\|process.env.PRIVATE_KEY" src/` | Only config.js matches |
| All executeLiveBuy call sites covered | grep all call sites; verify each is guarded by tradingMode() check or router guard | All 4 call sites blocked |
| No .env loaded in tests | verify_shadow_safety.js logs `CHARON_SKIP_DOTENV=true`; no dotenv.config() called | Confirmed |

### Accuracy Verification (M5+ — proves shadow is real-world comparable)

| Check | Method | Pass criteria |
|-------|--------|---------------|
| Signal parity | After 24h, compare `signal_events` tables in both DBs by `kind`+`mint`+`batch_at_ms` window (requires M4.6 batch identity) | >95% overlap within 60s window |
| Enrichment parity | Compare GMGN/Jupiter data freshness for same mints in both DBs | <5min difference |
| Wallet data parity | Compare `saved_wallets` count after sync | Same count |
| Blacklist parity | Compare `mint_blacklist` count after sync | Same count |
| LLM evaluation parity | For candidates both configs permit, compare LLM call rate | Both evaluate same eligible candidates |

### Isolation Verification (M5+ — proves no cross-contamination)

| Check | Method | Pass criteria |
|-------|--------|---------------|
| DB file isolation | `lsof -p <shadow_pid>` shows only `charon-shadow.sqlite`, never `charon.sqlite` | Separate file handles |
| Position isolation | Shadow creates position; query primary DB for same mint+time | Not present in primary |
| Config isolation | Change setting via shadow_config.js; read same key from primary DB | Primary value unchanged |
| Telegram alert tagging | Shadow sends alert; check received message text | Contains `[SHADOW]` prefix |
| No primary disruption | While shadow runs, primary continues normal operation | Primary logs show no errors or behavioral change |
| PM2 env verification | `pm2 env charon-shadow` confirms SHADOW_MODE=true, no SOLANA_PRIVATE_KEY | Env correct |

---

## 8. OPEN QUESTIONS — RESOLVED

| Question | Decision | Rationale |
|----------|----------|-----------|
| Real-time polling or replay? | Real-time polling | Simpler; 30s timing delta is acceptable for daily comparison |
| Clone DB or seed from scratch? | Clone baseline tables, empty experiment tables | Best of both: realistic state without polluting shadow decisions |
| Which tables are baseline vs experiment? | Full inventory in section 3.4 (20 tables classified) | Every table from connection.js accounted for |
| Shadow Telegram initially? | Disabled polling; send-only via lazy factory | Eliminates collision risk cleanly |
| Birdeye part of this? | No — not currently implemented in primary code | Separate provider milestone if/when added |
| Same LLM provider/budget? | Same provider; cost trackable via `llm_usage_events` in shadow DB | Keeps comparison fair; owner can disable shadow LLM if cost is concern |
| Slippage/fee assumptions? | Shadow uses same dry-run assumptions as primary dry-run | Fair comparison; live vs dry-run delta is a known limitation acknowledged in reports |
| How long before comparison? | 7 days minimum soak | Enough signal volume and market regime coverage |
| Module-load order for key suppression? | Conditional export in config.js (not env scrub) | ES module static bindings require the source of truth to be correct at export time |
| How to handle bot.js side-effect? | Lazy factory pattern (`getBot()`) with explicit migration of all 7 import sites + setupTelegram() no-op | Only clean way to conditionally control polling AND prevent setMyCommands mutation |
| What test runner to use? | `node --test` (node:test built-in) | No test framework in dependencies; add `"test": "node --test tests/"` to package.json |
| Should M1 start PM2 / runtime? | No — M1 is local code proof only | Runtime checks need owner approval and belong in M5 |
| Should JUPITER_API_KEY be omitted for shadow? | No — keep it for data access | Safety doesn't depend on missing key; depends on code-level guards + missing wallet |
| Should tp_sl_rules be copied as baseline? | No — keyed to position_id; positions aren't copied | Would create orphaned records; shadow generates its own |
| How to guard against DB-backed live mode? | Split: `rawTradingMode()` for assertions, `tradingMode()` for runtime override | Startup assertion sees real DB value; runtime always gets 'dry_run' in shadow |
| How many executeLiveBuy call sites exist? | 4 (orchestrator, callbacks.js, + executeLiveSell in positions.js and commands.js) | All covered by tradingMode() override + router ShadowExecutionBlockedError |
| Should router guards silently fall back? | No — throw ShadowExecutionBlockedError | Reaching live execution in shadow is an invariant breach; fail loudly so it's caught |
| How to store shadow overrides without schema divergence? | Separate `_shadow_overrides` table (shadow-only) | Keeps primary/shadow schemas identical; override tracking is metadata, not schema change |
| Should safety tests read .env? | No — all set CHARON_SKIP_DOTENV=true before imports | Repo safety boundary forbids .env reading; verification must be self-contained |
| Does signal parity need a batch ID? | Yes — current serverClient.js has no batch identity | M4.6 adds `batch_at_ms` to signal_events; required before claiming parity proof |
| Should M4 add PM2 cron? | No — moved to M5 | PM2 cron mutates shadow DB; belongs with runtime launch after owner approval |

---

## End of Planner Deliverable (Revised v5)

**Changes from v4:**
1. Test harness redesigned: process-isolated child-process test cases instead of same-process env mutation. ESM module cache makes same-process env toggling unreliable — each test spawns fresh node with controlled env.
2. `getLiveWallet()` replaced with `hasLiveWallet()` (boolean). Current code only exposes `liveWalletPubkey()` — adding `getLiveWallet()` would leak the Keypair object unnecessarily.
3. M5 DB isolation check now distinguishes processes: `charon-shadow` main runtime must NOT open `charon.sqlite`; `charon-shadow-sync` may read it read-only.
4. `settings.trading_mode` is a protected shadow override: bootstrap/sync ALWAYS forces `'dry_run'` in shadow DB and marks it in `_shadow_overrides`. Prevents primary's live mode from being accidentally synced into shadow.
5. Telegram test stubbing requirement added: tests must prove zero outbound HTTP calls to `api.telegram.org`. Uses dummy token (`test:*`) and `polling: false` to prevent connection.
6. Bot migration grep strengthened: checks for `{ bot }` destructure in both static (`import { bot }`) AND dynamic (`const { bot } = await import`) forms. Previous grep only caught static imports.
7. Stale text fixed: table count 17→20, "Revised v3"→v5, `shadow_override=1`→`_shadow_overrides` table insert.
8. `validateConfig()` dummy env requirement documented: tests must provide non-secret dummy values for TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, HELIUS_API_KEY since validateConfig() runs at app.js module scope.

**Next step:** Owner reviews this plan, confirms it matches intent, then the Architect ticket `CHARON-SHADOW-M1-INSTANCE-PROFILE-AND-SAFETY` is handed to a Coder for implementation.
