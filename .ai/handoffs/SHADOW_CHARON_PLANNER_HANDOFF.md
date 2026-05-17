# Shadow Charon Planner Handoff

Created: 2026-05-17 Asia/Jakarta
Repo: `.`
Consultation repo: `../charon-intelligence`
Target role: Planner agent, then Architect

## Objective

Plan an elegant same-repo **Shadow Charon** runtime: a second Charon instance that can run beside the primary Charon process with:

- independent strategy/config settings
- its own SQLite database
- hard dry-run/shadow-only execution
- the same live signal stream and enrichment quality as primary Charon
- full wallet/smart-money data from the same harvester pipeline
- clear drift detection from primary Charon, with a safe way to apply approved primary-state drift into the shadow DB/process
- Charon Intelligence support so primary vs shadow performance can be compared from evidence

The owner wants to experiment with strategy settings without risking the primary/live process or manually losing track of which bot is using which config.

## Required Planner Deliverables

The planner should produce all of these, not code directly:

1. Owner executive summary readable by a non-developer.
2. Product/spec document for Shadow Charon.
3. Technical design.
4. Requirements list.
5. Task list / milestone breakdown.
6. One first Architect-ready ticket using the global `~/AGENTS.md` ticket format.
7. A verification plan that proves shadow is isolated and real-world accurate.

The output should be concrete enough that a Coder can implement the first bounded ticket without guessing.

## Safety Boundaries

Follow:

- `./AGENTS.md`
- `~/AGENTS.md`
- `~/ROLES.md`

Planning only unless the owner explicitly approves implementation.

Do not:

- trade, sign, swap, or send Telegram commands
- start, restart, or stop Charon/PM2
- read, print, copy, validate, or modify `.env`
- read or print private keys, provider keys, Telegram tokens/session contents, wallet keys, or secrets
- directly mutate production SQLite
- assume dry-run runtime execution is safe without a separate owner-approved ticket

Allowed for planning:

- source-code inspection
- secret-safe PM2/config path inspection from already-synced snapshots
- Charon Intelligence read-only snapshot/report inspection
- designing scripts, configs, and tests

## Current Relevant State

Primary Charon runtime is already parameterized enough for a same-repo multi-instance design:

- Runtime entrypoint: `index.js` -> `src/app.js`.
- DB path comes from `DB_PATH` in `src/config.js`.
- PM2 primary process currently passes:
  - `DB_PATH=/opt/trading-data/charon.sqlite`
  - `HARVESTER_DB_PATH=/opt/trading-data/harvester.db`
  - `TRADING_MODE=dry_run`
- Wallet autosync runs through `charon-auto-sync` and writes to the configured Charon DB with:
  - `CHARON_DB_PATH=/opt/trading-data/charon.sqlite`
  - `HARVESTER_DB_PATH=/opt/trading-data/harvester.db`
- Autosync currently uses GMGN as the Charon import gate and OKX as extra harvester discovery/enrichment.
- Charon's in-process strategy/config lives in SQLite `settings` and `strategies`, so a separate `DB_PATH` gives independent config.

Important caveat: `src/telegram/bot.js` currently creates a Telegram polling bot immediately from `TELEGRAM_BOT_TOKEN`. Two processes using the same Telegram bot token can collide. Shadow design must handle Telegram isolation before any parallel process is launched.

Important caveat: `src/app.js` calls `initLiveExecution()` on startup. `initLiveExecution()` loads the wallet if `SOLANA_PRIVATE_KEY` is present, even if the process is intended as dry-run. Shadow must have a hard no-live-executor guard, not only a dry-run DB setting.

## Existing Evidence / Context To Read First

In `charon`:

- `AGENTS.md`
- `ecosystem.config.cjs`
- `src/config.js`
- `src/app.js`
- `src/telegram/bot.js`
- `src/telegram/commands.js`
- `src/telegram/send.js`
- `src/db/connection.js`
- `src/db/settings.js`
- `src/db/positions.js`
- `src/pipeline/orchestrator.js`
- `src/pipeline/candidateBuilder.js`
- `src/pipeline/llm.js`
- `src/execution/positions.js`
- `src/execution/router.js`
- `src/liveExecutor.js`
- `src/enrichment/gmgn.js`
- `src/enrichment/jupiter.js`
- `src/enrichment/wallets.js`
- `src/enrichment/mcapSampler.js`
- `src/enrichment/holder-intelligence.js`
- `scripts/auto_sync_wallets.sh`
- `scripts/sync_saved_wallets.js`
- `scripts/safe_restart_charon.js`
- `scripts/dry_run_readiness.js`
- `tickets/CHARON-SCREENING-EVENTS-LIVE-TELEMETRY.md`
- `.ai/handoffs/ENTRY_EXIT_QUALITY_CONTROL_PLANNER_HANDOFF.md`

In `charon-intelligence`:

- `AGENTS.md`
- `.ai/specs/CHARON_INTELLIGENCE_PRODUCT_SPEC.md`
- `scripts/run_full_pipeline.sh`
- `scripts/analyze_filters.py`
- `reports/latest_consult_packet.md`
- `reports/latest_filter_analysis.md`
- `reports/latest_trade_analysis.md`
- `reports/latest_llm_audit.md`
- `data/vps-snapshots/latest/`

