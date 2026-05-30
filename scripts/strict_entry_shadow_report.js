#!/usr/bin/env node
import fs from 'node:fs';
import Database from 'better-sqlite3';

function parseArgs(argv) {
  const opts = {
    db: process.env.DB_PATH || '/opt/trading-data/charon.sqlite',
    hours: 24,
  };
  for (const arg of argv) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (!match) throw new Error(`Unknown argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'db') opts.db = value;
    else if (key === 'hours') opts.hours = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function safeJson(value, fallback = {}) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}

function pct(n, d) {
  if (!d) return 0;
  return Number(((n / d) * 100).toFixed(1));
}

const opts = parseArgs(process.argv.slice(2));
if (!fs.existsSync(opts.db)) throw new Error(`DB not found: ${opts.db}`);

const db = new Database(opts.db, { readonly: true, fileMustExist: true });
const since = Date.now() - Math.max(1, opts.hours) * 60 * 60_000;
const rows = db.prepare(`
  SELECT id, at_ms, selected_candidate_id, selected_mint, mode, guardrails_json
  FROM decision_logs
  WHERE action = 'entry_confirm_strict_shadow'
    AND at_ms >= ?
  ORDER BY at_ms ASC
`).all(since);

const reasonCounts = new Map();
const details = rows.map(row => {
  const guardrails = safeJson(row.guardrails_json);
  const shadow = guardrails.strictEntryShadow || {};
  for (const reason of shadow.reasons || []) {
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }
  return {
    id: row.id,
    at_ms: row.at_ms,
    selected_candidate_id: row.selected_candidate_id,
    mint: row.selected_mint,
    mode: row.mode,
    strict_pass: Boolean(shadow.pass),
    reasons: shadow.reasons || [],
    observed: shadow.observed || {},
  };
});

const passCount = details.filter(row => row.strict_pass).length;
const failCount = details.length - passCount;
console.log(JSON.stringify({
  db: opts.db,
  hours: opts.hours,
  since,
  total: details.length,
  pass: passCount,
  fail: failCount,
  fail_rate_pct: pct(failCount, details.length),
  reason_counts: Object.fromEntries([...reasonCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
  recent: details.slice(-20),
}, null, 2));

db.close();
