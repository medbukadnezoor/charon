# Architect Ticket: WP-ARTIFACT-BOUNDARY-1

## Title

Decouple Charon scripts from MoonBags repo path; use env-configured harvester DB path and Charon's own better-sqlite3

## Goal

Remove the two coupling points that prevent Charon's wallet-pipeline scripts
from running on any machine layout (VPS, different dev, CI):

1. Hardcoded `DEFAULT_HARVESTER_ROOT` pointing to a sibling MoonBags repo path
2. `createRequire` borrowing `better-sqlite3` from the harvester's node_modules

After this ticket, Charon scripts read harvester data from a configurable path
and use their own `better-sqlite3` dependency. Zero code movement between repos.

## Architecture Decision: Option D

Keep harvester code in MoonBags. Charon reads a stable, configurable harvester
DB path. On local dev the default still points to the current location. On VPS
the operator sets `HARVESTER_DB_PATH=/opt/trading-data/harvester.db` (or
wherever the harvester materializes its DB).

Why Option D:
- Minimal change — fixes only the two broken coupling points
- No repo split, no code movement, no service naming
- Works locally with current layout (backward compat default)
- Works on VPS with one env var
- Leaves the door open for Option B (shared service) later if needed

## Depends On

Nothing — this is a decoupling ticket, no new features.

## Safety Boundaries

- Do not read, print, copy, validate, or modify `.env` or secrets
- Do not start Charon, PM2, Telegram, trading, signing, or swaps
- Do not install new dependencies (Charon already has `better-sqlite3`)
- Do not move harvester code or files between repos
- Do not change harvester code in MoonBags

---

## Changes

### Files to change (all in Charon repo)

| File | What changes |
|------|-------------|
| `scripts/export_wallet_priority.js` | Remove `harvesterRequire`, use direct import, update default path logic |
| `scripts/llm_wallet_reviewer.js` | Same |
| `scripts/refresh_wallet_pnl.js` | Same |

### Change 1: Replace `createRequire` with direct import

All 3 scripts currently do:

```js
const harvesterRequire = createRequire(path.join(DEFAULT_HARVESTER_ROOT, 'package.json'));
const Database = harvesterRequire('better-sqlite3');
```

Replace with:

```js
import Database from 'better-sqlite3';
```

Charon already has `better-sqlite3@^12.9.0` in its own `package.json` and
`node_modules`. The `createRequire` trick was needed when Charon didn't have
the dependency — it does now, so remove the indirection.

Also remove the `createRequire` import if it's no longer used elsewhere in the file:

```js
// Remove this line if no other uses remain:
import { createRequire } from 'module';
```

### Change 2: Replace hardcoded `DEFAULT_HARVESTER_ROOT` with `DEFAULT_HARVESTER_DB`

All 3 scripts currently have:

```js
const DEFAULT_HARVESTER_ROOT = '../moonbags/tools/wallet-harvester';
const DEFAULT_HARVESTER_DB = path.join(DEFAULT_HARVESTER_ROOT, 'data/harvester.db');
```

Replace with a single constant that resolves the DB path:

```js
// Local dev default — override with HARVESTER_DB_PATH env var for VPS or other layouts.
const DEFAULT_HARVESTER_DB = '../moonbags/tools/wallet-harvester/data/harvester.db';
```

Remove `DEFAULT_HARVESTER_ROOT` entirely. No script uses the harvester root
for anything except constructing the DB path (now that `createRequire` is gone).

The existing env var override already works:

```js
// In export_wallet_priority.js:
const harvesterDb = path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB));

// In llm_wallet_reviewer.js:
harvesterDbPath: path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB)),

// In refresh_wallet_pnl.js:
const harvesterDb = path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB));
```

These already exist and work. No change needed to the resolution logic.

### Change 3: Update header comments

Each script has a usage comment block. Update the `HARVESTER_DB_PATH` example
to make the env var more prominent:

```js
/**
 * ...existing description...
 *
 * Usage:
 *   node scripts/export_wallet_priority.js
 *   HARVESTER_DB_PATH=/opt/trading-data/harvester.db node scripts/export_wallet_priority.js
 *   node scripts/export_wallet_priority.js --harvester-db=/path/to/harvester.db
 */
```

---

## VPS Deployment Plan

The MoonBags VPS is already online with old MoonBags on it. The plan:

