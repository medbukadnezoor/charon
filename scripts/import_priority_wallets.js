/**
 * Import approved priority wallets into Charon's saved_wallets table.
 *
 * Dry-run by default. Pass --commit to write. This script does not delete
 * wallets and does not start Charon, Telegram, providers, or trading paths.
 *
 * Usage:
 *   node scripts/import_priority_wallets.js --input=reports/smart-wallet-priority-...json
 *   node scripts/import_priority_wallets.js --input=...json --tiers=A,B --commit
 *   node scripts/import_priority_wallets.js --input=...csv --min-score=100 --commit
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const raw = argValue(name, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function splitCsvLine(line) {
  const fields = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"' && quoted && next === '"') {
      current += '"';
      i++;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function readCsv(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
  });
}

function readRows(inputPath) {
  if (inputPath.endsWith('.json')) {
    const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    if (Array.isArray(payload)) return payload;
    if (Array.isArray(payload.rows)) return payload.rows;
    throw new Error(`JSON input has no rows array: ${inputPath}`);
  }
  if (inputPath.endsWith('.csv')) return readCsv(inputPath);
  throw new Error(`Unsupported input type: ${inputPath}`);
}

function latestPriorityJson() {
  const reportDir = path.join(REPO_ROOT, 'reports');
  if (!fs.existsSync(reportDir)) return null;
  const files = fs.readdirSync(reportDir)
    .filter(name => /^smart-wallet-priority-.*\.json$/.test(name))
    .map(name => path.join(reportDir, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function sanitizeLabel(raw) {
  return String(raw || '')
    .trim()
    .replace(/[^\w\s.\-]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function rowAddress(row) {
  return String(row.wallet_address || row.address || '').trim();
}

function rowScore(row) {
  return Number(row.priority_score ?? row.score ?? 0);
}

function rowTier(row) {
  return String(row.tier || '').trim();
}

function truthy(value) {
  return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
}

function rowIsStale(row) {
  return rowTier(row).toLowerCase() === 'stale' || truthy(row.stale_candidate);
}

function rowLabel(row) {
  const address = rowAddress(row);
  const raw = row.label || row.wallet_label || row.twitter_username || row.twitterName || row.twitter_name || address.slice(0, 8);
  return sanitizeLabel(raw) || address.slice(0, 8);
}

function hasImportCandidateField(row) {
  return Object.prototype.hasOwnProperty.call(row, 'import_candidate');
}

function chooseRows(rows, tiers, minScore, limit, includeBlocked) {
  let skippedStale = 0;
  let skippedBlocked = 0;
  let skippedOther = 0;
  const selected = rows
    .filter(row => {
      if (hasImportCandidateField(row)) {
        if (!includeBlocked && !truthy(row.import_candidate)) {
          if (truthy(row.import_blocked)) skippedBlocked++;
          else skippedOther++;
          return false;
        }
      } else {
        if (!includeBlocked && rowIsStale(row)) {
          skippedStale++;
          return false;
        }
      }
      const tier = rowTier(row);
      const score = rowScore(row);
      if (tiers.size && !tiers.has(tier)) return false;
      if (score < minScore) return false;
      return Boolean(rowAddress(row));
    })
    .sort((a, b) => rowScore(b) - rowScore(a))
    .slice(0, limit);
  return { selected, skippedStale, skippedBlocked, skippedOther };
}

function main() {
  const input = path.resolve(argValue('input', latestPriorityJson() || ''));
  const dbPath = path.resolve(argValue('charon-db', path.join(REPO_ROOT, 'charon.sqlite')));
  const tierArg = argValue('tiers', 'A,B');
  const tiers = new Set(tierArg ? tierArg.split(',').map(item => item.trim()).filter(Boolean) : []);
  const minScore = argNumber('min-score', 0);
  const limit = Math.floor(argNumber('limit', 1000));
  const commit = hasFlag('commit');
  const replaceExisting = hasFlag('replace-existing');
  const includeBlocked = hasFlag('include-blocked') || hasFlag('include-stale');

  if (!input || !fs.existsSync(input)) throw new Error(`Priority input not found: ${input}`);
  if (!fs.existsSync(dbPath)) throw new Error(`Charon DB not found: ${dbPath}`);

  const rows = readRows(input);
  const { selected, skippedStale, skippedBlocked, skippedOther } = chooseRows(rows, tiers, minScore, limit, includeBlocked);
  const db = new Database(dbPath);
  const existingByAddress = new Map(db.prepare('SELECT label, address FROM saved_wallets').all().map(row => [row.address, row.label]));
  const existingLabels = new Set(db.prepare('SELECT label FROM saved_wallets').all().map(row => row.label));

  const selectedTierCounts = selected.reduce((acc, row) => {
    const tier = rowTier(row) || 'none';
    acc[tier] = (acc[tier] || 0) + 1;
    return acc;
  }, {});

  const insert = db.prepare('INSERT OR IGNORE INTO saved_wallets (label, address, created_at_ms) VALUES (?, ?, ?)');
  const updateByAddress = db.prepare('UPDATE saved_wallets SET label = ? WHERE address = ?');

  let wouldInsert = 0;
  let inserted = 0;
  let skippedExisting = 0;
  let updatedExisting = 0;
  const labelCounts = new Map();

  function uniqueLabel(base, address) {
    let label = sanitizeLabel(base) || address.slice(0, 8);
    const baseLabel = label;
    let suffix = 2;
    while (existingLabels.has(label)) {
      if (existingByAddress.get(address) === label) return label;
      label = `${baseLabel}_${suffix++}`.slice(0, 64);
    }
    const seen = labelCounts.get(label) || 0;
    labelCounts.set(label, seen + 1);
    if (seen === 0) return label;
    return `${label}_${seen + 1}`.slice(0, 64);
  }

  const txn = db.transaction(() => {
    for (const row of selected) {
      const address = rowAddress(row);
      const exists = existingByAddress.has(address);
      const label = uniqueLabel(rowLabel(row), address);

      if (exists && !replaceExisting) {
        skippedExisting++;
        continue;
      }

      wouldInsert++;
      if (!commit) continue;

      if (exists && replaceExisting) {
        updateByAddress.run(label, address);
        updatedExisting++;
      } else {
        const result = insert.run(label, address, Date.now());
        if (result.changes) {
          inserted++;
          existingLabels.add(label);
        }
      }
    }
  });
  txn();

  db.close();

  console.log(`${commit ? 'Import' : 'Dry-run'} priority wallets from ${input}`);
  console.log(`Filter: tiers=${tierArg || 'any'} minScore=${minScore} limit=${limit} includeBlocked=${includeBlocked ? 'yes' : 'no'}`);
  console.log(`Selected ${selected.length} wallets ${JSON.stringify(selectedTierCounts)}`);
  console.log(`Skipped stale rows ${skippedStale}.`);
  console.log(`Skipped blocked rows: ${skippedBlocked}`);
  console.log(`Skipped other non-candidate rows: ${skippedOther}`);
  console.log(commit
    ? `Inserted ${inserted}, updated ${updatedExisting}, skipped existing ${skippedExisting}.`
    : `Would insert/update ${wouldInsert}, would skip existing ${skippedExisting}. Pass --commit to write.`);
}

main();
