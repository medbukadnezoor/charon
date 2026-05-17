# WP-M7-2: LLM Usage Telemetry + Cost Tracking

**Type:** Coder
**Parent plan:** `WP-M7-LLM-PAYLOAD-BUDGET-PLANNER.md`
**Depends on:** `WP-M7-1-HOLDER-SUMMARY-BUDGET.md` (must be implemented first)
**Status:** Open
**Created:** 2026-05-13
**Priority:** High

---

## Goal

Add a compact usage ledger that logs every LLM request attempt — success, timeout,
error, and budget-skip — with tokens, latency, payload size, and optional cost
estimate. Add a Telegram `/llmusage` command so the owner can check burn rate
without SSHing into the VPS. Also register the M7 settings in the `/setfilter`
valid set so they are runtime-tunable from Telegram.

## Why this matters

The payload budget fix (M7-1) reduces per-request size, but the owner still has no
visibility into how many requests Charon makes, how many tokens it burns, or what
the estimated cost trend looks like. A candidate spike could burn through LLM
credits silently. This ticket gives the owner a compact, queryable usage ledger
and an instant Telegram report.

## Owner-visible outcome

After this ticket:

1. Every LLM call attempt writes one row to `llm_usage_events` with feature
   name, model, status, latency, request bytes, candidate count, token counts,
   and optional cost estimate.
2. Provider-reported `usage` fields (prompt/completion/total tokens) are used
   when present. When absent, tokens are estimated from payload/response size
   with a documented 4-bytes-per-token rough ratio.
3. Cost estimation is opt-in via `llm_cost_tracking_enabled` + per-million-token
   pricing settings. Default is off.
4. `/llmusage [period]` shows a Telegram report: request counts, token totals,
   cost estimate, latency stats, payload totals. Period defaults to `24h`,
   accepts `1h`, `7d`, `30m`, etc.
5. M7-1 settings (`llm_holder_sample_per_candidate`, `llm_payload_budget_kb`,
   `llm_payload_debug_log`) and M7-2 pricing settings are added to the
   `/setfilter` valid set.
6. `node --check` passes on all modified and new files.

## What to implement

### File: `src/db/usage.js` (new file)

Create this file:

```js
import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting } from './settings.js';

export function logUsageEvent({
  feature,
  model = null,
  status,
  errorClass = null,
  latencyMs = null,
  requestBytes = null,
  candidateCount = null,
  promptTokens = null,
  completionTokens = null,
  totalTokens = null,
  batchId = null,
  metadata = null,
}) {
  const inputCost = numSetting('llm_input_cost_per_1m_tokens', 0);
  const outputCost = numSetting('llm_output_cost_per_1m_tokens', 0);
  const costEnabled = boolSetting('llm_cost_tracking_enabled', false);

  let estimatedCostUsd = null;
  if (costEnabled && (inputCost > 0 || outputCost > 0)) {
    const pt = promptTokens ?? 0;
    const ct = completionTokens ?? 0;
    estimatedCostUsd = (pt * inputCost + ct * outputCost) / 1_000_000;
  }

  db.prepare(`
    INSERT INTO llm_usage_events (
      created_at_ms, feature, model, status, error_class,
      latency_ms, request_bytes, candidate_count,
      prompt_tokens, completion_tokens, total_tokens,
      estimated_cost_usd, batch_id, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(), feature, model, status, errorClass,
    latencyMs, requestBytes, candidateCount,
    promptTokens, completionTokens, totalTokens,
    estimatedCostUsd, batchId, metadata ? json(metadata) : null,
  );
}

const PERIOD_RE = /^(\d+)\s*(h|hr|hour|d|day|m|min)s?$/i;

export function parseWindowMs(period = '24h') {
  const match = period.match(PERIOD_RE);
  if (!match) return 24 * 60 * 60 * 1000;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('d')) return n * 86_400_000;
  if (unit.startsWith('h')) return n * 3_600_000;
  if (unit.startsWith('m')) return n * 60_000;
  return 24 * 3_600_000;
}

