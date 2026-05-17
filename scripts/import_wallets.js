/**
 * Bulk wallet importer for Charon — reads from moonbags wallet-review CSV.
 * Usage: node scripts/import_wallets.js
 *
 * Reads all 720 wallets from the latest wallet-review CSV and bulk-inserts
 * them into charon.sqlite. Safe to re-run (INSERT OR REPLACE on label).
 *
 * Label priority: wallet_label → twitter_username → twitter_name → address[:8]
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

const CSV_PATH = path.resolve(
  process.env.WALLET_REVIEW_CSV || path.join(REPO_ROOT, '../moonbags/tools/wallet-harvester/reports/wallet-review-2026-05-11T05-34-15-371Z.csv')
);
const CHARON_DB = path.resolve(__dirname, '../charon.sqlite');

// Minimal CSV parser — handles quoted fields with commas inside
function parseCSV(content) {
  const lines = content.split(/\r?\n/).filter(Boolean);
  const headers = splitCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

function splitCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// Sanitize label: keep alphanumeric, spaces, dots, dashes, underscores; collapse; trim
function sanitizeLabel(raw) {
  return raw
    .trim()
    .replace(/[^\w\s.\-]/g, '')   // strip emoji / non-ASCII / special chars
    .replace(/\s+/g, '_')         // spaces → underscores
    .replace(/_+/g, '_')          // collapse multiple underscores
    .replace(/^_+|_+$/g, '')      // trim leading/trailing underscores
    .slice(0, 64);
}

const rows = parseCSV(fs.readFileSync(CSV_PATH, 'utf8'));
const dst = new Database(CHARON_DB);

// INSERT OR IGNORE: skips if label OR address already in DB (same wallet, different label)
const stmt = dst.prepare(`
  INSERT OR IGNORE INTO saved_wallets (label, address, created_at_ms)
  VALUES (?, ?, ?)
`);

const labelsSeen = new Map();
let inserted = 0;
let skipped = 0;
let dupAddress = 0;

for (const row of rows) {
  const address = row.wallet_address?.trim();
  if (!address) { skipped++; continue; }

  const rawLabel =
    row.wallet_label?.trim() ||
    row.twitter_username?.trim() ||
    row.twitter_name?.trim() ||
    address.slice(0, 8);

  let label = sanitizeLabel(rawLabel);

  if (!label) {
    console.warn(`  skipped ${address.slice(0, 8)}... — label sanitized to empty`);
    skipped++;
    continue;
  }

  // Deduplicate: if label already used, append _2, _3, etc.
  if (labelsSeen.has(label)) {
    const count = labelsSeen.get(label) + 1;
    labelsSeen.set(label, count);
    label = `${label}_${count}`;
  } else {
    labelsSeen.set(label, 1);
  }

  const result = stmt.run(label, address, Date.now());
  if (result.changes === 0) {
    console.log(`  ~ dup  ${label.padEnd(36)} ${address}`);
    dupAddress++;
  } else {
    console.log(`  ✓ ${label.padEnd(36)} ${address}`);
    inserted++;
  }
}

dst.close();

console.log(`\nDone — ${inserted} inserted, ${dupAddress} dup addresses ignored, ${skipped} skipped (of ${rows.length} total) → ${CHARON_DB}`);
