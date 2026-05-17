# Smart Wallet Logic Planning Handoff

Created: 2026-05-13
Repo: `.`

## Objective

Ask a planning agent to design the next Charon smart-wallet process so Charon can benefit from the full MoonBags wallet-harvester universe without hammering Jupiter PnL or shrinking the runtime list so much that early candidates rarely overlap.

The current owner goal is not another tiny curated import. The goal is a scalable wallet intelligence layer:

- Load or reference as many harvester wallets as possible, currently roughly 800+ and growing.
- Keep expensive enrichment out of the Charon hot path.
- Use MoonBags harvester GMGN/OKX tags and profile data as the primary freshness source.
- Use Jupiter PnL sparingly in the background, only where it adds value.
- When a candidate is filtered, accepted, or escalated because of wallet overlap, log exactly which wallet(s) caused it and why in compact form.
- Later add a compaction/summarization process for long wallet-evidence logs.

## Current State

Read these first:

- `AGENTS.md` for Charon-specific safety boundaries.
- `WALLET_PIPELINE_PLAN.md` for landed wallet-pipeline work and open milestones.
- `src/enrichment/wallets.js` for current saved-wallet exposure and KOL dump-risk logic.
- `src/pipeline/candidateBuilder.js` for where candidate wallet exposure is computed.
- `src/pipeline/llm.js` and `src/db/decisions.js` for what gets passed to candidate selection and logged.
- `scripts/export_wallet_priority.js`, `scripts/import_priority_wallets.js`, `scripts/refresh_wallet_pnl.js`, and `scripts/export_saved_wallets_seed.js` for existing tooling.

Important current behavior:

- Charon currently uses `saved_wallets` as the runtime smart-wallet set.
- Earlier broad import considered roughly 800 wallets and caused too many Jupiter PnL calls / rate-limit pressure.
- A scoring/import path reduced the active set to about 60-70 priority wallets.
- Owner observed that this is now too narrow: very early Pump-token candidates often have few tracked wallets, so almost no candidates hit the saved-wallet filter.
- MoonBags wallet harvester already enriches wallet data with GMGN and OKX profile/tag data, so Charon should not rely on Jupiter PnL as the first-class wallet-quality source.
- Current `fetchSavedWalletExposure(mint, holders)` loads Charon `saved_wallets`, enriches those rows from harvester metadata, then intersects them with candidate holder addresses.
- Current `fetchKolDumpRisk()` calls Jupiter PnL only for matched KOL-like saved wallets, which is bounded by candidate overlap and usually small.

## Safety Boundaries

The planning agent must stay planning/read-only unless the owner explicitly opens an implementation ticket.

Do not:

- Run Charon, PM2, Telegram flows, trading, dry-run, confirm mode, live mode, wallet signing, or swaps.
- Read, print, validate, copy, modify, or infer `.env`.
- Read or print wallet/private keys, Telegram tokens, provider keys, API keys, credentials, SQLite runtime state, runtime logs, or other secrets.
- Install dependencies.
- Start services or runtime checks.
- Treat dry-run as safe without a separate owner-approved ticket.

Allowed planning inputs under current repo contract:

- `AGENTS.md`, `WALLET_PIPELINE_PLAN.md`, README/package metadata, `.env.example`.
- Code inspection.
- Local-only harvester status/report reads if needed.
- Public Jupiter PnL enrichment only as a proposed bounded background process, not a live run.
- Charon `saved_wallets` read/write only in a future owner-approved import ticket.

## Problem To Solve

The previous architecture has a false tradeoff:

- Load all wallets: better recall, but risks Jupiter API pressure if every wallet needs fresh PnL.
- Load only 60-70 wallets: safe and compact, but too low recall for early tokens with very little tracked smart-wallet overlap.

The better architecture should separate "wallet membership for overlap detection" from "expensive wallet-quality enrichment."

Candidate-time logic should be able to ask:

1. Which known harvester wallets are currently in this token?
2. What tags/profile facts do we already know about those wallets from GMGN/OKX/owner labels?
3. Is the evidence strong enough to accept, reject, escalate to LLM, or simply log?
4. Do we need any bounded on-demand Jupiter PnL for this candidate, and only for a tiny subset such as matched KOL/profitable/renowned wallets?

## Desired Planning Output

Produce an architect-ready plan with bounded tickets. Prefer a milestone ladder with decision gates, not a single large implementation.

