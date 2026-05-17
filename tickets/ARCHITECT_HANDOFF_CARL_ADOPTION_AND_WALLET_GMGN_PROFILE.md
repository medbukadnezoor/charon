# Architect Handoff - Carl Adoption And Wallet GMGN Profile Link

Created: 2026-05-17
Audience: Architect agent orchestrating Charon development
Primary repo: `.`
Donor comparison repo: `../charon-carl-rothschild`

## Objective

Plan and orchestrate adoption of the useful Carl fork features into main Charon without regressing the newer Charon implementation. Include the owner-requested operator feature: show the current live wallet public address, make it copyable, and provide a GMGN wallet profile link that opens in the default browser from Telegram.

This handoff is for Architect planning. Architect stays read-only and should create one bounded, owner-verifiable Coder ticket at a time under the global `Architect -> Coder -> Verifier` workflow.

## Read First

In main Charon:
- `AGENTS.md`
- `src/liveExecutor.js`
- `src/format.js`
- `src/telegram/commands.js`
- `src/telegram/menus.js`
- `src/telegram/callbacks.js`
- `src/telegram/bot.js`
- `src/pipeline/llm.js`
- `src/pipeline/orchestrator.js`
- `src/execution/router.js`
- `src/execution/positions.js`
- `src/db/settings.js`
- `src/db/connection.js`
- relevant tests under `tests/`

In Carl donor repo:
- `src/observability/logger.js`
- `src/security/telegram.js`
- `src/pipeline/llmValidator.js`
- `src/risk/guards.js`
- `src/risk/engine.js`
- `src/risk/sizing.js`
- `src/risk/blacklist.js`
- `src/telegram/commands.js`
- `src/app.js`

GMGN docs/cache:
- `<api-monitor>/index.md`
- `<api-monitor>/current/gmgn.md`
- `<api-monitor>/current/gmgn/fulldocs.md`

## Safety Boundaries

Do not run live trading, confirm trading, wallet signing, swap execution, Telegram command flows, PM2, bot startup, or runtime services without a separate owner-approved ticket.

Do not read, print, copy, validate, or modify `.env`, private keys, API keys, Telegram tokens, provider keys, wallet secret keys, SQLite runtime state, runtime logs, or other secrets.

Do not install dependencies. Do not assume dry-run mode is safe to run.

Allowed for this adoption planning:
- source-code inspection.
- local code edits by the Coder phase only.
- syntax checks and focused tests that do not require secrets, external services, live Telegram sends, or bot startup.
- public wallet address display logic, because the address is public and should come from an existing public-key helper, not from secret material.

## Confirmed Current State

The Carl zip was extracted and moved to:
- `../charon-carl-rothschild`

Supply-chain scan summary from the zip inspection:
- `npm ci --ignore-scripts --omit=dev` completed in the temp extraction.
- `npm audit signatures` passed with verified registry signatures and attestations.
- No obvious malicious axios typosquat indicators were found in the dependency tree.
- Install-script packages observed were expected native/ws packages: `better-sqlite3`, `bufferutil`, and `utf-8-validate`.
- `npm audit` still reported known vulnerabilities through the old `node-telegram-bot-api` request stack. Treat dependency modernization as separate from Carl feature adoption.

Main Charon is ahead of Carl in important runtime logic:
- richer screening/event telemetry.
- wallet cache and compact wallet evidence.
- holder intelligence, market-cap sampler, trending risk, and entry approval.
- LLM intelligence/usage direction.
- same-mint guard and live sell reconciliation.
- breakeven, early-token stop-loss, and position-exit improvements.
- exact blacklist/deployer observations.

Carl should be treated as a donor for selected safety and operator ergonomics only. Do not replace main Charon modules wholesale.

## Adopt From Carl

Priority 0:
- central Telegram authorization guard so all commands and callbacks reject unauthorized chat/user access consistently.
- safe logging/redaction helper for future operator logs and error surfaces.
- strict LLM response validation so malformed or ambiguous model output cannot silently pass as a valid trade decision.
- the current-wallet GMGN profile feature requested by the owner.

Priority 1:
- graceful shutdown and tracked interval cleanup from Carl's app lifecycle, adapted to main Charon's current startup path.
- additive risk-event ledger for operator-visible blocked/rejected actions, if it does not duplicate existing decision/filter telemetry.
- emergency operator controls only after Architect confirms they match main Charon's existing settings and trading-mode boundaries.

