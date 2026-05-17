#!/usr/bin/env node
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const DEFAULT_HOURS = 24;
const DEFAULT_DUST_RAW = 1000;

function usage() {
  return [
    'Usage: node scripts/reconcile_positions.js [options]',
    '',
    'Read-only live position reconciliation report.',
    '',
    'Options:',
    '  --help              Show this help text',
    '  --hours=N           Closed-position lookback window in hours (default: 24)',
    '  --all-open          Include all non-closed live positions regardless of age',
    '  --charon-db=PATH    Charon SQLite DB path (default: CHARON_DB_PATH or ./charon.sqlite)',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    hours: DEFAULT_HOURS,
    allOpen: false,
    charonDb: process.env.CHARON_DB_PATH || './charon.sqlite',
    help: false,
  };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--all-open') opts.allOpen = true;
    else if (arg.startsWith('--hours=')) {
      const hours = Number(arg.slice('--hours='.length));
      if (!Number.isFinite(hours) || hours <= 0) throw new Error('--hours must be a positive number');
      opts.hours = hours;
    } else if (arg.startsWith('--charon-db=')) {
      opts.charonDb = arg.slice('--charon-db='.length);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function loadDustThreshold(db) {
  const value = Number(db.prepare('SELECT value FROM settings WHERE key = ?').get('live_sell_dust_threshold_raw')?.value);
  return Number.isFinite(value) ? value : DEFAULT_DUST_RAW;
}

function loadPositions(db, { hours, allOpen }) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const openClause = allOpen ? "status != 'closed'" : "status != 'closed'";
  const sql = `
    SELECT id, mint, symbol, status, opened_at_ms, closed_at_ms, token_amount_raw, exit_signature
    FROM dry_run_positions
    WHERE execution_mode = 'live'
      AND (
        closed_at_ms > ?
        OR ${openClause}
      )
    ORDER BY COALESCE(closed_at_ms, opened_at_ms) DESC, id DESC
  `;
  return db.prepare(sql).all(cutoff);
}

function classify(position, walletBalance, dustThresholdRaw) {
  if (walletBalance == null) return 'unknown';
  const balance = Number(walletBalance);
  if (!Number.isFinite(balance)) return 'unknown';
  const hasBalance = balance > dustThresholdRaw;
  if (position.status === 'closed') return hasBalance ? 'residual' : 'matched';
  return hasBalance ? 'open_holding' : 'missing_balance';
}

function printTable(rows) {
  const headers = ['id', 'mint', 'symbol', 'status', 'token_amount_raw', 'wallet_balance', 'exit_sig', 'recon_state'];
  const widths = Object.fromEntries(headers.map(header => [header, header.length]));
  for (const row of rows) {
    for (const header of headers) {
      widths[header] = Math.max(widths[header], String(row[header] ?? '').length);
    }
  }
  const line = headers.map(header => String(header).padEnd(widths[header])).join(' | ');
  const sep = headers.map(header => '-'.repeat(widths[header])).join('-|-');
  console.log(line);
  console.log(sep);
  for (const row of rows) {
    console.log(headers.map(header => String(row[header] ?? '').padEnd(widths[header])).join(' | '));
  }
}

function shortSig(value) {
  const raw = String(value || '');
  return raw.length > 12 ? `${raw.slice(0, 6)}...${raw.slice(-4)}` : raw;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(usage());
    return 0;
  }
  if (!existsSync(opts.charonDb)) throw new Error(`DB not found: ${opts.charonDb}`);

  const db = new Database(opts.charonDb, { readonly: true, fileMustExist: true });
  try {
    const positions = loadPositions(db, opts);
    const dustThresholdRaw = loadDustThreshold(db);
    const { initLiveExecution, fetchLiveTokenBalance } = await import('../src/liveExecutor.js');
    initLiveExecution();

    const rows = [];
    for (const position of positions) {
      const walletBalance = await fetchLiveTokenBalance(position.mint);
      const reconState = classify(position, walletBalance, dustThresholdRaw);
      rows.push({
        id: position.id,
        mint: position.mint,
        symbol: position.symbol || '',
        status: position.status,
        token_amount_raw: position.token_amount_raw || '',
        wallet_balance: walletBalance ?? 'unknown',
        exit_sig: shortSig(position.exit_signature),
        recon_state: reconState,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    if (!rows.length) {
      console.log('No live positions found for the selected window.');
      return 0;
    }
    printTable(rows);
    return rows.some(row => row.recon_state === 'residual' || row.recon_state === 'missing_balance') ? 1 : 0;
  } finally {
    db.close();
  }
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