export function llmUsageSummary(windowMs = 24 * 60 * 60 * 1000) {
  const cutoff = now() - windowMs;
  const rows = db.prepare(`
    SELECT * FROM llm_usage_events WHERE created_at_ms >= ? ORDER BY id
  `).all(cutoff);

  const total = rows.length;
  const successes = rows.filter(r => r.status === 'success').length;
  const timeouts = rows.filter(r => r.status === 'timeout').length;
  const errors = rows.filter(r => r.status === 'error').length;
  const skipped = rows.filter(r => r.status === 'budget_skipped').length;

  const promptTokens = rows.reduce((s, r) => s + (r.prompt_tokens || 0), 0);
  const completionTokens = rows.reduce((s, r) => s + (r.completion_tokens || 0), 0);
  const totalTokens = rows.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.estimated_cost_usd || 0), 0);

  const latencies = rows.map(r => r.latency_ms).filter(v => v != null && v > 0);
  const avgLatency = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;
  const maxLatency = latencies.length ? Math.max(...latencies) : null;

  const totalBytes = rows.reduce((s, r) => s + (r.request_bytes || 0), 0);

  return {
    windowMs,
    total,
    successes,
    timeouts,
    errors,
    skipped,
    promptTokens,
    completionTokens,
    totalTokens,
    totalCost,
    avgLatency,
    maxLatency,
    totalBytes,
  };
}
```

### File: `src/db/connection.js`

#### 1. Add `llm_usage_events` table

Add this `db.exec` call after the existing `ensureColumn` block for `llm_batches`
(after the M7-1 `ensureColumn` calls for `payload_size_bytes` etc.):

```js
db.exec(`
  CREATE TABLE IF NOT EXISTS llm_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at_ms INTEGER NOT NULL,
    feature TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL,
    error_class TEXT,
    latency_ms INTEGER,
    request_bytes INTEGER,
    candidate_count INTEGER,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    total_tokens INTEGER,
    estimated_cost_usd REAL,
    batch_id INTEGER,
    metadata_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage_events(created_at_ms);
`);
```

#### 2. Add pricing settings defaults

Add these entries to the `defaults` object (after the M7-1 settings):

```js
llm_cost_tracking_enabled: 'false',
llm_input_cost_per_1m_tokens: '0',
llm_output_cost_per_1m_tokens: '0',
```

### File: `src/pipeline/llm.js`

#### 1. Add import

Add to the existing imports:

```js
import { logUsageEvent } from '../db/usage.js';
```

#### 2. Add timing and usage logging to `decideCandidateBatch`

This builds on the M7-1 version of `decideCandidateBatch`. Add three variables
before the `try` block:

```js
let payloadBytes = 0;
let payloadCandidateCount = rows.length;
let startMs = Date.now();
```

Inside the `try` block, after the budget enforcement and skip check from M7-1,
update the tracking variables:

```js
payloadBytes = bytes;
payloadCandidateCount = payload.candidates.length;
startMs = Date.now();
```

In the budget-skip return path (inside `if (skip)`), add a usage log before
returning:

```js
logUsageEvent({
  feature: 'candidate_batch',
  model: LLM_MODEL,
  status: 'budget_skipped',
  requestBytes: bytes,
  candidateCount: rows.length,
});
```

After the successful API call and response parsing (after `const content = ...`),
extract provider usage and log:

```js
const usage = res.data?.usage || {};
const promptTokens = usage.prompt_tokens ?? Math.ceil(bytes / 4);
const completionTokens = usage.completion_tokens ?? Math.ceil(content.length / 4);
const totalTokens = usage.total_tokens ?? (promptTokens + completionTokens);

logUsageEvent({
  feature: 'candidate_batch',
  model: LLM_MODEL,
  status: 'success',
  latencyMs: Date.now() - startMs,
  requestBytes: payloadBytes,
  candidateCount: payloadCandidateCount,
  promptTokens,
  completionTokens,
  totalTokens,
  metadata: enforced ? { budgetEnforced: true } : null,
});
```

Token estimation fallback: when the provider response does not include `usage`,
tokens are estimated at ~4 bytes per token. This is a documented rough ratio for
JSON + English text. Provider-reported values are always preferred.

In the `catch` block, add usage logging before the existing return:

```js
const isTimeout = err.code === 'ECONNABORTED' || err.message.includes('timeout');
logUsageEvent({
  feature: 'candidate_batch',
  model: LLM_MODEL,
  status: isTimeout ? 'timeout' : 'error',
  errorClass: (err.code || err.message).slice(0, 100),
  latencyMs: Date.now() - startMs,
  requestBytes: payloadBytes,
  candidateCount: payloadCandidateCount,
});
```

### File: `src/telegram/commands.js`

#### 1. Add `/llmusage` handler

Add this block in `handleMessage`, after the `/lessons` handler and before
`/candidate`:

```js
if (text.startsWith('/llmusage')) {
  const period = text.split(/\s+/)[1] || '24h';
  const { llmUsageSummary, parseWindowMs } = await import('../db/usage.js');
  const windowMs = parseWindowMs(period);
  const s = llmUsageSummary(windowMs);
  const lines = [
    `<b>LLM Usage — last ${escapeHtml(period)}</b>`,
    '',
    `Requests: ${s.total} (${s.successes} ok, ${s.timeouts} timeout, ${s.errors} err, ${s.skipped} skip)`,
    `Tokens: ${s.promptTokens.toLocaleString()} in + ${s.completionTokens.toLocaleString()} out = ${s.totalTokens.toLocaleString()}`,
    s.totalCost > 0 ? `Est. cost: $${s.totalCost.toFixed(4)}` : 'Cost tracking: off',
    `Latency: avg ${s.avgLatency ?? '—'}ms / max ${s.maxLatency ?? '—'}ms`,
    `Payload: ${(s.totalBytes / 1024).toFixed(1)} KB total`,
  ];
  return bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}