Priority 2:
- generic risk guard abstractions only where they remove duplication. Main Charon already has more advanced entry, exit, blacklist, and wallet logic, so keep this additive and narrow.

## Do Not Adopt Wholesale

Do not replace these main Charon files with Carl versions:
- `src/pipeline/candidateBuilder.js`
- `src/pipeline/llm.js`
- `src/execution/router.js`
- `src/execution/positions.js`
- `src/db/blacklist.js`
- `src/enrichment/wallets.js`

Those Carl versions are simpler and would likely remove newer behavior already implemented in main Charon.

## Owner-Requested Wallet Feature

Goal:
- Owner can see the current live wallet public address from the Telegram operator UI.
- The address is copyable in Telegram.
- The UI includes a GMGN wallet profile link so the owner can open the wallet profile and view PnL in the default browser.

Implementation guidance:
- Use `liveWalletPubkey()` from `src/liveExecutor.js`; do not read `.env` or parse wallet secrets in Telegram code.
- Add a wallet-profile URL helper next to the existing token helper in `src/format.js`.
  - Existing helper: `gmgnLink(mint)` -> `https://gmgn.ai/sol/token/<mint>`
  - New helper should be something like `gmgnWalletLink(address)` -> `https://gmgn.ai/sol/address/<address>`
- Confirm the GMGN address URL pattern through the local GMGN docs cache or a non-secret browser check before shipping if the Architect is not comfortable with the inferred pattern.
- Render the address as Telegram HTML code text, for example `<code>PUBLIC_ADDRESS</code>`, so mobile/desktop Telegram can copy it easily.
- Add an inline URL button where appropriate, for example `{ text: 'GMGN Wallet PnL', url: gmgnWalletLink(address) }`.
- If no live wallet is loaded, show a plain state such as `Live wallet: not loaded`. Do not hint at missing key names, environment values, or secret configuration.
- Prefer adding the wallet line to `agentText()` or a dedicated wallet/status surface. Avoid burying it only inside the saved-wallet list because this is the live execution wallet, not one of the tracked `saved_wallets`.

Likely files in scope:
- `src/format.js`
- `src/telegram/menus.js`
- `src/telegram/commands.js`
- `src/liveExecutor.js` only if a small export or doc comment is truly needed
- focused tests under `tests/`

Acceptance criteria:
- A rendered operator status/wallet view includes the current public address when `liveWalletPubkey()` returns a value.
- The public address is wrapped in `<code>...</code>` and HTML-escaped.
- The GMGN button/link uses `https://gmgn.ai/sol/address/<wallet_address>`.
- No private key, env var value, provider key, or Telegram token can appear in the rendered output.
- The no-wallet state is explicit and safe.
- No live Telegram send, bot startup, PM2 action, swap, signing, or runtime DB/log access is required to verify the implementation.

## Suggested Ticket Sequence

### Ticket A - Telegram Auth And Live Wallet GMGN Link

Why first:
- The owner explicitly requested the wallet visibility/link feature.
- Telegram auth should be solved before adding more operator commands or buttons.

Scope:
- Adapt Carl's central Telegram auth idea into main Charon's command and callback entry points.
- Add the live-wallet display/link feature to an existing safe operator status surface.
- Keep changes narrowly in Telegram UI/helpers and public-key display.

Owner-visible outcome:
- Authorized operator can open the Charon status/agent surface and see the current live wallet public address as copyable text plus a GMGN wallet PnL link.
- Unauthorized chats/users cannot use the command/callback surface.

Required checks:
- `node --check src/format.js`
- `node --check src/telegram/menus.js`
- `node --check src/telegram/commands.js`
- `node --check src/telegram/callbacks.js`
- focused test or static render helper proving the wallet address and GMGN URL are rendered correctly.
- static grep/check proving rendered strings do not include `SOLANA_PRIVATE_KEY`, private-key wording, or raw secret values.

Escalate if:
- the current Telegram bot library makes auth enforcement ambiguous across callbacks.
- wallet display requires reading secret config instead of using `liveWalletPubkey()`.
- the GMGN wallet profile URL pattern cannot be verified safely.

### Ticket B - Safe Logger And Graceful Shutdown

Scope:
- Add a small logger/redaction helper adapted from Carl.
- Replace only high-risk raw `console.log` paths that could expose sensitive error payloads.
- Add tracked interval/shutdown cleanup only if it matches main Charon's current `src/app.js` lifecycle.

