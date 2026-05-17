#!/usr/bin/env node
/**
 * Export the current Charon saved_wallets table as a portable seed artifact.
 *
 * This is read-only. It does not start Charon, call providers, read .env, or
 * change SQLite state. The output can be fed back into import_priority_wallets
 * on a fresh DB because every exported row is marked import_candidate=true.
 *
 * Usage:
 *   node scripts/export_saved_wallets_seed.js
 *   node scripts/export_saved_wallets_seed.js --priority=reports/smart-wallet-priority-...json
 *   node scripts/export_saved_wallets_seed.js --charon-db=/path/to/charon.sqlite
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(REPO_ROOT, 'reports');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function latestPriorityJson() {
  if (!fs.existsSync(REPORT_DIR)) return '';
  return fs.readdirSync(REPORT_DIR)
    .filter(name => /^smart-wallet-priority-.*\.json$/.test(name))
    .map(name => path.join(REPORT_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
}

function loadPriorityRows(priorityPath) {
  if (!priorityPath || !fs.existsSync(priorityPath)) return new Map();
  const payload = JSON.parse(fs.readFileSync(priorityPath, 'utf8'));
  const rows = Array.isArray(payload) ? payload : payload.rows;
  if (!Array.isArray(rows)) return new Map();
  return new Map(rows.map(row => [row.address || row.wallet_address, row]));
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, rows) {
  const headers = [
    'address',
    'label',
    'tier',
    'review_lane',
    'score',
    'import_candidate',
    'import_blocked',
    'import_block_reason',
    'owner_manual_label',
    'llm_recommended_action',
    'gmgn_profile_fresh',
    'source_priority_export',
  ];
  const lines = [
    headers.join(','),
    ...rows.map(row => headers.map(header => csvCell(row[header])).join(',')),
  ];
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

const charonDbPath = path.resolve(argValue('charon-db', path.join(REPO_ROOT, 'charon.sqlite')));
const priorityPath = path.resolve(argValue('priority', latestPriorityJson()));

if (!fs.existsSync(charonDbPath)) throw new Error(`Charon DB not found: ${charonDbPath}`);

const priorityByAddress = loadPriorityRows(priorityPath);
const db = new Database(charonDbPath, { readonly: true, fileMustExist: true });
const saved = db.prepare('SELECT label, address, created_at_ms FROM saved_wallets ORDER BY label').all();
db.close();

fs.mkdirSync(REPORT_DIR, { recursive: true });
const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
const rows = saved.map(wallet => {
  const priority = priorityByAddress.get(wallet.address) || {};
  return {
    address: wallet.address,
    label: wallet.label,
    wallet_label: wallet.label,
    tier: priority.tier || '',
    review_lane: priority.review_lane || '',
    score: priority.score ?? '',
    import_candidate: true,
    import_blocked: false,
    import_block_reason: '',
    owner_manual_label: priority.owner_manual_label || '',
    llm_recommended_action: priority.llm_recommended_action || '',
    gmgn_profile_fresh: priority.gmgn_profile_fresh ?? '',
    source_priority_export: priorityPath,
    created_at_ms: wallet.created_at_ms,
  };
});

const laneCounts = rows.reduce((acc, row) => {
  const lane = row.review_lane || 'unknown';
  acc[lane] = (acc[lane] || 0) + 1;
  return acc;
}, {});

const jsonPath = path.join(REPORT_DIR, `charon-saved-wallets-seed-${stamp}.json`);
const csvPath = path.join(REPORT_DIR, `charon-saved-wallets-seed-${stamp}.csv`);
fs.writeFileSync(jsonPath, `${JSON.stringify({
  created_at: createdAt,
  charon_db_path: charonDbPath,
  source_priority_export: priorityPath,
  count: rows.length,
  lane_counts: laneCounts,
  rows,
}, null, 2)}\n`);
writeCsv(csvPath, rows);

console.log(`Exported ${rows.length} saved wallets`);
console.log(`Lane counts ${JSON.stringify(laneCounts)}`);
console.log(`JSON ${jsonPath}`);
console.log(`CSV ${csvPath}`);