1. **Clone the wallet-harvester onto the VPS** inside the existing MoonBags
   project (it already lives at `moonbags/tools/wallet-harvester`). Pull latest
   to get `enrichWalletProfile.ts` and the current harvester code.

2. **Set up harvester `.env` on VPS** with its own `GMGN_API_KEY` and
   `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`. These are the
   harvester's own keys — separate from Charon's. OKX should work on VPS
   (no local ISP TLS interception problem).

3. **Harvester writes `harvester.db` to a shared data path:**

```
/opt/trading-data/
├── harvester.db          ← MoonBags harvester writes here
├── charon.sqlite         ← Charon runtime DB (future)
└── reports/              ← shared artifact directory (future)
```

Set in harvester's VPS `.env`:
```bash
HARVESTER_DB_PATH=/opt/trading-data/harvester.db
```

4. **Charon reads from the same path** via env var:

```bash
export HARVESTER_DB_PATH=/opt/trading-data/harvester.db
```

5. **Run harvester on VPS schedule** (cron or PM2, separate ticket):
   - Harvest: every 4-6 hours
   - GMGN profile enrichment: every 6-12 hours, `--limit=50`
   - OKX profile enrichment: every 12-24 hours, `--okx --okx-limit=25`
   - Jupiter PnL refresh: daily, `--limit=100`

Each process writes to the same `harvester.db`. Charon scripts only read it.
No provider keys cross the boundary. Data is always as fresh as the last
harvester run.

This ticket only does the local code decoupling (remove hardcoded paths). The
actual VPS clone, `.env` setup, and cron schedule are a separate deployment
ticket after this lands.

---

## Secret Boundary (no changes, document only)

Current state is already correct — document it in the header comments:

- GMGN/OKX keys: owned by harvester process, in harvester `.env`. Charon
  scripts never read them.
- LLM key: runtime-injected via `LLM_API_KEY` env var. Not in any `.env` file.
- Charon scripts only read `harvester.db` as a SQLite file — no provider
  credentials pass through.

---

## Forbidden Actions

- Do not move files between repos
- Do not change MoonBags harvester code
- Do not install new dependencies
- Do not change DB schemas
- Do not change scoring, LLM, or import logic
- Do not read/print secrets or `.env`

## Verifier Checklist

1. `grep -r "createRequire" scripts/export_wallet_priority.js scripts/llm_wallet_reviewer.js scripts/refresh_wallet_pnl.js` returns **nothing**
2. `grep -r "harvesterRequire" scripts/export_wallet_priority.js scripts/llm_wallet_reviewer.js scripts/refresh_wallet_pnl.js` returns **nothing**
3. `grep -r "DEFAULT_HARVESTER_ROOT" scripts/export_wallet_priority.js scripts/llm_wallet_reviewer.js scripts/refresh_wallet_pnl.js` returns **nothing**
4. All 3 scripts use `import Database from 'better-sqlite3'` (or equivalent ESM)
5. All 3 scripts have `DEFAULT_HARVESTER_DB` as a single string constant (not built from ROOT)
6. `node --check scripts/export_wallet_priority.js` passes
7. `node --check scripts/llm_wallet_reviewer.js` passes
8. `node --check scripts/refresh_wallet_pnl.js` passes
9. `HARVESTER_DB_PATH` env var override still works: set it to a non-existent path, confirm scripts fail with a clear "DB not found" error (not a cryptic module resolution error)
10. With no env var set, scripts still find the default local path and run normally (backward compat)
11. No changes to any file outside `scripts/` in Charon repo
12. No changes to any file in MoonBags repo

## Acceptance Criteria (Owner-Checkable)

- All 3 scripts still work exactly as before on your local machine
- `HARVESTER_DB_PATH=/some/other/path` overrides the default (try with the real DB copied elsewhere)
- No reference to `moonbags/tools/wallet-harvester` remains as a module resolution path (only as a default DB file path)
- When you deploy to VPS, you just set one env var and the scripts work

## Files to Read (Coder Reference)

1. `scripts/export_wallet_priority.js` — lines 17-35 (imports and DEFAULT_HARVESTER constants)
2. `scripts/llm_wallet_reviewer.js` — lines 23-36 (same pattern)
3. `scripts/refresh_wallet_pnl.js` — lines 17-21 (same pattern)
4. `package.json` — confirm `better-sqlite3` is already a dependency