Owner-visible outcome:
- Operator logs are less likely to leak sensitive values.
- The bot can stop more cleanly without orphaned polling intervals.

Required checks:
- syntax checks on touched files.
- unit tests for redaction helper.
- no bot startup or PM2 execution.

### Ticket C - LLM Response Validator

Scope:
- Adapt Carl's `llmValidator.js` into main Charon's current `src/pipeline/llm.js` flow.
- Validate schema, selected candidate references, confidence bounds, and fallback behavior.
- Preserve main Charon's newer batch, budget, decision-log, and intelligence fields.

Owner-visible outcome:
- Bad LLM output is rejected or downgraded with a clear reason instead of silently becoming a trade decision.

Required checks:
- syntax checks.
- focused unit tests for valid output, malformed JSON, invalid candidate ID, out-of-range confidence, and empty selection.

### Ticket D - Additive Risk Event Ledger

Scope:
- Inspect whether Carl's risk engine/guards add anything not already covered by main Charon's strategy settings, blacklist, entry approval, and telemetry.
- If useful, add a narrow `risk_events` table/helper for operator audit only.
- Do not replace main risk/entry/exit logic.

Owner-visible outcome:
- Owner can inspect why an action was blocked/rejected without reading code.

Required checks:
- migration is idempotent.
- insert/query helper tests pass.
- no live trading path is exercised.

## Dirty Worktree Warning

The main Charon worktree has many existing modified and untracked files from prior owner/agent work. Coder must run `git status --short` before editing and must not revert unrelated changes.

If a planned edit touches a file already modified by someone else, inspect the current file carefully and adapt to the existing changes instead of overwriting them.

## Owner-Checkable Evidence

After Ticket A:
- A test/static render output shows the current wallet public address as copyable `<code>...</code>` text.
- A test/static render output shows the GMGN wallet link exactly as `https://gmgn.ai/sol/address/<wallet_address>`.
- A no-wallet case shows `Live wallet: not loaded`.
- Auth tests or static checks show unauthorized command/callback paths are rejected.

After all adoption tickets:
- Main Charon keeps its existing advanced candidate, execution, position, wallet, and blacklist behavior.
- Adopted Carl features are visible as additive safety/operator improvements, not fork replacement.
- Verifier can approve with high trust from code diff, tests, and owner-visible render/check artifacts.

## Initial Architect Ticket Shape

Architect should start with exactly one bounded ticket in the global format. Recommended first ticket:

TICKET_ID: CARL-ADOPT-T1-TELEGRAM-AUTH-WALLET-GMGN-LINK
END_GOAL_LINK: Safer Charon operator control plane with useful Carl safety features adopted without regressing main Charon.
GOAL: Add centralized Telegram authorization and an operator-visible live-wallet public address with copyable text plus GMGN wallet profile link.
WHY_NOW: The owner specifically requested the wallet address/GMGN PnL link, and new operator UI should land behind consistent authorization.
OWNER_VISIBLE_OUTCOME: The Charon Telegram status/agent view shows the live wallet public address as copyable text and provides a GMGN wallet PnL link; unauthorized Telegram access is rejected.
OWNER_PROOF: Static render/test output showing wallet-present, wallet-missing, authorized, and unauthorized cases.
OWNER_CHECK_STEPS: Inspect the test/render artifact, then after a later owner-approved deployment open the Charon operator UI and tap the GMGN wallet link.
FILES_IN_SCOPE: `src/format.js`, `src/telegram/menus.js`, `src/telegram/commands.js`, `src/telegram/callbacks.js`, focused tests under `tests/`; `src/liveExecutor.js` only if a tiny public-key export adjustment is required.
ACCEPTANCE_CRITERIA: Public wallet address is rendered as escaped `<code>...</code>`; GMGN wallet link uses `https://gmgn.ai/sol/address/<address>`; no-wallet state is safe; unauthorized command/callback access is rejected; no secrets are read or rendered.
REQUIRED_CHECKS: targeted `node --check` commands; focused unit/static render tests; no dependency install; no bot startup; no Telegram send; no live/runtime checks.
RISKS: Telegram callback auth can be missed if only message handlers are guarded; GMGN address URL pattern should be verified safely; dirty worktree may contain overlapping edits.
ESCALATE_IF: implementation requires reading secrets, starting the bot, sending Telegram commands, changing trading behavior, or broad replacement of main Charon modules.
