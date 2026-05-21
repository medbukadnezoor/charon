import { isPublicWalletAddress } from './walletPredictiveness.js';

const RUNNER_THRESHOLDS = [2, 3, 5];

const TABLE_NAME_HINTS = [
  'trades',
  'swaps',
  'wallet_trades',
  'wallet_swaps',
  'token_trades',
  'token_swaps',
  'harvester_trades',
  'harvester_swaps',
  'transactions',
  'swap_history',
  'trade_history',
];

const MINT_COLUMNS = [
  'mint',
  'token_mint',
  'base_mint',
  'mint_address',
  'token_address',
  'contract_address',
  'ca',
];

const WALLET_COLUMNS = [
  'wallet',
  'wallet_address',
  'owner',
  'owner_address',
  'trader',
  'trader_address',
  'user',
  'user_address',
  'account',
  'account_address',
  'signer',
  'signer_address',
  'maker',
  'maker_address',
  'address',
];

const TIMESTAMP_COLUMNS = [
  'swapped_at_ms',
  'traded_at_ms',
  'block_time_ms',
  'timestamp_ms',
  'created_at_ms',
  'updated_at_ms',
  'at_ms',
  'swapped_at',
  'traded_at',
  'block_time',
  'timestamp',
  'created_at',
  'updated_at',
  'at',
];

const SIDE_COLUMNS = [
  'side',
  'action',
  'type',
  'trade_type',
  'swap_type',
  'transaction_type',
  'event_type',
  'direction',
];

function percent(part, total) {
  return total ? part / total : null;
}