```

Uses dynamic `import()` like the existing `/pnl` handler to avoid loading the
usage module at startup for non-usage paths.

#### 2. Register the command

Add to the `bot.setMyCommands` array in `setupTelegram`:

```js
{ command: 'llmusage', description: 'Show LLM token usage and cost' },
```

#### 3. Add M7 settings to `/setfilter` valid set

Add these entries to the `valid` Set inside the `/setfilter` handler:

```
'llm_holder_sample_per_candidate',
'llm_payload_budget_kb',
'llm_payload_debug_log',
'llm_cost_tracking_enabled',
'llm_input_cost_per_1m_tokens',
'llm_output_cost_per_1m_tokens',
```

## What NOT to do

- Do not modify `src/pipeline/orchestrator.js`
- Do not modify `src/enrichment/wallets.js`
- Do not modify filters, strategies, or position logic
- Do not store API keys, `.env` values, authorization headers, or full prompt
  bodies in `llm_usage_events`
- Do not read `.env`, secrets, Telegram tokens, wallet/private keys
- Do not run live trading, confirm trading, wallet signing, swaps, or Telegram
  command flows
- Do not start services, PM2, bot processes, or runtime checks
- Do not install dependencies
- Do not implement a tokenizer — the 4-bytes-per-token estimate is sufficient
  as a fallback

## Verification

1. `node --check src/db/usage.js` passes
2. `node --check src/pipeline/llm.js` passes
3. `node --check src/db/connection.js` passes
4. `node --check src/telegram/commands.js` passes
5. `llm_usage_events` table is created in `initDb` with all 14 columns
6. `logUsageEvent` is called in `decideCandidateBatch` on success, timeout/error,
   and budget-skip paths
7. Provider `usage` fields are used when present; fallback estimate uses
   `Math.ceil(bytes / 4)` for prompt tokens and `Math.ceil(content.length / 4)`
   for completion tokens
8. Cost estimation only runs when `llm_cost_tracking_enabled` is `true` and at
   least one pricing setting is non-zero
9. `/llmusage` handler exists in `handleMessage` and renders an HTML summary
10. `llmusage` is registered in `bot.setMyCommands`
11. `/setfilter` valid set includes all 6 new M7 settings
12. Settings defaults include `llm_cost_tracking_enabled`,
    `llm_input_cost_per_1m_tokens`, `llm_output_cost_per_1m_tokens`

## Rollback plan

- The `llm_usage_events` table is additive — deleting it has no effect on core
  pipeline behavior
- All `logUsageEvent` calls are fire-and-forget within the existing try/catch;
  if `usage.js` throws, the surrounding catch handles it
- `/llmusage` is a read-only query command with no side effects
- Cost tracking defaults to off; no owner config needed to deploy safely

## Files to create

| File | Purpose |
|------|---------|
| `src/db/usage.js` | `logUsageEvent`, `llmUsageSummary`, `parseWindowMs` |

## Files to modify

| File | Change |
|------|--------|
| `src/db/connection.js` | Add `llm_usage_events` table, add 3 pricing settings defaults |
| `src/pipeline/llm.js` | Import `logUsageEvent`, add timing + usage logging to all `decideCandidateBatch` paths |
| `src/telegram/commands.js` | Add `/llmusage` handler, register command, add M7 settings to `/setfilter` valid set |

## Files to read (context)

| File | Why |
|------|-----|
| `src/pipeline/llm.js` | M7-1 version of `decideCandidateBatch` with budget enforcement (implementation target) |
| `src/db/connection.js` | Table creation and settings defaults pattern |
| `src/telegram/commands.js` | Command handler and `/setfilter` valid set pattern |
| `src/db/decisions.js` | Existing batch storage pattern (reference, not modified) |