The plan should cover:

1. Data model
   - Whether Charon should keep stuffing all wallets into `saved_wallets`, or introduce a separate wallet intelligence/index table sourced from the harvester.
   - How to preserve labels/tags/profile snapshots compactly.
   - How to store freshness metadata per provider: harvester sighting, GMGN profile, OKX profile, Jupiter PnL.

2. Hot-path candidate logic
   - Fast intersection between candidate holders and the large wallet universe.
   - No per-wallet Jupiter scan in the candidate path.
   - Bounded optional on-demand checks only for matched high-impact wallets.
   - Candidate decisions should carry structured wallet evidence.

3. Background freshness process
   - Prioritize Jupiter PnL refresh for wallets that matter recently, not all wallets equally.
   - Suggested queues: recently seen in harvester, recently overlapped a candidate, owner-labeled, KOL-like, high GMGN/OKX confidence, stale-but-important.
   - Rate limits and backoff should be explicit.
   - Charon should tolerate stale/missing Jupiter PnL by falling back to GMGN/OKX tags and freshness flags.

4. Logging and compact evidence
   - When wallet overlap influences a filter/pass/LLM decision, log compact evidence such as:
     - token symbol/mint
     - decision/filter result
     - wallet short id/address
     - label/tags
     - provider profile summary: KOL/smart/profitable, win rate, PnL, source freshness
     - whether Jupiter PnL was stale, missing, skipped, or fresh
   - Avoid verbose raw provider blobs in decision logs.
   - Propose a later compaction job that rolls up repeated wallet evidence into compact daily summaries.

5. Import/sync process
   - How MoonBags harvester output should sync into Charon.
   - Whether to sync all wallet addresses into a new table and only a curated subset into `saved_wallets`, or replace `saved_wallets` semantics entirely.
   - Dry-run-first import/sync CLI requirements and owner-review artifacts.

6. Verification strategy
   - Start with static and fixture/shadow checks only.
   - Use provider stubs where possible.
   - Define owner-checkable artifacts before any runtime deployment.
   - Do not propose live Charon execution as a first verification step.

## Design Direction To Consider

A likely direction is a two-tier model:

- `wallet_universe` or `wallet_intelligence`: broad, large, synced from MoonBags harvester, used for candidate holder overlap and evidence. This can contain 800+ wallets and grow.
- `saved_wallets`: owner-approved high-conviction subset used for legacy menus or stricter strategy gates, not the only overlap source.

At candidate time:

- Intersect candidate holder addresses with `wallet_universe`.
- Score matched wallets using cached GMGN/OKX/owner/harvester facts.
- Only call Jupiter PnL for a small bounded set of matched wallets when the decision needs token-specific dump-risk context.
- Record `walletEvidence` on the candidate and in decision logs.

In the background:

- Maintain a priority refresh queue for Jupiter PnL with low rate and backoff.
- Refresh wallets based on recency and importance, not full-universe sweeps.
- Keep source freshness flags so stale Jupiter data never falsely dominates GMGN/OKX profile data.

## Open Questions For The Planning Agent

- What is the cleanest table design that avoids bloating `saved_wallets` while preserving current Charon behavior?
- Should candidate filtering require a minimum count, a weighted wallet-quality score, or separate lanes such as "KOL-risk", "smart-money-positive", and "owner-watch"?
- What fields from MoonBags harvester should Charon copy versus read directly from the harvester DB?
- How should evidence be represented so LLM payloads and decision logs stay compact?
- How should stale Jupiter PnL be shown to the LLM so it is useful but not misleading?
- What is the smallest safe implementation slice after planning?

## Suggested First Ticket

Architect ticket only:

`WP-M5-SMART-WALLET-ARCH-1: Broad Wallet Universe And Compact Evidence Plan`

Scope:

- Read `AGENTS.md`, `WALLET_PIPELINE_PLAN.md`, and the wallet/candidate/decision code listed above.
- Produce a repo-specific design plan and milestone ladder.
- Include exact proposed tables/columns, sync flow, hot-path candidate flow, background refresh queue, log schema, and verification gates.
- Do not edit code, run runtime flows, call providers, inspect secrets, or mutate DBs.

Expected output:

- A concise Markdown plan suitable for owner approval before implementation.
- Explicit first Coder ticket after approval.
