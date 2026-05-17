# WP-M7-1: Holder Risk Summary + LLM Payload Budget

**Type:** Coder
**Parent plan:** `WP-M7-LLM-PAYLOAD-BUDGET-PLANNER.md`
**Status:** Open
**Created:** 2026-05-13
**Priority:** High

---

## Goal

Replace the raw top-holder array (up to 100 rows per candidate) with a compact
holder-risk summary plus a small sample. Add a payload budget enforcement layer
that progressively trims the LLM request if it exceeds a configurable size limit.
Add audit columns to `llm_batches` so payload size is tracked over time.

## Architecture Context

The VPS showed batches at 94–109 KB, mostly from `holders.top_holders` sending up
to 100 compact arrays per candidate. With 7–8 candidates, that's 654–777 holder
rows — roughly 84 KB of the total payload.

**Chosen approach: Option B (Holder Signal Summary) + Option A (configurable
safety caps).**

This is the same pattern that already works for wallet evidence (M5-2/M5-3):
compute a local summary with key risk metrics, then send the summary plus a tiny
sample to the LLM. The LLM doesn't need to parse 100 individual holder rows to
assess concentration risk — it needs `concentrationRisk: "medium"`,
`top20Percent: 52`, and `smartWalletOverlap: 4`.

**Estimated payload after this change:**
- Holders: ~560 bytes per candidate (was ~12 KB)
- 8 candidates: ~4.5 KB for holders (was ~96 KB)
- Total payload: ~15–20 KB (was ~94–109 KB)
- Well under the 40 KB default budget

**Why not Option C (two-stage triage):** candidate count is 7–10, which is fine.
The problem is per-candidate data density, not candidate count. Two-stage can be a
future milestone if candidate counts grow.

**Why not Option D (evidence ledger):** the `decision_logs` and `llm_batches`
tables already provide reasonable audit. Adding payload size tracking is enough.

## Owner-visible outcome

After this ticket:

1. The LLM receives a holder-risk summary per candidate instead of 100 raw holder
   rows. The summary includes `concentrationRisk`, `top10Percent`,
   `top20Percent`, `maxHolderPercent`, `largeHolderCount`, `smartWalletOverlap`,
   plus a configurable small sample (default 3 rows).
2. A payload budget enforcer measures the serialized payload before sending and
   progressively trims if over budget: first drops `chart.windows`, then reduces
   holder samples to 1, then drops trailing candidates. If still over budget with
   1 candidate, Charon skips the LLM with a logged reason instead of timing out.
3. New runtime settings control holder sample size (`llm_holder_sample_per_candidate`,
   default 3) and payload budget (`llm_payload_budget_kb`, default 40).
4. `llm_batches` gains `payload_size_bytes`, `holder_rows_sent`, and
   `budget_enforced` columns for monitoring.
5. Smart-wallet evidence is unchanged — `savedWalletExposure` keeps the same
   shape from M5-3.
6. `node --check` passes on all modified files.

## What to implement

### File: `src/pipeline/llm.js`

#### 1. Update imports

Add `boolSetting` to the existing settings import:

```js
import { numSetting, boolSetting } from '../db/settings.js';
```

#### 2. Add `concentrationRiskLevel` helper

Add after `compactHolder`:

```js
function concentrationRiskLevel(maxPct, top20Pct) {
  if (maxPct > 25 || top20Pct > 80) return 'critical';
  if (maxPct > 15 || top20Pct > 60) return 'high';
  if (maxPct > 5 || top20Pct > 40) return 'medium';
  return 'low';
}
```

#### 3. Replace `compactHoldersForLlm` with `holderRiskSummary`

Delete the existing `compactHoldersForLlm` function (lines 48–57) and replace
with:

```js
function holderRiskSummary(holders = {}, opts = {}) {
  const sampleSize = opts.sampleSize ?? 3;
  const smartWalletOverlap = opts.smartWalletOverlap ?? 0;
  const holderRows = Array.isArray(holders.holders) ? holders.holders : [];

  const top10 = holderRows.slice(0, 10);
  const top10Percent = top10.reduce((sum, h) => sum + (Number(h.percent) || 0), 0);
  const maxPct = Number(holders.maxHolderPercent) || 0;
  const top20Pct = Number(holders.top20Percent) || 0;

  return {
    count: holders.count ?? holderRows.length,
    top10Percent: compactNumber(top10Percent, 2),
    top20Percent: compactNumber(top20Pct, 4),
    maxHolderPercent: compactNumber(maxPct, 4),
    largeHolderCount: holderRows.filter(h => (Number(h.percent) || 0) > 2).length,
    concentrationRisk: concentrationRiskLevel(maxPct, top20Pct),
    smartWalletOverlap,
    holder_format: ['rank', 'address', 'amount', 'percent', 'tags'],
    sample: holderRows.slice(0, sampleSize).map(compactHolder),
  };
}
```

#### 4. Update `compactCandidateForLlm`

Change the `holders:` line (currently line 119) from:

```js
holders: compactHoldersForLlm(c.holders),
```

to:

```js
holders: holderRiskSummary(c.holders, {
  sampleSize: numSetting('llm_holder_sample_per_candidate', 3),
  smartWalletOverlap: c.savedWalletExposure?.holderCount ?? 0,
}),
```

All other fields in `compactCandidateForLlm` remain unchanged.

#### 5. Add `enforcePayloadBudget`

Add before `decideCandidateBatch`:

```js
function enforcePayloadBudget(userPayload, budgetBytes) {
  let serialized = JSON.stringify(userPayload);
  let bytes = Buffer.byteLength(serialized, 'utf8');

  if (bytes <= budgetBytes) {
    return { payload: userPayload, bytes, enforced: false };
  }

  for (const c of userPayload.candidates) {
    if (c.chart) delete c.chart.windows;
  }
  serialized = JSON.stringify(userPayload);
  bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= budgetBytes) {
    return { payload: userPayload, bytes, enforced: true };
  }

  for (const c of userPayload.candidates) {
    if (c.holders?.sample?.length > 1) {
      c.holders.sample = c.holders.sample.slice(0, 1);
    }
  }
  serialized = JSON.stringify(userPayload);
  bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes <= budgetBytes) {
    return { payload: userPayload, bytes, enforced: true };
  }

  while (userPayload.candidates.length > 1) {
    userPayload.candidates.pop();
    serialized = JSON.stringify(userPayload);
    bytes = Buffer.byteLength(serialized, 'utf8');
    if (bytes <= budgetBytes) {
      return { payload: userPayload, bytes, enforced: true };
    }
  }

  return { payload: null, bytes, enforced: true, skip: true };
}
```

Progressive trimming order:
1. Drop `chart.windows` arrays (keep `athContext24h` which is separate)
2. Reduce holder samples to 1 per candidate
3. Drop trailing candidates one at a time (keep at least 1)
4. If still over: signal skip

#### 6. Update `decideCandidateBatch`

Replace the try block (starting after the `user` object construction, before the
axios call) to add budget enforcement. The full updated function body from the
`try {` line:

```js
  try {
    const budgetKb = numSetting('llm_payload_budget_kb', 40);
    const budgetBytes = budgetKb * 1024;
    const { payload, bytes, enforced, skip } = enforcePayloadBudget(user, budgetBytes);

    if (skip) {
      console.log(`[llm] payload ${bytes} bytes exceeds ${budgetKb}KB budget after all trims, skipping`);
      return {
        verdict: 'WATCH',
        confidence: 0,
        selected_candidate_id: null,
        selected_mint: null,
        reason: `Payload ${bytes} bytes exceeds ${budgetKb}KB budget.`,
        risks: ['payload_budget_exceeded'],
        suggested_tp_percent: numSetting('default_tp_percent', 50),
        suggested_sl_percent: numSetting('default_sl_percent', -25),
        raw: { payloadBytes: bytes, budgetKb },
        _payloadMeta: { bytes, holderRowsSent: 0, enforced: true },
      };
    }

    if (enforced) {
      console.log(`[llm] payload trimmed to ${bytes} bytes (budget ${budgetKb}KB, ${payload.candidates.length} candidates)`);
    }

    const holderRowsSent = payload.candidates
      .reduce((sum, c) => sum + (c.holders?.sample?.length || 0), 0);

    if (boolSetting('llm_payload_debug_log', false)) {
      console.log(`[llm] payload debug (${bytes} bytes): ${JSON.stringify(payload).slice(0, 2000)}`);
    }

    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(payload) },
      ],
    }, {
      timeout: timeoutMs,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
      _payloadMeta: { bytes, holderRowsSent, enforced },
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
      _payloadMeta: { bytes: 0, holderRowsSent: 0, enforced: false },
    };
  }
```

Key changes vs current:
- `user` is replaced by `payload` (the potentially-trimmed version) in the API call
- Budget enforcement and skip logic added before the API call
- `_payloadMeta` added to every return path
- Debug log option added

#### 7. Update system prompt

In the `system` array inside `decideCandidateBatch`, replace:

```
'Holder rows are compact arrays in holder_format order; every provided top_holders row preserves its full wallet address.',
```

with:

```
'Holder data per candidate is a risk summary: concentrationRisk (low/medium/high/critical), top10Percent, top20Percent, maxHolderPercent, largeHolderCount, smartWalletOverlap, plus a small sample in holder_format order. Use the summary metrics for risk assessment.',
```

### File: `src/db/connection.js`

#### 1. Add new settings defaults

Add these entries to the `defaults` object (after `llm_timeout_ms`):

```js
llm_holder_sample_per_candidate: '3',
llm_payload_budget_kb: '40',
llm_payload_debug_log: 'false',
```

#### 2. Add audit columns to `llm_batches`

Add after the existing `ensureColumn` calls for `decision_logs` (around line 234):

```js
ensureColumn('llm_batches', 'payload_size_bytes', 'INTEGER');
ensureColumn('llm_batches', 'holder_rows_sent', 'INTEGER');
ensureColumn('llm_batches', 'budget_enforced', 'INTEGER DEFAULT 0');
```

### File: `src/db/decisions.js`

#### 1. Update `storeBatchDecision`

Replace the existing `storeBatchDecision` function with:

```js
export function storeBatchDecision(triggerCandidateId, rows, batchDecision) {
  const selectedRow = batchDecision.selected_row;
  const meta = batchDecision._payloadMeta || {};
  const result = db.prepare(`
    INSERT INTO llm_batches (
      created_at_ms, trigger_candidate_id, selected_candidate_id, selected_mint,
      verdict, confidence, reason, risks_json, raw_json, candidate_ids_json,
      payload_size_bytes, holder_rows_sent, budget_enforced
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    now(),
    triggerCandidateId,
    selectedRow?.id || null,
    selectedRow?.candidate?.token?.mint || null,
    batchDecision.verdict,
    batchDecision.confidence,
    batchDecision.reason || null,
    json(batchDecision.risks || []),
    json(batchDecision),
    json(rows.map(row => row.id)),
    meta.bytes || null,
    meta.holderRowsSent || null,
    meta.enforced ? 1 : 0,
  );
  return Number(result.lastInsertRowid);
}
```

Changes vs current:
- Reads `batchDecision._payloadMeta` for the new columns
- INSERT adds 3 new columns and 3 new parameter slots
- Defaults gracefully when `_payloadMeta` is missing

## What NOT to do

- Do not modify `src/pipeline/orchestrator.js` — it passes `batchDecision`
  through unchanged; `_payloadMeta` flows naturally
- Do not modify `src/enrichment/wallets.js` — wallet evidence is unchanged
- Do not modify `logDecisionEvent` or the `batch_json` shape in decision logs —
  those already store compact holder summaries from the raw candidate data
- Do not modify `filterCandidate` or any filter/strategy logic
- Do not modify Telegram menus, commands, or formatting
- Do not read `.env`, secrets, Telegram tokens, wallet/private keys
- Do not run live trading, confirm trading, wallet signing, swaps, or Telegram
  command flows
- Do not start services, PM2, bot processes, or runtime checks
- Do not install dependencies
- Do not delete `compactHolder` — it is still used by `holderRiskSummary` for
  the sample rows

## Verification

1. `node --check src/pipeline/llm.js` passes
2. `node --check src/db/connection.js` passes
3. `node --check src/db/decisions.js` passes
4. `compactHoldersForLlm` function no longer exists in `llm.js`
5. `holderRiskSummary` exists and returns an object with keys: `count`,
   `top10Percent`, `top20Percent`, `maxHolderPercent`, `largeHolderCount`,
   `concentrationRisk`, `smartWalletOverlap`, `holder_format`, `sample`
6. `enforcePayloadBudget` exists and is called before the axios call in
   `decideCandidateBatch`
7. System prompt no longer mentions `top_holders`; mentions `concentrationRisk`
   and `sample` instead
8. `storeBatchDecision` INSERT includes `payload_size_bytes`,
   `holder_rows_sent`, `budget_enforced`
9. `connection.js` defaults include `llm_holder_sample_per_candidate`,
   `llm_payload_budget_kb`, `llm_payload_debug_log`
10. `connection.js` has `ensureColumn` calls for the 3 new `llm_batches` columns

## Rollback plan

All changes are backward-compatible:
- The new `llm_batches` columns have defaults and are nullable, so old rows are
  fine
- The new settings have defaults in `connection.js`, so no manual config needed
- If the holder summary causes worse LLM decisions, increase
  `llm_holder_sample_per_candidate` to restore more raw data (up to the old 100)
- If the payload budget enforcement is too aggressive, increase
  `llm_payload_budget_kb` (e.g., to 100) to effectively disable it
- If needed, revert `holderRiskSummary` back to the old `compactHoldersForLlm`
  shape — the LLM adapts to whatever is in the system prompt

## Files to modify

| File | Change |
|------|--------|
| `src/pipeline/llm.js` | Replace `compactHoldersForLlm` with `holderRiskSummary`, add `concentrationRiskLevel`, add `enforcePayloadBudget`, update `compactCandidateForLlm`, update `decideCandidateBatch`, update system prompt, add `boolSetting` import |
| `src/db/connection.js` | Add 3 settings defaults, add 3 `ensureColumn` calls for `llm_batches` |
| `src/db/decisions.js` | Update `storeBatchDecision` to write 3 new columns from `_payloadMeta` |

## Files to read (context)

| File | Why |
|------|-----|
| `src/pipeline/llm.js` | Full current implementation of payload construction |
| `src/db/connection.js` | Settings defaults and schema migration pattern |
| `src/db/decisions.js` | `storeBatchDecision` current shape |
| `src/pipeline/orchestrator.js` | How `decideCandidateBatch` return value flows to `storeBatchDecision` — confirms no orchestrator changes needed |
| `src/enrichment/wallets.js` | Wallet evidence pattern (reference, not modified) |

## Follow-up tickets

After this ticket lands:

- **WP-M7-2: Payload replay estimation script** — `scripts/estimate_payload_size.js`
  reads recent `llm_batches` + `candidates`, reconstructs compact payloads, reports
  estimated sizes. Validates the budget is working without making LLM calls.
- **Monitoring** — after VPS deployment, check `llm_batches.payload_size_bytes` to
  confirm payloads are under 20 KB and no `budget_enforced = 1` rows appear.