If the planner touches Birdeye or another third-party API contract, follow the workspace API docs rule: check the local API monitor docs cache first. Do not browse or implement provider calls without docs-backed field mapping.

## Architecture Direction To Consider

Prefer an **instance-profile architecture** over a forked code copy.

The same repo should be able to run:

```text
primary process: charon
shadow process:  charon-shadow
```

Both use the same source code, but different instance profiles:

```text
primary:
  DB_PATH=/opt/trading-data/charon.sqlite
  INSTANCE_ID=primary
  TRADING_MODE=current primary setting

shadow:
  DB_PATH=/opt/trading-data/charon-shadow.sqlite
  INSTANCE_ID=shadow
  TRADING_MODE=dry_run
  LIVE_EXECUTION_DISABLED=true
  TELEGRAM_POLLING_ENABLED=false by default
```

Planner should decide exact variable names, but the design needs an explicit instance identity. It should appear in logs, DB metadata, reports, and Charon Intelligence outputs.

## Critical Design Problems The Planner Must Solve

### 1. Hard Shadow Safety

Shadow must not be able to trade even if someone accidentally sets the wrong DB value.

Required safety layers:

- process-level forced dry-run/shadow mode
- no wallet key loading for shadow
- no Jupiter signing/execution path for shadow
- same-mint live-wallet checks disabled or mocked unless read-only and secret-safe
- startup should fail if shadow sees `TRADING_MODE=live` or wallet key material
- tests proving shadow cannot call live execution

Do not rely only on `settings.trading_mode = dry_run`.

### 2. Database Isolation With Controlled Drift Sync

Shadow needs its own DB:

```text
/opt/trading-data/charon-shadow.sqlite
```

But it also needs to stay realistic. Planner should design a `shadow sync` / `shadow bootstrap` process that can safely copy or reconcile selected primary state into shadow:

Recommended categories:

- copy from primary into shadow:
  - schema migrations
  - `settings` baseline, unless owner marks shadow overrides
  - `strategies` baseline, unless owner marks shadow overrides
  - `saved_wallets`
  - wallet intelligence columns
  - blacklists / learning lessons / TP-SL rules if they affect screening
- do not blindly copy as active shadow state:
  - open live positions
  - live execution signatures
  - trade intents
  - Telegram pending numeric inputs
- decide carefully:
  - historical `candidates`, `llm_decisions`, `llm_batches`, and `decision_logs`
  - these may be useful for context, but they can pollute future shadow comparison if copied without a baseline marker

The drift system should produce a clear report:

```text
primary setting changed: yes/no
shadow override exists: yes/no
wallet count drift: N
schema drift: yes/no
provider profile drift: GMGN/OKX/Jupiter/Birdeye freshness
action: copied / skipped / needs owner approval
```

### 3. Independent Config Control

Shadow config must be independently changeable without affecting primary.

Planner should choose the initial control plane:

- safest first milestone: CLI/script commands that target `--db /opt/trading-data/charon-shadow.sqlite`
- later milestone: Telegram UI with clear `SHADOW` labels and no command collision

If Telegram is included, the design must prevent:

- two pollers with the same bot token
- primary commands mutating shadow DB
- shadow commands mutating primary DB
- duplicate trade/candidate alerts being mistaken for primary alerts

Options to evaluate:

- shadow Telegram disabled initially, reports only
- separate bot token
- separate chat/topic
- command namespace such as `/shadow_strategy`
- read-only shadow Telegram plus CLI config edits

### 4. Same Data Services, Fully Enriched

Owner wants shadow to use everything Charon uses:

- GMGN token info/trending/fee data
- OKX wallet enrichment/discovery
- Birdeye data services if used or planned
- Jupiter asset/holders/chart/wallet PnL
- saved wallets from harvester
- holder intelligence
- Twitter/narrative enrichment
- signal server stream

Planner must first inventory what is actually active today versus planned. Do not assume Birdeye exists in current code just because the owner mentioned it.

The design should avoid doubling provider calls blindly. Two Charon processes polling the same providers can rate-limit or bias results.

Preferred architecture to evaluate:

- primary and shadow both consume the same signal server stream
- provider fetches go through a shared cache or snapshot ledger where possible
- shadow may make bounded extra enrichment calls only for candidates that primary did not fully enrich because primary filters differed
- every shadow candidate records whether data was:
  - live-fetched
  - reused from cache
  - copied from primary
  - missing
  - stale

### 5. Real-World Accurate Drift From Primary

Shadow is only useful if it tracks primary enough to answer: “what would have happened if config X was different?”

Planner should define drift categories:

- code drift: same git commit or exact commit delta
- schema drift: same migration level
- config drift: primary settings vs shadow settings
- wallet drift: saved wallets and enrichment freshness
- provider drift: GMGN/OKX/Jupiter/Birdeye cache freshness
- signal drift: same signal window and source IDs
- execution drift: dry-run simulator assumptions vs primary live/dry-run mechanics
- report drift: Charon Intelligence can distinguish primary vs shadow runs

