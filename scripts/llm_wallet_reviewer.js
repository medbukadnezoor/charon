/**
 * Review Charon saved wallets with a secret-safe LLM batch prompt.
 *
 * Dry-run JSON mode prints only the request body and batch metadata. Live mode
 * requires LLM_API_KEY or XIAOMIMIMO_API_KEY to already exist in the process
 * environment and stores normalized review rows in Charon's wallet_llm_reviews
 * table.
 *
 * Usage:
 *   node scripts/llm_wallet_reviewer.js --dry-run-json --limit=3 --batch-size=3
 *   HARVESTER_DB_PATH=/opt/trading-data/harvester.db node scripts/llm_wallet_reviewer.js --dry-run-json
 *   node scripts/llm_wallet_reviewer.js --harvester-db=/path/to/harvester.db --dry-run-json
 *   node scripts/llm_wallet_reviewer.js --dry-run-json --loop --cycles=1 --wallets-per-cycle=15
 *   XIAOMIMIMO_API_KEY=... node scripts/llm_wallet_reviewer.js --limit=15
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Local dev default; override with HARVESTER_DB_PATH or --harvester-db for VPS/CI layouts.
const DEFAULT_HARVESTER_DB = path.join(REPO_ROOT, 'tools/wallet-harvester/data/harvester.db');
const DEFAULT_CHARON_DB = path.join(REPO_ROOT, 'charon.sqlite');
const DEFAULT_LLM_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';
const DEFAULT_LLM_MODEL = 'mimo-v2.5-pro';
const DEFAULT_ARTIFACT_DIR = path.join(REPO_ROOT, 'reports/wallet-llm-reviews');
const DEFAULT_LIMIT = 15;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_TARGET_MCAP = 200_000;
const RECENT_SIGHTING_LIMIT = 8;
const RETRY_DELAY_MS = 5_000;

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const parsed = Number(argValue(name, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function argCsv(name) {
  return argValue(name, '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function argOptionalNumber(name) {
  const raw = argValue(name, '');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function parseJsonValue(raw, fallback = null) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : null;
}

function ageDays(ms) {
  const n = finiteNumber(ms);
  return n ? Math.round(Math.max(0, (Date.now() - n) / 86_400_000) * 10) / 10 : null;
}

function finiteNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function artifactNamePart(value) {
  return String(value || new Date().toISOString())
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function countBy(rows, field) {
  return rows.reduce((acc, row) => {
    const key = row[field] || 'blank';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function writeReviewArtifacts(artifactDir, artifact) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const name = artifactNamePart(artifact.batch_id || artifact.generated_at);
  const jsonPath = path.join(artifactDir, `${name}.json`);
  const csvPath = path.join(artifactDir, `${name}.csv`);
  const header = [
    'batch_id',
    'wallet_address',
    'llm_verdict',
    'llm_confidence',
    'recommended_action',
    'llm_reasoning',
    'reviewed_at_iso',
    'llm_model',
    'base_url',
  ];
  const lines = [
    header.join(','),
    ...artifact.rows.map(row => [
      row.batch_id,
      row.wallet_address,
      row.llm_verdict,
      row.llm_confidence,
      row.recommended_action,
      row.llm_reasoning,
      row.reviewed_at_iso,
      artifact.model,
      artifact.base_url,
    ].map(csvCell).join(',')),
  ];

  fs.writeFileSync(jsonPath, JSON.stringify(artifact, null, 2));
  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`);
  return { jsonPath, csvPath };
}

function normalizeEnum(value, allowed, fallback) {
  const text = String(value ?? '').trim().toLowerCase();
  return allowed.includes(text) ? text : fallback;
}

function hasTable(db, tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return Boolean(row);
}

function createReviewTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wallet_llm_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet_address TEXT NOT NULL,
      reviewed_at_ms INTEGER NOT NULL,
      llm_verdict TEXT NOT NULL,
      llm_confidence INTEGER NOT NULL,
      llm_reasoning TEXT NOT NULL,
      recommended_action TEXT NOT NULL DEFAULT 'keep',
      llm_model TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wlr_address ON wallet_llm_reviews(wallet_address);
    CREATE INDEX IF NOT EXISTS idx_wlr_reviewed ON wallet_llm_reviews(reviewed_at_ms);
  `);
  const columns = db.prepare('PRAGMA table_info(wallet_llm_reviews)').all();
  if (!columns.some(column => column.name === 'recommended_action')) {
    db.exec("ALTER TABLE wallet_llm_reviews ADD COLUMN recommended_action TEXT NOT NULL DEFAULT 'keep'");
  }
}

function selectSavedWallets(charonDb, limit, requestedAddresses = []) {
  if (requestedAddresses.length) {
    if (!hasTable(charonDb, 'wallet_llm_reviews')) {
      return charonDb.prepare(`
        SELECT
          sw.address,
          sw.label,
          sw.created_at_ms,
          NULL AS last_reviewed_at_ms
        FROM saved_wallets sw
        WHERE sw.address IN (${placeholders(requestedAddresses.length)})
        ORDER BY sw.created_at_ms ASC
      `).all(...requestedAddresses);
    }

    return charonDb.prepare(`
      SELECT
        sw.address,
        sw.label,
        sw.created_at_ms,
        MAX(wlr.reviewed_at_ms) AS last_reviewed_at_ms
      FROM saved_wallets sw
      LEFT JOIN wallet_llm_reviews wlr ON wlr.wallet_address = sw.address
      WHERE sw.address IN (${placeholders(requestedAddresses.length)})
      GROUP BY sw.address
      ORDER BY sw.created_at_ms ASC
    `).all(...requestedAddresses);
  }

  if (!hasTable(charonDb, 'wallet_llm_reviews')) {
    return charonDb.prepare(`
      SELECT
        sw.address,
        sw.label,
        sw.created_at_ms,
        NULL AS last_reviewed_at_ms
      FROM saved_wallets sw
      ORDER BY sw.created_at_ms ASC
      LIMIT ?
    `).all(limit);
  }

  return charonDb.prepare(`
    SELECT
      sw.address,
      sw.label,
      sw.created_at_ms,
      MAX(wlr.reviewed_at_ms) AS last_reviewed_at_ms
    FROM saved_wallets sw
    LEFT JOIN wallet_llm_reviews wlr ON wlr.wallet_address = sw.address
    GROUP BY sw.address
    ORDER BY
      CASE WHEN MAX(wlr.reviewed_at_ms) IS NULL THEN 0 ELSE 1 END,
      MAX(wlr.reviewed_at_ms) ASC,
      sw.created_at_ms ASC
    LIMIT ?
  `).all(limit);
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function fetchHarvesterAggregates(harvesterDb, addresses, targetMcap) {
  if (!addresses.length) return new Map();
  const params = [
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    targetMcap,
    ...addresses,
  ];
  const rows = harvesterDb.prepare(`
    SELECT
      w.address,
      w.sources,
      w.tags,
      w.wallet_label,
      w.twitter_username,
      w.twitter_name,
      w.provider_tags,
      w.token_tags,
      w.token_count,
      w.pnl_usd,
      w.win_rate,
      w.avg_buy_usd,
      w.pnl_snapshot_at,
      w.first_seen,
      w.last_seen,
      COUNT(s.id) AS total_sightings,
      COUNT(DISTINCT s.mint) AS total_tokens_seen,
      SUM(CASE WHEN s.signal_type LIKE '%\\_holder' ESCAPE '\\' THEN 1 ELSE 0 END) AS total_holder_sightings,
      SUM(CASE WHEN s.signal_type LIKE '%\\_trader' ESCAPE '\\' THEN 1 ELSE 0 END) AS total_trader_sightings,
      SUM(CASE WHEN s.action = 'buy' THEN 1 ELSE 0 END) AS total_buy_sightings,
      SUM(CASE WHEN s.action = 'sell' THEN 1 ELSE 0 END) AS total_sell_sightings,
      SUM(CASE WHEN s.action = 'hold' THEN 1 ELSE 0 END) AS total_hold_sightings,
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN 1 ELSE 0 END) AS target_sightings,
      COUNT(DISTINCT CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.mint END) AS target_tokens,
      MAX(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.timestamp ELSE NULL END) AS last_target_seen,
      AVG(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.token_mcap_usd ELSE NULL END) AS avg_target_mcap,
      AVG(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.amount_usd ELSE NULL END) AS avg_target_amount_usd,
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? AND s.signal_type LIKE '%\\_holder' ESCAPE '\\' THEN 1 ELSE 0 END) AS target_holder_sightings,
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? AND s.signal_type LIKE '%\\_trader' ESCAPE '\\' THEN 1 ELSE 0 END) AS target_trader_sightings,
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? AND s.action = 'buy' THEN 1 ELSE 0 END) AS target_buy_sightings,
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? AND s.action = 'sell' THEN 1 ELSE 0 END) AS target_sell_sightings,
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? AND s.action = 'hold' THEN 1 ELSE 0 END) AS target_hold_sightings
    FROM wallets w
    LEFT JOIN sightings s ON s.wallet_address = w.address
    WHERE w.address IN (${placeholders(addresses.length)})
    GROUP BY w.address
  `).all(...params);
  return new Map(rows.map(row => [row.address, row]));
}

function fetchRecentSightings(harvesterDb, addresses) {
  if (!addresses.length) return new Map();
  const rows = harvesterDb.prepare(`
    SELECT wallet_address, mint, action, amount_usd, token_mcap_usd, timestamp, source, signal_type
    FROM (
      SELECT
        s.*,
        ROW_NUMBER() OVER (PARTITION BY s.wallet_address ORDER BY s.timestamp DESC, s.id DESC) AS rn
      FROM sightings s
      WHERE s.wallet_address IN (${placeholders(addresses.length)})
    )
    WHERE rn <= ?
    ORDER BY wallet_address, timestamp DESC
  `).all(...addresses, RECENT_SIGHTING_LIMIT);
  const byAddress = new Map();
  for (const row of rows) {
    if (!byAddress.has(row.wallet_address)) byAddress.set(row.wallet_address, []);
    const signalType = row.signal_type || '';
    const amount = finiteNumber(row.amount_usd);
    const amountUnavailable = (amount === null || amount === 0) && signalType.includes('_holder');
    byAddress.get(row.wallet_address).push({
      mint: row.mint,
      action: row.action,
      amount_usd: amountUnavailable ? null : amount,
      amount_usd_unavailable: amountUnavailable,
      token_mcap_usd: finiteNumber(row.token_mcap_usd),
      seen_at_ms: finiteNumber(row.timestamp),
      seen_at_iso: iso(row.timestamp),
      source: row.source,
      signal_type: row.signal_type,
    });
  }
  return byAddress;
}

function fetchWalletProfiles(harvesterDb, addresses) {
  if (!addresses.length || !hasTable(harvesterDb, 'wallet_profiles')) return new Map();
  const rows = harvesterDb.prepare(`
    SELECT *
    FROM wallet_profiles
    WHERE address IN (${placeholders(addresses.length)})
  `).all(...addresses);
  return new Map(rows.map(row => [row.address, row]));
}

function fetchOwnerLabels(harvesterDb, addresses) {
  if (!addresses.length || !hasTable(harvesterDb, 'owner_labels')) return new Map();
  const rows = harvesterDb.prepare(`
    SELECT address, manual_label, manual_notes, labeled_at_ms
    FROM owner_labels
    WHERE address IN (${placeholders(addresses.length)})
  `).all(...addresses);
  return new Map(rows.map(row => [row.address, row]));
}

function buildWalletAnalytics(profile, tags, providerTags, aggregate) {
  const gmgnAvailable = Boolean(profile?.gmgn_snapshot_at);
  const okxAvailable = Boolean(profile?.okx_snapshot_at);
  const gmgnTags = parseJsonArray(profile?.gmgn_tags);
  const allTags = [...tags, ...providerTags, ...gmgnTags].map(item => item.toLowerCase());
  const kolLike = allTags.some(tag => ['kol', 'renowned', 'influencer', 'caller', 'alpha'].some(marker => tag.includes(marker))) ||
    Boolean((profile?.gmgn_twitter_username || aggregate?.twitter_username) && (aggregate?.wallet_label || profile?.gmgn_twitter_name));
  return {
    gmgn: {
      available: gmgnAvailable,
      snapshot_age_days: ageDays(profile?.gmgn_snapshot_at),
      period: profile?.gmgn_period || null,
      realized_profit_usd: finiteNumber(profile?.gmgn_realized_profit_usd),
      unrealized_profit_usd: finiteNumber(profile?.gmgn_unrealized_profit_usd),
      pnl_ratio: finiteNumber(profile?.gmgn_pnl_ratio),
      winrate: finiteNumber(profile?.gmgn_winrate),
      total_cost_usd: finiteNumber(profile?.gmgn_total_cost_usd),
      buy_count: finiteNumber(profile?.gmgn_buy_count),
      sell_count: finiteNumber(profile?.gmgn_sell_count),
      tags: gmgnTags,
      twitter_username: profile?.gmgn_twitter_username || null,
      twitter_name: profile?.gmgn_twitter_name || null,
      followers_count: finiteNumber(profile?.gmgn_followers_count),
      is_blue_verified: profile?.gmgn_is_blue_verified == null ? null : Boolean(profile.gmgn_is_blue_verified),
      created_token_count: finiteNumber(profile?.gmgn_created_token_count),
      wallet_created_at_ms: finiteNumber(profile?.gmgn_wallet_created_at),
    },
    okx: {
      available: okxAvailable,
      snapshot_age_days: ageDays(profile?.okx_snapshot_at),
      realized_pnl_usd: finiteNumber(profile?.okx_realized_pnl_usd),
      win_rate: finiteNumber(profile?.okx_win_rate),
      buy_tx_count: finiteNumber(profile?.okx_buy_tx_count),
      sell_tx_count: finiteNumber(profile?.okx_sell_tx_count),
      buy_tx_volume_usd: finiteNumber(profile?.okx_buy_tx_volume_usd),
      sell_tx_volume_usd: finiteNumber(profile?.okx_sell_tx_volume_usd),
      avg_buy_value_usd: finiteNumber(profile?.okx_avg_buy_value_usd),
      preferred_mcap: profile?.okx_preferred_mcap || null,
      buys_by_mcap: parseJsonValue(profile?.okx_buys_by_mcap_json, []),
      token_count_by_pnl: parseJsonValue(profile?.okx_token_count_by_pnl_json, null),
    },
    kol_like: kolLike,
  };
}

function buildOwnerLabel(label) {
  return {
    manual_label: label?.manual_label || null,
    manual_notes: label?.manual_notes || null,
    labeled_at_ms: finiteNumber(label?.labeled_at_ms),
    labeled_at_iso: iso(label?.labeled_at_ms),
  };
}

function buildWalletContext(saved, aggregate, recentSightings, targetMcap, profile = null, ownerLabel = null) {
  const totalSightings = finiteNumber(aggregate?.total_sightings, 0);
  const targetSightings = finiteNumber(aggregate?.target_sightings, 0);
  const targetShare = totalSightings > 0 ? targetSightings / totalSightings : 0;
  const lastSeen = finiteNumber(aggregate?.last_seen);
  const daysSinceLastSeen = lastSeen
    ? Math.round(Math.max(0, (Date.now() - lastSeen) / 86_400_000) * 10) / 10
    : null;
  const holderSightings = recentSightings.filter(row => String(row.signal_type || '').includes('_holder')).length;
  const traderSightings = recentSightings.filter(row => String(row.signal_type || '').includes('_trader')).length;
  const unavailableAmountSightings = recentSightings.filter(row => row.amount_usd_unavailable).length;
  const totalTraderSightings = finiteNumber(aggregate?.total_trader_sightings, 0);
  const totalHolderSightings = finiteNumber(aggregate?.total_holder_sightings, 0);
  const targetTraderSightings = finiteNumber(aggregate?.target_trader_sightings, 0);
  const targetHolderSightings = finiteNumber(aggregate?.target_holder_sightings, 0);
  const tags = parseJsonArray(aggregate?.tags);
  const providerTags = parseJsonArray(aggregate?.provider_tags);
  const tokenTags = parseJsonArray(aggregate?.token_tags);
  const walletAnalytics = buildWalletAnalytics(profile, tags, providerTags, aggregate);
  const isKolLike = walletAnalytics.kol_like;
  const pnlUsd = finiteNumber(aggregate?.pnl_usd);
  const freshGmgnAnalytics = walletAnalytics.gmgn.available &&
    walletAnalytics.gmgn.snapshot_age_days != null &&
    walletAnalytics.gmgn.snapshot_age_days <= 3;
  const contextLimitations = [
    holderSightings > 0 && traderSightings === 0 && totalTraderSightings > 0
      ? 'recent sightings are holder-only, but older trader sightings exist in aggregate stats'
      : null,
    totalHolderSightings > 0 && totalTraderSightings === 0
      ? 'all stored sightings come from holder endpoints, not full wallet trade history'
      : null,
    unavailableAmountSightings > 0
      ? 'amount_usd was unavailable on holder sightings and must not be interpreted as zero trade size'
      : null,
    totalSightings < 3
      ? 'harvester has sparse sightings for this wallet'
      : null,
    !walletAnalytics.gmgn.available && !walletAnalytics.okx.available
      ? 'wallet-level analytics are not available yet'
      : null,
    walletAnalytics.gmgn.available && walletAnalytics.gmgn.snapshot_age_days > 7
      ? 'GMGN wallet-level analytics are stale'
      : null,
  ].filter(Boolean);

  return {
    address: saved.address,
    label: saved.label || aggregate?.wallet_label || null,
    harvester_label: aggregate?.wallet_label || null,
    twitter_username: aggregate?.twitter_username || null,
    twitter_name: aggregate?.twitter_name || null,
    sources: parseJsonArray(aggregate?.sources),
    tags,
    provider_tags: providerTags,
    token_tags: tokenTags,
    profile_flags: {
      kol_like: isKolLike,
      negative_pnl: pnlUsd !== null ? pnlUsd < 0 : null,
    },
    wallet_analytics: walletAnalytics,
    owner_label: buildOwnerLabel(ownerLabel),
    target: {
      max_mcap_usd: targetMcap,
      target_sightings: targetSightings,
      target_tokens: finiteNumber(aggregate?.target_tokens, 0),
      target_share: Math.round(targetShare * 1000) / 1000,
      last_target_seen_ms: finiteNumber(aggregate?.last_target_seen),
      last_target_seen_iso: iso(aggregate?.last_target_seen),
      avg_target_mcap: finiteNumber(aggregate?.avg_target_mcap),
      avg_target_amount_usd: finiteNumber(aggregate?.avg_target_amount_usd),
      holder_sightings: targetHolderSightings,
      trader_sightings: targetTraderSightings,
      buy_sightings: finiteNumber(aggregate?.target_buy_sightings, 0),
      sell_sightings: finiteNumber(aggregate?.target_sell_sightings, 0),
      hold_sightings: finiteNumber(aggregate?.target_hold_sightings, 0),
    },
    stats: {
      total_sightings: totalSightings,
      total_tokens_seen: finiteNumber(aggregate?.total_tokens_seen, 0),
      token_count: finiteNumber(aggregate?.token_count, 0),
      holder_sightings: totalHolderSightings,
      trader_sightings: totalTraderSightings,
      buy_sightings: finiteNumber(aggregate?.total_buy_sightings, 0),
      sell_sightings: finiteNumber(aggregate?.total_sell_sightings, 0),
      hold_sightings: finiteNumber(aggregate?.total_hold_sightings, 0),
      first_seen_ms: finiteNumber(aggregate?.first_seen),
      first_seen_iso: iso(aggregate?.first_seen),
      last_seen_ms: lastSeen,
      last_seen_iso: iso(lastSeen),
      days_since_last_seen: daysSinceLastSeen,
      pnl_usd: pnlUsd,
      win_rate: finiteNumber(aggregate?.win_rate),
      avg_buy_usd: finiteNumber(aggregate?.avg_buy_usd),
      pnl_snapshot_at_ms: finiteNumber(aggregate?.pnl_snapshot_at),
      pnl_snapshot_at_iso: iso(aggregate?.pnl_snapshot_at),
    },
    data_quality: {
      harvester_context: freshGmgnAnalytics ? 'standard' : (contextLimitations.length ? 'sparse_or_partial' : 'standard'),
      holder_sightings: holderSightings,
      trader_sightings: traderSightings,
      amount_unavailable_sightings: unavailableAmountSightings,
      limitations: contextLimitations,
    },
    review_state: {
      last_reviewed_at_ms: finiteNumber(saved.last_reviewed_at_ms),
      last_reviewed_at_iso: iso(saved.last_reviewed_at_ms),
    },
    recent_sightings: recentSightings,
  };
}

function buildMessages(wallets, targetMcap) {
  return [
    {
      role: 'system',
      content: [
        'You are reviewing Solana Pump-token smart-wallet candidates for Charon.',
        'Evaluate whether each saved wallet looks like a genuine early micro-cap trader, bot/sniper, copy-trader, or inflated/noisy wallet.',
        `The target strategy prefers tokens with market cap at or below ${targetMcap} USD.`,
        'The harvester context may be sparse because it stores token-level sightings, not the full GMGN wallet analytics page.',
        'If amount_usd is null with amount_usd_unavailable=true, treat the amount as unavailable from the source endpoint, not as a zero-dollar trade.',
        'Use data_quality.limitations to separate weak wallet quality from weak source coverage; do not demote solely because holder endpoint amounts are unavailable.',
        'Use stats and target aggregate action counts before summarizing a wallet as holder-only; recent_sightings is only a recency sample.',
        'A KOL-like wallet with negative PnL and no stored trader actions is not a profitable smart wallet; treat it as noisy KOL/influencer flow and prefer demote or remove.',
        'When wallet_analytics.gmgn.available is true, use those metrics as primary evidence for wallet quality. Do not mark a wallet as insufficient_data when wallet-level analytics exist.',
        'When wallet_analytics.kol_like is true, classify the wallet as a KOL/influencer type. Assess whether the KOL is profitable or noisy based on PnL and win rate. Do not use generic insufficient_data.',
        'When wallet_analytics.okx.preferred_mcap is available, use it to assess whether the wallet buying behavior matches the target strategy under 100K or 100K-1M market cap.',
        'Return strict JSON only. No markdown, no prose outside JSON.',
        'The JSON must have a reviews array. Each review must contain wallet_address, llm_verdict, llm_confidence, llm_reasoning, recommended_action.',
        'llm_verdict must be one of genuine_smart_trader, bot_or_sniper, copy_trader, inflated_or_wash, insufficient_data.',
        'llm_confidence must be an integer from 0 to 100.',
        'recommended_action must be one of promote, keep, watch, demote, remove.',
        'Use recommended_action=watch when the wallet may be good but the local harvester context is too sparse or partial to classify confidently.',
        'llm_reasoning must be one concise sentence.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'Review wallet quality for Charon saved_wallets.',
        target_mcap_usd: targetMcap,
        wallets,
      }),
    },
  ];
}

function buildRequestBody(model, wallets, targetMcap) {
  return {
    model,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: buildMessages(wallets, targetMcap),
  };
}

function chunkRows(rows, size) {
  const chunks = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('LLM response content was empty');
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('LLM response did not contain JSON');
    return JSON.parse(match[0]);
  }
}

function extractReviewPayload(responseJson) {
  const content = responseJson?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return parseJsonObject(content);
  if (content && typeof content === 'object') return content;
  if (Array.isArray(responseJson?.reviews)) return responseJson;
  throw new Error('LLM response had no parseable review content');
}

function normalizeReview(raw, allowedAddresses) {
  const address = String(raw?.wallet_address || '').trim();
  if (!allowedAddresses.has(address)) return null;
  return {
    wallet_address: address,
    llm_verdict: normalizeEnum(raw?.llm_verdict, [
      'genuine_smart_trader',
      'bot_or_sniper',
      'copy_trader',
      'inflated_or_wash',
      'insufficient_data',
    ], 'insufficient_data'),
    llm_confidence: clampInteger(raw?.llm_confidence, 0, 100, 0),
    llm_reasoning: cleanText(raw?.llm_reasoning, 'No reasoning returned.'),
    recommended_action: normalizeEnum(raw?.recommended_action, [
      'promote',
      'keep',
      'watch',
      'demote',
      'remove',
    ], 'watch'),
  };
}

async function postChatCompletion(baseUrl, apiKey, body) {
  const endpoint = new URL(`${baseUrl.replace(/\/+$/, '')}/chat/completions`);

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if ((response.status === 429 || response.status >= 500) && attempt === 0) {
      await sleep(RETRY_DELAY_MS);
      continue;
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!response.ok) {
      const code = cleanText(json?.error?.code || response.statusText || 'request_failed');
      const message = cleanText(json?.error?.message || 'provider returned a non-OK response');
      throw new Error(`LLM request failed: ${response.status} ${code}: ${message}`);
    }

    if (!json) throw new Error('LLM response was not JSON');
    return json;
  }

  throw new Error('LLM request failed after retry');
}

function insertReviews(charonDb, reviews, model, batchId, rawJson) {
  const reviewedAtMs = Date.now();
  const insert = charonDb.prepare(`
    INSERT INTO wallet_llm_reviews (
      wallet_address,
      reviewed_at_ms,
      llm_verdict,
      llm_confidence,
      llm_reasoning,
      recommended_action,
      llm_model,
      batch_id,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const txn = charonDb.transaction(() => {
    for (const review of reviews) {
      insert.run(
        review.wallet_address,
        reviewedAtMs,
        review.llm_verdict,
        review.llm_confidence,
        review.llm_reasoning,
        review.recommended_action,
        model,
        batchId,
        rawJson,
      );
    }
  });
  txn();
  return reviewedAtMs;
}

function loadWalletContexts(charonDb, harvesterDb, limit, targetMcap) {
  const savedRows = selectSavedWallets(charonDb, limit, argCsv('wallet-address'));
  const addresses = savedRows.map(row => row.address);
  const aggregateByAddress = fetchHarvesterAggregates(harvesterDb, addresses, targetMcap);
  const sightingsByAddress = fetchRecentSightings(harvesterDb, addresses);
  const profileByAddress = fetchWalletProfiles(harvesterDb, addresses);
  const ownerLabelByAddress = fetchOwnerLabels(harvesterDb, addresses);
  return savedRows.map(saved => buildWalletContext(
    saved,
    aggregateByAddress.get(saved.address),
    sightingsByAddress.get(saved.address) || [],
    targetMcap,
    profileByAddress.get(saved.address),
    ownerLabelByAddress.get(saved.address),
  ));
}

function parseOptions() {
  const loop = hasFlag('loop');
  const dryRunJson = hasFlag('dry-run-json');
  const walletsPerCycle = argOptionalNumber('wallets-per-cycle');
  const limit = Math.floor(walletsPerCycle || argNumber('limit', DEFAULT_LIMIT));
  const intervalMinutes = argNumber('interval-minutes', DEFAULT_INTERVAL_MINUTES);
  const cycles = argOptionalNumber('cycles');

  return {
    harvesterDbPath: path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB)),
    charonDbPath: path.resolve(argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB)),
    baseUrl: argValue('llm-base-url', process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL),
    model: argValue('llm-model', process.env.LLM_MODEL || DEFAULT_LLM_MODEL),
    limit,
    walletsPerCycle: walletsPerCycle ? Math.floor(walletsPerCycle) : null,
    batchSize: Math.floor(argNumber('batch-size', DEFAULT_BATCH_SIZE)),
    targetMcap: Math.floor(argNumber('target-mcap', DEFAULT_TARGET_MCAP)),
    dryRunJson,
    loop,
    intervalMinutes,
    intervalMs: Math.floor(intervalMinutes * 60_000),
    cycles: cycles ? Math.floor(cycles) : null,
    writeArtifacts: !hasFlag('no-artifact') && !dryRunJson,
    artifactDir: path.resolve(argValue('artifact-dir', DEFAULT_ARTIFACT_DIR)),
  };
}

function validateDbPaths(options) {
  if (!fs.existsSync(options.harvesterDbPath)) throw new Error(`Harvester DB not found: ${options.harvesterDbPath}`);
  if (!fs.existsSync(options.charonDbPath)) throw new Error(`Charon DB not found: ${options.charonDbPath}`);
}

function openDatabases(options) {
  return {
    charonDb: new Database(options.charonDbPath, options.dryRunJson ? { readonly: true } : {}),
    harvesterDb: new Database(options.harvesterDbPath, { readonly: true }),
  };
}

function buildCyclePlan({ charonDb, harvesterDb }, options, cycleNumber) {
  const generatedAtMs = Date.now();
  const wallets = loadWalletContexts(charonDb, harvesterDb, options.limit, options.targetMcap);
  const batches = chunkRows(wallets, options.batchSize).map((batchWallets, index) => {
    const batchId = `wallet-review-${generatedAtMs}-c${cycleNumber}-b${index + 1}`;
    return {
      batch_id: batchId,
      batch_index: index + 1,
      wallet_count: batchWallets.length,
      wallet_addresses: batchWallets.map(wallet => wallet.address),
      request_body: buildRequestBody(options.model, batchWallets, options.targetMcap),
    };
  });

  return {
    cycle_number: cycleNumber,
    generated_at: new Date(generatedAtMs).toISOString(),
    wallets,
    batches,
  };
}

function buildDryRunOutput(options, plan) {
  const output = {
    mode: 'dry-run-json',
    generated_at: plan.generated_at,
    harvester_db: options.harvesterDbPath,
    charon_db: options.charonDbPath,
    model: options.model,
    base_url: options.baseUrl,
    target_mcap: options.targetMcap,
    limit: options.limit,
    batch_size: options.batchSize,
    selected_wallets: plan.wallets.length,
    batches: plan.batches,
  };

  if (options.loop) {
    output.wallets_per_cycle = options.walletsPerCycle || options.limit;
    output.loop = {
      enabled: options.loop,
      interval_minutes: options.intervalMinutes,
      cycles: options.cycles,
      planned_cycles: options.loop ? 1 : null,
      dry_run_one_cycle_only: options.loop,
      will_sleep: false,
    };
  }

  return output;
}

function summarizeLiveCycle(options, plan, artifactRows, artifactPaths, nextWakeAtIso) {
  return {
    cycle_number: plan.cycle_number,
    model: options.model,
    wallet_count: plan.wallets.length,
    batch_count: plan.batches.length,
    stored_review_count: artifactRows.length,
    verdict_counts: countBy(artifactRows, 'llm_verdict'),
    action_counts: countBy(artifactRows, 'recommended_action'),
    artifact_paths: artifactPaths,
    next_wake_time: nextWakeAtIso,
  };
}

async function runLiveCycle(databases, options, apiKey, cycleNumber, nextWakeAtIso = null) {
  const plan = buildCyclePlan(databases, options, cycleNumber);
  let inserted = 0;
  const artifactRows = [];
  const artifactBatchIds = [];

  for (const batch of plan.batches) {
    const responseJson = await postChatCompletion(options.baseUrl, apiKey, batch.request_body);
    const reviewPayload = extractReviewPayload(responseJson);
    const allowedAddresses = new Set(batch.wallet_addresses);
    const reviews = (Array.isArray(reviewPayload.reviews) ? reviewPayload.reviews : [])
      .map(review => normalizeReview(review, allowedAddresses))
      .filter(Boolean);

    const reviewedAtMs = insertReviews(databases.charonDb, reviews, options.model, batch.batch_id, JSON.stringify(responseJson));
    artifactBatchIds.push(batch.batch_id);
    artifactRows.push(...reviews.map(review => ({
      ...review,
      batch_id: batch.batch_id,
      reviewed_at_ms: reviewedAtMs,
      reviewed_at_iso: iso(reviewedAtMs),
    })));
    inserted += reviews.length;

    if (!options.loop) {
      const verdictCounts = reviews.reduce((acc, review) => {
        acc[review.llm_verdict] = (acc[review.llm_verdict] || 0) + 1;
        return acc;
      }, {});
      console.log(`Stored batch ${batch.batch_id}: ${reviews.length}/${batch.wallet_count} reviews ${JSON.stringify(verdictCounts)}`);
    }
  }

  let artifactPaths = [];
  if (options.writeArtifacts) {
    const artifact = {
      generated_at: new Date().toISOString(),
      model: options.model,
      base_url: options.baseUrl,
      batch_id: artifactBatchIds.length === 1 ? artifactBatchIds[0] : `wallet-review-${Date.now()}`,
      batch_ids: artifactBatchIds,
      wallet_count: artifactRows.length,
      verdict_counts: countBy(artifactRows, 'llm_verdict'),
      action_counts: countBy(artifactRows, 'recommended_action'),
      rows: artifactRows,
    };
    const paths = writeReviewArtifacts(options.artifactDir, artifact);
    artifactPaths = [paths.jsonPath, paths.csvPath];
  }

  if (!options.loop) {
    console.log(`Done: stored ${inserted} wallet LLM reviews across ${plan.batches.length} batches.`);
    for (const artifactPath of artifactPaths) {
      console.log(`Review artifacts written: ${artifactPath}`);
    }
  }

  return summarizeLiveCycle(options, plan, artifactRows, artifactPaths, nextWakeAtIso);
}

function installStopHandlers(state) {
  const stop = signal => {
    state.stopRequested = true;
    process.stderr.write(`Received ${signal}; stopping after the current cycle or sleep interval.\n`);
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

async function sleepUntilNextCycle(ms, state) {
  const stepMs = Math.min(1_000, ms);
  let remaining = ms;
  while (remaining > 0 && !state.stopRequested) {
    const waitMs = Math.min(stepMs, remaining);
    await sleep(waitMs);
    remaining -= waitMs;
  }
}

async function runLoop(databases, options, apiKey) {
  const state = { stopRequested: false };
  installStopHandlers(state);
  let cycleNumber = 0;

  while (!state.stopRequested && (!options.cycles || cycleNumber < options.cycles)) {
    cycleNumber += 1;
    const shouldRunAnother = !options.cycles || cycleNumber < options.cycles;
    const summary = await runLiveCycle(databases, options, apiKey, cycleNumber, null);
    const nextWakeAtMs = shouldRunAnother ? Date.now() + options.intervalMs : null;
    summary.next_wake_time = nextWakeAtMs ? new Date(nextWakeAtMs).toISOString() : null;
    console.log(`Loop cycle summary: ${JSON.stringify(summary)}`);

    if (!shouldRunAnother || state.stopRequested) break;
    await sleepUntilNextCycle(options.intervalMs, state);
  }
}

async function main() {
  const options = parseOptions();
  validateDbPaths(options);

  if (options.loop && options.dryRunJson) {
    const databases = openDatabases(options);
    try {
      const plan = buildCyclePlan(databases, options, 1);
      process.stdout.write(JSON.stringify(buildDryRunOutput(options, plan), null, 2));
      process.stdout.write('\n');
      return;
    } finally {
      databases.harvesterDb.close();
      databases.charonDb.close();
    }
  }

  const apiKey = options.dryRunJson ? null : process.env.LLM_API_KEY || process.env.XIAOMIMIMO_API_KEY;
  if (!options.dryRunJson && !apiKey) {
    process.stderr.write('LLM_API_KEY or XIAOMIMIMO_API_KEY is not set; run with --dry-run-json or export one of those variables\n');
    process.exitCode = 1;
    return;
  }

  const databases = openDatabases(options);
  try {
    if (!options.dryRunJson) createReviewTable(databases.charonDb);

    if (options.dryRunJson) {
      const plan = buildCyclePlan(databases, options, 1);
      process.stdout.write(JSON.stringify(buildDryRunOutput(options, plan), null, 2));
      process.stdout.write('\n');
      return;
    }

    if (options.loop) {
      await runLoop(databases, options, apiKey);
      return;
    }

    await runLiveCycle(databases, options, apiKey, 1);
  } finally {
    databases.harvesterDb.close();
    databases.charonDb.close();
  }
}

main().catch(error => {
  console.error(cleanText(error.message || error));
  process.exit(1);
});
