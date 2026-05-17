# WP-M5-3: LLM payload + decision log compact evidence integration

**Type:** Coder
**Parent plan:** `SMART_WALLET_ARCH_PLAN.md`
**Status:** Open

---

## Goal

Pass compact wallet evidence to the LLM instead of the full `savedWalletExposure`
blob, and write a compact `walletEvidence` field to decision logs. No changes to
`filterCandidate` — `min_saved_wallet_holders` reads `holderCount` which is unchanged.

## Owner-visible outcome

After this ticket:
1. The LLM prompt receives `savedWalletExposure.evidence.summary` and the top 5
   matched wallets (by tier/score) instead of the full `matchedWallets` array.
2. Decision logs include a compact `walletEvidence` field in `candidate_json`.
3. `node --check` passes on all modified files.
4. No existing fields are removed — backward compat is preserved.

---

## What to implement

### File 1: `src/pipeline/llm.js` — update `compactCandidateForLlm`

**Current** (last few lines of the function):
```js
    savedWalletExposure: c.savedWalletExposure,
    kolDumpRisk: c.kolDumpRisk,
```

**Replace with:**
```js
    savedWalletExposure: compactWalletExposureForLlm(c.savedWalletExposure),
    kolDumpRisk: c.kolDumpRisk,
```

**Add this helper function** anywhere before `compactCandidateForLlm`:

```js
const TIER_ORDER = { A: 0, B: 1, C: 2, universe: 3 };

function compactWalletExposureForLlm(exposure = {}) {
  // Always preserve the scalar fields the LLM and filters rely on
  const base = {
    holderCount: exposure.holderCount ?? 0,
    checked: exposure.checked ?? 0,
    wallets: Array.isArray(exposure.wallets) ? exposure.wallets : [],
  };

  const evidence = exposure.evidence;
  if (!evidence) return base;

  // Top 5 matched wallets sorted by tier then gmgn winrate descending
  const topWallets = Array.isArray(evidence.wallets)
    ? [...evidence.wallets]
        .sort((a, b) => {
          const tierDiff = (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99);
          if (tierDiff !== 0) return tierDiff;
          return (b.gmgn?.wr ?? 0) - (a.gmgn?.wr ?? 0);
        })
        .slice(0, 5)
    : [];

  return {
    ...base,
    evidenceSummary: evidence.summary ?? null,
    topMatchedWallets: topWallets,
  };
}
```

### File 2: `src/db/decisions.js` — add compact walletEvidence to candidate_json log

**Current** `logDecisionEvent` batch_json mapper (inside the `json(rows.map(...))` call):
```js
        savedWalletExposure: c.savedWalletExposure,
```

**Replace with:**
```js
        savedWalletExposure: compactWalletExposureForLog(c.savedWalletExposure),
```

**Add this helper function** at the top of `decisions.js` (after imports):

```js
const TIER_ORDER_LOG = { A: 0, B: 1, C: 2, universe: 3 };

function compactWalletExposureForLog(exposure = {}) {
  if (!exposure) return null;
  const evidence = exposure.evidence;
  const matched = evidence?.wallets ?? [];

  // Compact log format per wallet: shortAddr:tier:primaryTag:freshnessFlag
  const walletLines = matched
    .slice(0, 10)
    .sort((a, b) => (TIER_ORDER_LOG[a.tier] ?? 99) - (TIER_ORDER_LOG[b.tier] ?? 99))
    .map(w => {
      const tag = w.tags?.[0] ?? 'unknown';
      const freshFlag = w.gmgn?.fresh ? 'gmgn_fresh'
        : w.jup?.fresh ? 'jup_fresh'
        : 'stale';
      return `${w.addr}:${w.tier}:${tag}:${freshFlag}`;
    });

  return {
    holderCount: exposure.holderCount ?? 0,
    checked: exposure.checked ?? 0,
    walletEvidence: {
      matched: exposure.holderCount ?? 0,
      strongCount: evidence?.summary?.strongCount ?? 0,
      kolCount: evidence?.summary?.kolCount ?? 0,
      wallets: walletLines,
    },
  };
}
```

---

## What NOT to do

- Do not modify `filterCandidate` — `min_saved_wallet_holders` reads `holderCount`
  which is still present in the base object
- Do not remove `holderCount`, `checked`, or `wallets` from any return value
- Do not modify `fetchSavedWalletExposure` or `wallets.js`
- Do not run Charon, PM2, Telegram, trading, signing, or swaps
- Do not read `.env` or secrets
- Do not install dependencies

---

## Verification

1. `node --check src/pipeline/llm.js` passes
2. `node --check src/db/decisions.js` passes
3. `compactCandidateForLlm` calls `compactWalletExposureForLlm` (not raw `c.savedWalletExposure`)
4. `logDecisionEvent` batch mapper calls `compactWalletExposureForLog`
5. Both helpers preserve `holderCount` and `checked`

---

## Files to modify

| File | Change |
|------|--------|
| `src/pipeline/llm.js` | Add `compactWalletExposureForLlm`, update `compactCandidateForLlm` |
| `src/db/decisions.js` | Add `compactWalletExposureForLog`, update `logDecisionEvent` batch mapper |

## Files to read (context)

| File | Why |
|------|-----|
| `src/pipeline/llm.js` | Full current `compactCandidateForLlm` |
| `src/db/decisions.js` | Full current `logDecisionEvent` |
| `SMART_WALLET_ARCH_PLAN.md` sections 3c–3e | Evidence compaction design |