The drift apply process should be explicit:

- safe automatic sync for non-strategy baseline data
- shadow override preservation for user-tuned strategy settings
- owner approval for changes that could alter the experiment definition

### 6. Signal Stream Parity

The shadow process should compare against the same real-world opportunity set.

Planner should evaluate whether current `SIGNAL_SERVER_URL` polling is sufficient or whether Charon needs a shared `signal_events` ledger/fanout:

- If both primary and shadow poll the signal server independently, they may see slightly different snapshots/timing.
- If primary logs raw signal events and shadow replays from that ledger, shadow may be more comparable but less real-time.
- If a signal fanout service exists, both can consume the same events with different configs.

The design should state which tradeoff is chosen for v1.

### 7. Reporting And Charon Intelligence

Charon Intelligence must be able to compare primary vs shadow cleanly.

Planner should require:

- instance id in DB metadata or events
- shadow DB included in snapshot sync
- reports that separate:
  - primary candidates
  - shadow candidates
  - primary entries
  - shadow dry-run entries
  - filter blockers by instance
  - LLM decisions by instance
  - PnL/exit outcomes by instance
- never mix primary live PnL with shadow dry-run PnL without labels

This should build on the `screening_events` ledger work because early skips and candidate filters need to be comparable.

## Suggested Milestone Shape

### M0: Planning And Inventory

Deliver spec, tech design, requirements, task list, and first Architect ticket.

Inventory:

- current runtime env knobs
- which providers are active
- which provider data is cached
- which DB tables must be copied/synced
- how Telegram currently controls config
- where Charon Intelligence expects snapshots

### M1: Instance Profile And Hard Shadow Safety

Add explicit runtime instance identity and hard dry-run safety.

Owner-visible result:

- a local check/report says `shadow` cannot load wallet keys or live execution
- no PM2/startup yet unless owner approves

### M2: Shadow DB Bootstrap And Drift Report

Add a safe script to create/update `charon-shadow.sqlite` from primary baseline.

Owner-visible result:

- dry-run report shows what would be copied
- commit mode creates a shadow DB only when owner approves
- report lists preserved shadow overrides

### M3: Shadow Config Control

Add a safe way to change shadow strategy config independently.

Initial preference:

- CLI/script that targets shadow DB explicitly
- Telegram control only after collision risks are solved

### M4: Data Enrichment Parity

Ensure shadow receives the same signal/enrichment surfaces as primary.

Must cover:

- GMGN
- OKX wallet profiles
- Jupiter
- Birdeye if actually available or newly designed
- saved wallets
- holder intelligence
- narrative/Twitter enrichment

Owner-visible result:

- readiness report shows provider coverage and freshness for shadow

### M5: Shadow Runtime PM2 Process

Define and deploy `charon-shadow` only after M1-M4 pass.

Owner-visible result:

- PM2 shows `charon` and `charon-shadow`
- shadow writes only to shadow DB
- shadow has no live execution path
- logs are clearly labeled

### M6: Charon Intelligence Shadow Comparison

Update Charon Intelligence to ingest/report both primary and shadow.

Owner-visible result:

- a report answers: “with shadow config, how many more candidates/entries did we get, and were they better?”

## First Architect Ticket Recommendation

The first ticket should not start a second bot. It should produce the spec and safety proof.

Suggested first ticket title:

```text
CHARON-SHADOW-M0-INSTANCE-ARCHITECTURE-AND-SAFETY-SPEC
```

Goal:

- inventory runtime/provider/DB/Telegram risks
- write the Shadow Charon spec and tech design
- define the instance-profile architecture
- define hard shadow safety requirements
- define drift-sync rules
- create the first Coder ticket for M1

Success should be owner-visible through a generated spec file and a short executive summary.

## Verification Expectations

Planner should require Verifier to check:

- shadow cannot trade by construction
- primary and shadow DB paths cannot be confused
- Telegram command collision has a clear answer before runtime launch
- provider rate limits are considered
- drift sync preserves shadow overrides
- Charon Intelligence will not mix primary and shadow results
- owner can verify state through simple commands/reports

## Open Questions For Planner To Resolve

- Should v1 shadow be real-time polling or replay-from-primary-signal-ledger?
- Should shadow start from a cloned primary DB or a clean DB seeded only with config/wallets?
- Which tables are baseline state versus experiment output?
- Should shadow Telegram be disabled initially?
- If Birdeye is not currently implemented, is it part of this milestone or a separate provider-parity milestone?
- Should shadow use the same LLM provider/model and cost tracking, or have separate budget controls?
- How should shadow dry-run slippage/fee assumptions be kept aligned with primary live fills?
- How long should the first shadow cohort run before Charon Intelligence compares it to primary?

## Exact Next Step

Planner should produce:

1. `OWNER_EXECUTIVE_SUMMARY`
2. `SPEC`
3. `TECH_DESIGN`
4. `REQUIREMENTS`
5. `TASK_LIST`
6. `FIRST_ARCHITECT_TICKET`

Do not implement the runtime yet. The first implementation ticket should be small, probably M1 instance-profile safety, and should not start PM2 or run a second bot until the owner approves.
