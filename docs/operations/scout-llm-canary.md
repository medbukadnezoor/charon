# Scout LLM Canary Runbook

This runbook is for a bounded owner-facing canary of the isolated scout LLM
lane. It starts only `charon-scout`, verifies the PM2 environment is scout-safe,
stops and deletes only `charon-scout`, restores the exact prior scout strategy
config when a temporary max-open override was used, and prints a report for the
precise canary window.

## Current Safe Route

The scout PM2 entry in `ecosystem.config.cjs` uses:

- `LLM_PROVIDER_ORDER=gemini,mistral`
- Gemini first: `gemini-2.5-flash-lite`
- Mistral fallback: `mistral-small-latest`
- No scout MiMo route
- No scout `cliproxy` route

Do not infer safety from older broad report windows. Stale scout history may
include previous MiMo or `cliproxy` attempts from before the current route.

## Safety Boundaries

Allowed by this runbook:

- Run `scripts/run_scout_llm_canary.js`.
- Run `scripts/scout_llm_canary_report.js`.
- Start `charon-scout` only through the canary runner.
- Let the runner delete only `charon-scout` when the canary ends.
- Keep `charon-scout-learning` absent from PM2 before the canary. The runner
  refuses to start if the learner is still registered.
- Use `--max-open-positions=N` when existing scout dry-run positions block new
  calls, with `N` just above the current open count and never above the script
  cap.

Not allowed by this runbook:

- Read, print, copy, validate, or modify `.env` or secrets.
- Restart main `charon`.
- Restart shadow processes.
- Restart `cli-proxy-api`.
- Start or restart `charon-scout-learning`.
- Enable live scout trading.
- Leave learner running unless a separate owner-approved ticket explicitly
  permits it.

## Bounded Canary

Default VPS scout DB:

```bash
/var/oled/charon-data/trading-data/charon-scout.sqlite
```

Standard bounded run:

```bash
pm2 delete charon-scout-learning || true
node scripts/run_scout_llm_canary.js \
  --db=/var/oled/charon-data/trading-data/charon-scout.sqlite \
  --duration-min=30 \
  --max-calls=20 \
  --poll-sec=10
```

If the runner refuses because existing scout dry-run positions already meet
`max_open_positions`, use a temporary canary override just above the current
open count:

```bash
pm2 delete charon-scout-learning || true
node scripts/run_scout_llm_canary.js \
  --db=/var/oled/charon-data/trading-data/charon-scout.sqlite \
  --duration-min=30 \
  --max-calls=20 \
  --poll-sec=10 \
  --max-open-positions=2
```

The runner stores the exact previous `strategy:scout.config_json` before the
override and restores that exact JSON during cleanup. This is not a permanent
config change.

The runner prints:

```text
[scout-canary] start_ms=...
```

Use that timestamp for the precise report window.

## Reporting

Preferred precise report:

```bash
node scripts/scout_llm_canary_report.js \
  --db=/var/oled/charon-data/trading-data/charon-scout.sqlite \
  --since-ms=START_MS_FROM_RUNNER \
  --format=text
```

JSON form:

```bash
node scripts/scout_llm_canary_report.js \
  --db=/var/oled/charon-data/trading-data/charon-scout.sqlite \
  --since-ms=START_MS_FROM_RUNNER \
  --format=json
```

Avoid broad `--hours` windows for readiness calls unless the goal is historical
forensics. Broad windows can include stale MiMo or `cliproxy` rows from before
the current scout route and make a fresh Gemini/Mistral canary look unsafe.

## Readiness Interpretation

Treat the canary as ready only when the report supports all of these:

- `has_llm_calls=PASS`
- `has_gemini_usage=PASS`
- `no_mimo_usage=PASS`
- `no_cliproxy_usage=PASS`
- `no_provider_errors=PASS`
- `no_schema_errors=PASS`
- `no_parse_errors=PASS`
- `no_empty_content_errors=PASS`
- `dry_run_mode=PASS`
- `scout_strategy_active=PASS`
- Provider rows show Gemini usage and no MiMo or `cliproxy` usage.
- If Mistral small appears, treat it as a fallback/error investigation signal
  unless the precise canary window still passes every health check above.
- No provider, schema, parse, or empty-response failure pattern appears in the
  canary window.

If any check fails, do not restart broader processes and do not change live
trading. Capture the precise `--since-ms` report and investigate scout-only.

## Known Caveat

`--max-calls` is enforced by polling `llm_usage_events`. Calls can overshoot by
whatever `charon-scout` admits during one poll interval. Use a shorter
`--poll-sec`, such as `--poll-sec=3`, when tighter bounds matter.