function finiteNumber(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeScalar(value) {
  return String(value || '').trim();
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function firstMatchingColumn(columns, candidates, excluded = new Set()) {
  const exact = new Map(columns.map(column => [String(column).toLowerCase(), column]));
  for (const candidate of candidates) {
    const match = exact.get(candidate.toLowerCase());
    if (match && !excluded.has(match)) return match;
  }
  return null;
}

function listTables(db) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(row => row.name);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all().map(row => row.name);
}

function parseTimestampMs(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  const numeric = finiteNumber(value);
  if (numeric != null) {
    if (numeric > 1_000_000_000_000) return Math.trunc(numeric);
    if (numeric > 1_000_000_000) return Math.trunc(numeric * 1000);
    return Math.trunc(numeric);
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function classifySide(value) {
  const raw = normalizeScalar(value).toLowerCase();
  if (!raw) return 'unknown';
  if (/\b(buy|bought|purchase|entry)\b/.test(raw) || raw === 'in' || raw === 'swap_in') return 'buy';
  if (/\b(sell|sold|exit)\b/.test(raw) || raw === 'out' || raw === 'swap_out') return 'sell';
  return 'unknown';
}

function scoreTradeTable(tableName, columns) {
  const mintColumn = firstMatchingColumn(columns, MINT_COLUMNS);
  if (!mintColumn) return null;
  const walletColumn = firstMatchingColumn(columns, WALLET_COLUMNS, new Set([mintColumn]));
  if (!walletColumn) return null;
  const timestampColumn = firstMatchingColumn(columns, TIMESTAMP_COLUMNS);
  if (!timestampColumn) return null;
  const sideColumn = firstMatchingColumn(columns, SIDE_COLUMNS);

  const normalizedName = String(tableName).toLowerCase();
  let score = 3;
  if (normalizedName === 'trades' || normalizedName === 'swaps') score += 100;
  else if (normalizedName.includes('trade') || normalizedName.includes('swap')) score += 60;
  else if (TABLE_NAME_HINTS.includes(normalizedName)) score += 20;
  if (sideColumn) score += 5;

  return {
    table: tableName,
    mint_column: mintColumn,
    wallet_column: walletColumn,
    timestamp_column: timestampColumn,
    side_column: sideColumn,
    score,
  };
}

export function detectHarvesterTradeSchema(db) {
  const candidates = [];
  for (const table of listTables(db)) {
    const columns = tableColumns(db, table);
    const candidate = scoreTradeTable(table, columns);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => b.score - a.score || String(a.table).localeCompare(String(b.table)));
  return candidates[0] || null;
}

function candidatePairs(outcomes) {
  const byKey = new Map();
  for (const outcome of outcomes || []) {
    const mint = normalizeScalar(outcome?.mint);
    if (!mint) continue;
    const addresses = Array.isArray(outcome?.candidate_wallet_addresses)
      ? outcome.candidate_wallet_addresses
      : [];
    for (const value of addresses) {
      const wallet = normalizeScalar(value);
      if (!isPublicWalletAddress(wallet)) continue;
      const key = `${mint}\n${wallet}`;
      if (byKey.has(key)) continue;
      byKey.set(key, {
        mint,
        wallet_address: wallet,
        symbol: outcome?.symbol || null,
        multiple: finiteNumber(outcome?.multiple),
        runner_label: outcome?.runner_label || null,
        first_seen_at_ms: finiteNumber(outcome?.first_seen_at_ms),
      });
    }
  }
  return [...byKey.values()].sort((a, b) => (
    String(a.mint).localeCompare(String(b.mint))
    || String(a.wallet_address).localeCompare(String(b.wallet_address))
  ));
}

function fetchTradesByPair(db, schema, pairs) {
  const byKey = new Map(pairs.map(pair => [`${pair.mint}\n${pair.wallet_address}`, []]));
  if (!pairs.length) return byKey;

  const table = quoteIdentifier(schema.table);
  const mintColumn = quoteIdentifier(schema.mint_column);
  const walletColumn = quoteIdentifier(schema.wallet_column);
  const timestampColumn = quoteIdentifier(schema.timestamp_column);
  const sideExpr = schema.side_column ? quoteIdentifier(schema.side_column) : 'NULL';
  const stmt = db.prepare(`
    SELECT ${mintColumn} AS mint, ${walletColumn} AS wallet_address, ${timestampColumn} AS traded_at_raw, ${sideExpr} AS side_raw
    FROM ${table}
    WHERE ${mintColumn} = ?
      AND ${walletColumn} = ?
    ORDER BY ${timestampColumn}
  `);

  for (const pair of pairs) {
    const key = `${pair.mint}\n${pair.wallet_address}`;
    const rows = stmt.all(pair.mint, pair.wallet_address)
      .map(row => ({
        mint: normalizeScalar(row.mint),
        wallet_address: normalizeScalar(row.wallet_address),
        traded_at_ms: parseTimestampMs(row.traded_at_raw),
        side_raw: row.side_raw == null ? null : String(row.side_raw),
        side_class: schema.side_column ? classifySide(row.side_raw) : 'unknown',
      }))
      .filter(row => row.mint === pair.mint && row.wallet_address === pair.wallet_address);
    byKey.set(key, rows);
  }

  return byKey;
}

function classifyPair(pair, trades, hasSideColumn) {
  const timestamped = trades.filter(row => Number.isFinite(row.traded_at_ms));
  if (!timestamped.length) {
    return {
      timing_bucket: 'no_matched_trade',
      matched_trade_count: trades.length,
      buy_trade_count: 0,
      unknown_side_trade_count: 0,
      first_trade_at_ms: null,
      first_buy_at_ms: null,
      first_unknown_side_trade_at_ms: null,
      first_trade_side: null,
      first_trade_side_raw: null,
    };
  }

  const firstTrade = timestamped.slice().sort((a, b) => a.traded_at_ms - b.traded_at_ms)[0];
  const buys = hasSideColumn
    ? timestamped.filter(row => row.side_class === 'buy')
    : [];
  const unknownSide = timestamped.filter(row => row.side_class === 'unknown');
  const firstBuy = buys.slice().sort((a, b) => a.traded_at_ms - b.traded_at_ms)[0] || null;
  const firstUnknown = unknownSide.slice().sort((a, b) => a.traded_at_ms - b.traded_at_ms)[0] || null;
  const firstSeen = finiteNumber(pair.first_seen_at_ms);

  let timingBucket = 'no_buy_trade';
  if (firstBuy) {
    if (!Number.isFinite(firstSeen)) timingBucket = 'buy_timing_uncomputable';
    else timingBucket = firstBuy.traded_at_ms < firstSeen ? 'bought_before_shadow' : 'bought_after_shadow';
  } else if (firstUnknown) {
    if (!Number.isFinite(firstSeen)) timingBucket = 'trade_unknown_side_timing_uncomputable';
    else timingBucket = firstUnknown.traded_at_ms < firstSeen ? 'trade_unknown_side_before_shadow' : 'trade_unknown_side_after_shadow';
  }

  return {
    timing_bucket: timingBucket,
    matched_trade_count: trades.length,
    buy_trade_count: buys.length,
    unknown_side_trade_count: unknownSide.length,
    first_trade_at_ms: firstTrade.traded_at_ms,
    first_buy_at_ms: firstBuy?.traded_at_ms ?? null,
    first_unknown_side_trade_at_ms: firstUnknown?.traded_at_ms ?? null,
    first_trade_side: firstTrade.side_class,
    first_trade_side_raw: firstTrade.side_raw,
  };
}

function bucketCount(rows, bucket) {
  return rows.filter(row => row.timing_bucket === bucket).length;
}

function timingSummary(rows) {
  const unknownSide = rows.filter(row => String(row.timing_bucket || '').startsWith('trade_unknown_side'));
  return {
    total_pairs: rows.length,
    bought_before_shadow: bucketCount(rows, 'bought_before_shadow'),
    bought_after_shadow: bucketCount(rows, 'bought_after_shadow'),
    buy_timing_uncomputable: bucketCount(rows, 'buy_timing_uncomputable'),
    unknown_side_pairs: unknownSide.length,
    trade_unknown_side_before_shadow: bucketCount(rows, 'trade_unknown_side_before_shadow'),
    trade_unknown_side_after_shadow: bucketCount(rows, 'trade_unknown_side_after_shadow'),
    trade_unknown_side_timing_uncomputable: bucketCount(rows, 'trade_unknown_side_timing_uncomputable'),
    no_matched_trade: bucketCount(rows, 'no_matched_trade'),
    no_buy_trade: bucketCount(rows, 'no_buy_trade'),
  };
}

function thresholdSummary(rows, threshold) {
  const scoped = rows.filter(row => Number(row.multiple || 0) >= threshold);
  return {
    threshold,
    ...timingSummary(scoped),
  };
}

function unsupportedSummary(outcomes, status, reason) {
  const pairs = candidatePairs(outcomes);
  return {
    status,
    reason,
    total_outcomes: outcomes.length,
    total_candidate_pairs: pairs.length,
    distinct_mints_with_candidate_pairs: new Set(pairs.map(row => row.mint)).size,
    timing: timingSummary([]),
    timing_by_threshold: RUNNER_THRESHOLDS.map(threshold => ({
      threshold,
      ...timingSummary([]),
    })),
    pair_rows: [],
    limitations: [
      'This probe only uses already-populated harvester trade history and never backfills on-chain data.',
      'No matching harvester trade row does not prove the wallet did not buy; it only means no usable matching row exists in this local DB.',
    ],
  };
}

export function skippedHarvesterTradeTiming(reason = 'no --harvester-db path provided') {
  return unsupportedSummary([], 'skipped', reason);
}

export function analyzeHarvesterTradeTiming(outcomes, db) {
  const schema = detectHarvesterTradeSchema(db);
  if (!schema) {
    return unsupportedSummary(
      outcomes,
      'unsupported_schema',
      'No supported harvester trade/swap table with recognizable mint, wallet, and timestamp columns was found.',
    );
  }

  const totalTradeRows = db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(schema.table)}`).get().count;
  if (!Number(totalTradeRows)) {
    return {
      ...unsupportedSummary(outcomes, 'no_trade_history', `Supported trade table \`${schema.table}\` exists but contains no rows.`),
      schema,
      total_trade_rows: 0,
    };
  }

  const pairs = candidatePairs(outcomes);
  const tradesByPair = fetchTradesByPair(db, schema, pairs);
  const pairRows = pairs.map(pair => {
    const key = `${pair.mint}\n${pair.wallet_address}`;
    const timing = classifyPair(pair, tradesByPair.get(key) || [], Boolean(schema.side_column));
    return {
      ...pair,
      ...timing,
    };
  });

  return {
    status: 'ok',
    schema,
    total_trade_rows: Number(totalTradeRows),
    total_outcomes: outcomes.length,
    total_candidate_pairs: pairs.length,
    distinct_mints_with_candidate_pairs: new Set(pairs.map(row => row.mint)).size,
    timing: timingSummary(pairRows),
    timing_by_threshold: RUNNER_THRESHOLDS.map(threshold => thresholdSummary(pairRows, threshold)),
    pair_rows: pairRows,
    limitations: [
      'This probe only uses already-populated harvester trade history and never backfills on-chain data.',
      'No matching harvester trade row does not prove the wallet did not buy; it only means no usable matching row exists in this local DB.',
      'When the detected trade table lacks a side/action column, matching rows are reported as unknown-side timing evidence, not buy proof.',
    ],
  };
}
