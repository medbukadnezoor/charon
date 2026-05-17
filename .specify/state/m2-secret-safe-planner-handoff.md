# M2 Secret-Safe Planner Handoff

Updated: 2026-05-12 16:05 +0700
Audience: planner / architect agent
Repo: `.`

## Objective

Decide the best secret-safe way to implement and run M2 of `WALLET_PIPELINE_PLAN.md`: the LLM wallet reviewer.

The owner wants the reviewer to use MiniMax M2.7 through an OpenAI-compatible API, but the project contract still forbids reading, printing, copying, validating, or modifying `.env` and any API keys. The planner's job is to choose the safest credential-handling design before any M2 code is written or run.

## Current Confirmed State

- `WALLET_PIPELINE_PLAN.md` is the active plan.
- M1/M3 local tooling is already implemented:
  - `scripts/refresh_wallet_pnl.js`
  - `scripts/export_wallet_priority.js`
  - `scripts/import_priority_wallets.js`
- Owner confirmed the priority CSV scoring matched wallets they want to follow.
- A/B priority wallets were imported into Charon `saved_wallets`: 70 inserted.
- Latest priority export used for import:
  - `reports/smart-wallet-priority-2026-05-12T08-14-35-939Z.json`
  - `reports/smart-wallet-priority-2026-05-12T08-14-35-939Z.csv`
- Workflow Manager health passed after continuity updates and `workflow sync`.

## Hard Safety Boundaries

Do not:
- Read, print, copy, validate, or modify `.env`.
- Print or summarize API key values, Telegram tokens, wallet/private keys, provider keys, credentials, runtime logs, or broad SQLite runtime state.
- Start Charon, PM2, Telegram polling, bot runtime, live trading, confirm trading, wallet signing, swaps, or dry-run bot execution.
- Install dependencies unless a later owner-approved ticket explicitly permits it.

Allowed current wallet-pipeline lanes:
- Local wallet-harvester status/report reads.
- Public Jupiter PnL enrichment for public wallet addresses when paced and bounded.
- Charon `saved_wallets` reads/writes for owner-approved priority-wallet import.

## M2 Requirement From Plan

M2 wants a standalone LLM wallet reviewer:
- Read from harvester DB and Charon `saved_wallets`.
- Batch 10-15 wallets per LLM call.
- Use MiniMax M2.7 through an OpenAI-compatible endpoint.
- Store review results in Charon DB table `wallet_llm_reviews`.
- Later run a 15-minute review loop and feed fresh LLM judgment into priority exports.

The unresolved issue: how should `LLM_BASE_URL`, `LLM_MODEL`, and especially `LLM_API_KEY` be provided without violating the no-`.env` and no-secret-inspection rules?

## Planning Question

Pick the best secret-safe design for M2 and return one bounded implementation ticket.

The decision should answer:
- Should M2 reuse Charon's `.env`, require the operator to inject environment variables at command runtime, use a separate wallet-pipeline env file, or use another secret provider?
- How can scripts detect "credential not provided" without printing or validating the raw secret?
- What exact command pattern should the owner/operator use?
- What should be written to Charon DB and reports, and what must never be logged?
- Which parts can be implemented before a real key is available?
- What should Verifier check without exposing secrets?

## Candidate Options To Evaluate

1. **Runtime environment injection, preferred starting point**
   - Script reads only `process.env.LLM_API_KEY`, `process.env.LLM_BASE_URL`, and `process.env.LLM_MODEL`.
   - It does not call `dotenv.config()` and does not open any env file.
   - Owner/operator runs it with already-exported env vars or a shell wrapper outside the repo.
   - Script fails closed if `LLM_API_KEY` is absent, printing only `LLM_API_KEY is not set`.

2. **Dedicated wallet-pipeline env file**
   - A separate ignored file such as `.wallet-pipeline.env`.
   - Risk: still requires code to read a secret file, which may conflict with current project rules unless AGENTS.md explicitly permits that file.

3. **Reuse Charon `.env`**
   - Convenient because plan currently says M2 uses Charon LLM config.
   - Risk: current `AGENTS.md` explicitly forbids reading, validating, or modifying `.env`.
   - Likely unsafe unless owner changes the contract.

4. **Two-stage implementation**
   - Implement prompt, schema, DB table, batching, and `--dry-run-json` without any live LLM call.
   - Add a separate `--commit-review` or `--live-llm` mode later once the secret lane is approved.

## Recommended Planner Output

Return:
- One recommended credential path.
- The smallest M2a implementation ticket.
- Owner approval text needed before any live LLM call.
- Verifier checklist.
- Explicit forbidden actions.

Do not implement M2 in this planner pass.

## Suggested Default Recommendation

Use runtime environment injection plus two-stage implementation:
- Build `scripts/llm_wallet_reviewer.js` so it can run in `--dry-run-json` without a key.
- For live LLM mode, require `LLM_API_KEY` to be present in process environment.
- Do not load `.env` or any secret file.
- Do not log request headers or raw environment.
- Log only model name, batch id, wallet counts, verdict counts, and redacted errors.
- Store only LLM verdict/confidence/reasoning/model/batch/raw JSON response; never store API keys or headers.

This appears to fit the current project contract best, but planner should verify whether there is a better local convention before issuing the ticket.

## Coder M2a Implementation Note

Implemented the bounded M2a script as `scripts/llm_wallet_reviewer.js`.

- Dry-run path: `node scripts/llm_wallet_reviewer.js --dry-run-json --limit=3 --batch-size=3` builds candidate context and prints valid JSON request bodies without requiring a key or making an HTTP request.
- Live path: requires runtime-injected `LLM_API_KEY`; if absent, exits with `LLM_API_KEY is not set — run with --dry-run-json or export the key`.
- The script does not load `.env` or any env file and does not print request headers, raw environment, or key values.
- Charon DB mutation scope is limited to creating/inserting `wallet_llm_reviews`; harvester DB is opened read-only.
- No live LLM call was run in this implementation pass.
