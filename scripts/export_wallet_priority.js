/**
 * Export a Charon-specific smart-wallet priority list from the MoonBags wallet
 * harvester SQLite database.
 *
 * This is local-only: it does not call Jupiter, GMGN, OKX, Telegram, or Charon
 * runtime code. It reads public wallet metadata and sighting aggregates from
 * the harvester DB and writes owner-review CSV/JSON files under ./reports.
 *
 * Usage:
 *   node scripts/export_wallet_priority.js
 *   HARVESTER_DB_PATH=/opt/trading-data/harvester.db node scripts/export_wallet_priority.js
 *   node scripts/export_wallet_priority.js --harvester-db=/path/to/harvester.db
 *   node scripts/export_wallet_priority.js --limit=150 --target-mcap=200000
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Local dev default; override with HARVESTER_DB_PATH or --harvester-db for VPS/CI layouts.
const DEFAULT_HARVESTER_DB = path.join(REPO_ROOT, '../moonbags/tools/wallet-harvester/data/harvester.db');
const DEFAULT_CHARON_DB = path.join(REPO_ROOT, 'charon.sqlite');
const REVIEW_BASE = 'https://gmgn.ai/sol/address';
const PNL_FRESH_DAYS = 3;
const LLM_REVIEW_FRESH_DAYS = 7;
const MIN_OBSERVED_DAYS_FOR_FREQ = 3;
const OWNER_PROTECT_LABELS = new Set(['good_profitable_smart_wallet', 'keep', 'smart_wallet']);
const OWNER_HARD_BLOCK_LABELS = new Set(['exclude', 'avoid', 'ban', 'kol_noisy_not_profitable']);
const OWNER_REMOVE_CORROBORATE_LABELS = new Set(['kol_only', 'kol_noisy_not_profitable']);
const OWNER_WATCH_LABELS = new Set(['kol_profitable_watch', 'smart_wallet_watch', 'watch']);

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const parsed = Number(argValue(name, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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

function csvCell(value) {
  if (value == null) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function iso(ms) {
  return ms ? new Date(Number(ms)).toISOString() : '';
}

function pct(value) {
  if (value == null || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeAction(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['promote', 'upgrade', 'add', 'include', 'buy'].includes(text)) return 'promote';
  if (['keep', 'hold', 'maintain', 'neutral'].includes(text)) return 'keep';
  if (['watch', 'monitor', 'review'].includes(text)) return 'watch';
  if (['demote', 'downgrade', 'deprioritize'].includes(text)) return 'demote';
  if (['remove', 'exclude', 'drop', 'prune', 'reject'].includes(text)) return 'remove';
  return text || '';
}

function labelText(value) {
  return String(value || '').trim().toLowerCase();
}

function boolValue(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase());
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function hasTable(db, tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);
  return Boolean(row);
}

function tableColumns(db, tableName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().map(column => column.name);
}

function loadLatestLlmReviews(charonDbPath) {
  if (!fs.existsSync(charonDbPath)) return new Map();

  const db = new Database(charonDbPath, { readonly: true });
  try {
    if (!hasTable(db, 'wallet_llm_reviews')) return new Map();
    const columns = tableColumns(db, 'wallet_llm_reviews');
    const hasAction = columns.includes('recommended_action');
    const latestRows = db.prepare(`
      SELECT
        wallet_address,
        reviewed_at_ms,
        llm_verdict,
        llm_confidence,
        llm_reasoning,
        ${hasAction ? 'recommended_action' : "'keep' AS recommended_action"}
      FROM (
        SELECT
          wallet_address,
          reviewed_at_ms,
          llm_verdict,
          llm_confidence,
          llm_reasoning,
          ${hasAction ? 'recommended_action,' : ''}
          ROW_NUMBER() OVER (
            PARTITION BY wallet_address
            ORDER BY reviewed_at_ms DESC, id DESC
          ) AS rn
        FROM wallet_llm_reviews
      )
      WHERE rn = 1
    `).all();
    const recentRows = db.prepare(`
      SELECT wallet_address, recommended_action, rn
      FROM (
        SELECT
          wallet_address,
          ${hasAction ? 'recommended_action' : "'keep' AS recommended_action"},
          ROW_NUMBER() OVER (
            PARTITION BY wallet_address
            ORDER BY reviewed_at_ms DESC, id DESC
          ) AS rn
        FROM wallet_llm_reviews
      )
      WHERE rn <= 3
      ORDER BY wallet_address, rn
    `).all();
    const recentByAddress = new Map();
    for (const row of recentRows) {
      if (!recentByAddress.has(row.wallet_address)) recentByAddress.set(row.wallet_address, []);
      recentByAddress.get(row.wallet_address).push(row);
    }
    return new Map(latestRows.map(row => {
      const recent = recentByAddress.get(row.wallet_address) || [];
      let staleReviewCount = 0;
      for (const review of recent) {
        if (normalizeAction(review.recommended_action) !== 'remove') break;
        staleReviewCount++;
      }
      const staleCandidate = staleReviewCount >= 3;
      return [row.wallet_address, {
        ...row,
        stale_review_count: staleReviewCount,
        stale_candidate: staleCandidate,
        stale_reason: staleCandidate ? 'latest 3 consecutive LLM reviews recommended remove' : '',
      }];
    }));
  } finally {
    db.close();
  }
}

function loadWalletProfiles(db) {
  if (!hasTable(db, 'wallet_profiles')) return new Map();
  const rows = db.prepare('SELECT * FROM wallet_profiles').all();
  return new Map(rows.map(row => [row.address, row]));
}

function loadOwnerLabels(db) {
  if (!hasTable(db, 'owner_labels')) return new Map();
  const rows = db.prepare('SELECT address, manual_label, manual_notes, labeled_at_ms FROM owner_labels').all();
  return new Map(rows.map(row => [row.address, row]));
}

function loadSavedWalletAddresses(charonDbPath) {
  if (!fs.existsSync(charonDbPath)) return new Set();

  const db = new Database(charonDbPath, { readonly: true });
  try {
    if (!hasTable(db, 'saved_wallets')) return new Set();
    return new Set(db.prepare('SELECT address FROM saved_wallets').all().map(row => row.address));
  } finally {
    db.close();
  }
}

function profileFields(row, profile, ownerLabel) {
  const providerTags = parseJsonArray(row.provider_tags);
  const gmgnTags = parseJsonArray(profile?.gmgn_tags);
  const gmgnSnapshotAt = numberOrNull(profile?.gmgn_snapshot_at);
  const gmgnSnapshotAgeDays = gmgnSnapshotAt ? Math.max(0, (Date.now() - gmgnSnapshotAt) / 86_400_000) : null;
  const kolLike = [...providerTags, ...gmgnTags].some(tag => {
    const text = tag.toLowerCase();
    return ['kol', 'renowned', 'influencer', 'caller', 'alpha'].some(marker => text.includes(marker));
  }) || Boolean((profile?.gmgn_twitter_username || row.twitter_username) && row.wallet_label);
  return {
    gmgn_realized_profit_usd: pct(profile?.gmgn_realized_profit_usd),
    gmgn_pnl_ratio: pct(profile?.gmgn_pnl_ratio),
    gmgn_winrate: pct(profile?.gmgn_winrate),
    gmgn_buy_count: pct(profile?.gmgn_buy_count),
    gmgn_sell_count: pct(profile?.gmgn_sell_count),
    gmgn_period: profile?.gmgn_period || '',
    gmgn_snapshot_at_iso: iso(profile?.gmgn_snapshot_at),
    gmgn_snapshot_age_days: gmgnSnapshotAgeDays == null ? null : Math.round(gmgnSnapshotAgeDays * 10) / 10,
    gmgn_profile_fresh: gmgnSnapshotAgeDays != null && gmgnSnapshotAgeDays <= LLM_REVIEW_FRESH_DAYS,
    gmgn_tags: gmgnTags,
    okx_win_rate: pct(profile?.okx_win_rate),
    okx_realized_pnl_usd: pct(profile?.okx_realized_pnl_usd),
    okx_avg_buy_value_usd: pct(profile?.okx_avg_buy_value_usd),
    okx_preferred_mcap: profile?.okx_preferred_mcap || '',
    okx_buy_tx_count: pct(profile?.okx_buy_tx_count),
    okx_snapshot_at_iso: iso(profile?.okx_snapshot_at),
    okx_buys_by_mcap: parseJsonValue(profile?.okx_buys_by_mcap_json, []),
    kol_like: kolLike,
    owner_manual_label: ownerLabel?.manual_label || '',
    owner_manual_notes: ownerLabel?.manual_notes || '',
  };
}

function ownerCorroboratesRemove(label) {
  if (OWNER_REMOVE_CORROBORATE_LABELS.has(label)) return true;
  if (label === 'kol_profitable_watch') return false;
  return /kol|noisy|not_profitable/.test(label);
}

function computeImportPolicy(row, savedWalletAddresses) {
  const reasons = [];
  const ownerLabel = labelText(row.owner_manual_label);
  const rawAction = normalizeAction(row.llm_recommended_action);
  const insufficientDataWithFreshGmgn = labelText(row.llm_verdict) === 'insufficient_data' && boolValue(row.gmgn_profile_fresh);
  const action = insufficientDataWithFreshGmgn ? 'watch' : rawAction;
  const llmFresh = boolValue(row.llm_review_fresh);
  const protectedByOwner = OWNER_PROTECT_LABELS.has(ownerLabel) || OWNER_WATCH_LABELS.has(ownerLabel);

  if (boolValue(row.stale_candidate)) reasons.push('stale_3_consecutive');
  if (OWNER_HARD_BLOCK_LABELS.has(ownerLabel)) reasons.push('owner_exclude');

  if (action === 'remove' && llmFresh && !protectedByOwner) {
    const corroboratingReasons = [];
    const gmgnWinrate = numberOrNull(row.gmgn_winrate);
    const gmgnProfit = numberOrNull(row.gmgn_realized_profit_usd);
    const okxWinRate = numberOrNull(row.okx_win_rate);
    const okxProfit = numberOrNull(row.okx_realized_pnl_usd);

    if (boolValue(row.kol_like)) corroboratingReasons.push('kol_like');
    if (ownerCorroboratesRemove(ownerLabel)) corroboratingReasons.push('owner_label');
    if (gmgnWinrate != null && gmgnProfit != null && gmgnWinrate < 0.35 && gmgnProfit < 0) {
      corroboratingReasons.push('negative_pnl');
    }
    if (okxWinRate != null && okxProfit != null && okxWinRate < 35 && okxProfit < 0) {
      corroboratingReasons.push('okx_negative_pnl');
    }

    if (corroboratingReasons.length > 0) reasons.push(...corroboratingReasons);
  }

  const uniqueReasons = [...new Set(reasons)];
  const importBlocked = uniqueReasons.length > 0;
  let reviewLane = 'watch';
  if (importBlocked) {
    reviewLane = 'blocked';
  } else if (OWNER_WATCH_LABELS.has(ownerLabel)) {
    reviewLane = 'watch';
  } else if (['A', 'B'].includes(row.tier) && action === 'demote' && llmFresh) {
    reviewLane = 'owner_review';
  } else if (action === 'watch') {
    reviewLane = 'watch';
  } else if (['A', 'B'].includes(row.tier)) {
    reviewLane = 'ready';
  }

  return {
    import_candidate: reviewLane === 'ready',
    import_blocked: importBlocked,
    import_block_reason: uniqueReasons.join('+'),
    review_lane: reviewLane,
    saved_but_now_blocked: savedWalletAddresses.has(row.address) && importBlocked,
  };
}

function importPolicySummary(rows) {
  const laneCounts = { ready: 0, watch: 0, blocked: 0, owner_review: 0 };
  const reasonCounts = {
    stale: 0,
    kol_like: 0,
    owner_label: 0,
    negative_pnl: 0,
    owner_exclude: 0,
    okx_negative_pnl: 0,
  };
  const savedBlocked = [];

  for (const row of rows) {
    laneCounts[row.review_lane] = (laneCounts[row.review_lane] || 0) + 1;
    if (row.saved_but_now_blocked) savedBlocked.push(row.address);
    for (const reason of String(row.import_block_reason || '').split('+').filter(Boolean)) {
      const key = reason === 'stale_3_consecutive' ? 'stale' : reason;
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }
  }

  return { laneCounts, reasonCounts, savedBlocked };
}

function llmScoreAdjustment(review, profile = {}) {
  if (!review) return 0;
  if (labelText(review.llm_verdict) === 'insufficient_data' && boolValue(profile.gmgn_profile_fresh)) return 0;
  const confidence = clamp(Number(review.llm_confidence) / 100, 0, 1);
  const action = normalizeAction(review.recommended_action);
  if (action === 'promote') return 10 * confidence;
  if (action === 'keep') return 3 * confidence;
  if (action === 'watch') return 0;
  if (action === 'demote') return -12 * confidence;
  if (action === 'remove') return -25 * confidence;
  return 0;
}

function formulaDisagreesWithLlm(formulaTier, review) {
  const action = normalizeAction(review?.recommended_action);
  if (['demote', 'remove'].includes(action) && ['A', 'B'].includes(formulaTier)) return true;
  if (action === 'promote' && ['C', 'D', 'watch'].includes(formulaTier)) return true;
  return false;
}

function llmFields(review, formulaTier, profile = {}) {
  if (!review) {
    return {
      llm_verdict: '',
      llm_confidence: '',
      llm_recommended_action: '',
      llm_reasoning: '',
      llm_reviewed_at_iso: '',
      llm_review_fresh: false,
      llm_score_adjustment: 0,
      llm_formula_disagreement: false,
      stale_review_count: 0,
      stale_candidate: false,
      stale_reason: '',
    };
  }

  const reviewedAt = Number(review.reviewed_at_ms);
  const ageDays = Number.isFinite(reviewedAt) ? (Date.now() - reviewedAt) / 86_400_000 : Infinity;
  const fresh = ageDays >= 0 && ageDays <= LLM_REVIEW_FRESH_DAYS;
  const adjustment = fresh ? Math.round(llmScoreAdjustment(review, profile) * 10) / 10 : 0;
  return {
    llm_verdict: review.llm_verdict || '',
    llm_confidence: Number.isFinite(Number(review.llm_confidence)) ? Number(review.llm_confidence) : '',
    llm_recommended_action: normalizeAction(review.recommended_action),
    llm_reasoning: review.llm_reasoning || '',
    llm_reviewed_at_iso: iso(review.reviewed_at_ms),
    llm_review_fresh: fresh,
    llm_score_adjustment: adjustment,
    llm_formula_disagreement: formulaDisagreesWithLlm(formulaTier, review),
    stale_review_count: Number(review.stale_review_count || 0),
    stale_candidate: Boolean(review.stale_candidate),
    stale_reason: review.stale_reason || '',
  };
}

function scoreWallet(row) {
  const targetShare = row.total_sightings > 0 ? row.target_sightings / row.total_sightings : 0;
  const daysSinceLastSeen = row.last_seen
    ? Math.max(0, (Date.now() - Number(row.last_seen)) / 86_400_000)
    : 999;
  const observedDays = row.first_seen && row.last_seen
    ? Math.max(1, (Number(row.last_seen) - Number(row.first_seen)) / 86_400_000)
    : 1;
  const sightingsPerDay = row.total_sightings / observedDays;
  const sources = parseJsonArray(row.sources);
  const tags = parseJsonArray(row.tags);
  const providerTags = parseJsonArray(row.provider_tags);
  const tokenTags = parseJsonArray(row.token_tags);
  const pnlAgeDays = row.pnl_snapshot_at
    ? Math.max(0, (Date.now() - Number(row.pnl_snapshot_at)) / 86_400_000)
    : null;
  const pnlFresh = pnlAgeDays != null && pnlAgeDays <= PNL_FRESH_DAYS;
  const winRate = pnlFresh ? pct(row.win_rate) : null;
  const pnlUsd = pnlFresh ? pct(row.pnl_usd) : null;
  const avgBuyUsd = pct(row.avg_buy_usd);
  const frequencyScore = observedDays >= MIN_OBSERVED_DAYS_FOR_FREQ
    ? clamp(sightingsPerDay, 0, 5) * 8
    : 0;

  let score = 0;
  score += targetShare * 45;
  score += Math.min(row.target_tokens, 8) * 10;
  score += Math.min(row.target_sightings, 12) * 3;
  score += Math.min(row.token_count, 20) * 2;
  score += frequencyScore;
  score += Math.max(0, 20 - daysSinceLastSeen) * 1.5;
  score += sources.includes('gmgn') && sources.includes('okx') ? 20 : 0;
  score += tags.includes('smart_degen') ? 10 : 0;
  score += tags.includes('renowned') ? 5 : 0;
  score += winRate != null ? clamp(winRate, 0, 1) * 15 : 0;
  score += pnlUsd != null && pnlUsd > 0 ? Math.min(Math.log10(pnlUsd + 1) * 6, 24) : 0;
  score += avgBuyUsd != null && avgBuyUsd > 0 && avgBuyUsd <= 10_000 ? 8 : 0;
  score -= row.target_sightings === 0 ? 45 : 0;
  score -= daysSinceLastSeen > 14 ? 15 : 0;
  score -= row.total_sightings < 2 ? 12 : 0;

  return {
    score: Math.round(score * 10) / 10,
    targetShare,
    daysSinceLastSeen: Math.round(daysSinceLastSeen * 10) / 10,
    observedDays: Math.round(observedDays * 10) / 10,
    sightingsPerDay: Math.round(sightingsPerDay * 100) / 100,
    frequencyCounted: observedDays >= MIN_OBSERVED_DAYS_FOR_FREQ,
    pnlFresh,
    pnlAgeDays: pnlAgeDays == null ? null : Math.round(pnlAgeDays * 10) / 10,
    sources,
    tags,
    providerTags,
    tokenTags,
  };
}

function tierFor(row, metrics) {
  if (metrics.score >= 115 && row.target_sightings >= 3 && metrics.daysSinceLastSeen <= 7) return 'A';
  if (metrics.score >= 80 && row.target_sightings >= 2) return 'B';
  if (metrics.score >= 50 && row.target_sightings >= 1) return 'C';
  return 'watch';
}

function main() {
  const harvesterDb = path.resolve(argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB));
  const charonDb = path.resolve(argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB));
  const targetMcap = argNumber('target-mcap', 200_000);
  const limit = Math.floor(argNumber('limit', 250));
  const reportDir = path.resolve(argValue('out-dir', path.join(REPO_ROOT, 'reports')));

  if (!fs.existsSync(harvesterDb)) {
    throw new Error(`Harvester DB not found: ${harvesterDb}`);
  }

  fs.mkdirSync(reportDir, { recursive: true });

  const latestLlmByAddress = loadLatestLlmReviews(charonDb);
  const savedWalletAddresses = loadSavedWalletAddresses(charonDb);
  const db = new Database(harvesterDb, { readonly: true });
  const profileByAddress = loadWalletProfiles(db);
  const ownerLabelByAddress = loadOwnerLabels(db);
  const rows = db.prepare(`
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
      SUM(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN 1 ELSE 0 END) AS target_sightings,
      COUNT(DISTINCT CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.mint END) AS target_tokens,
      MAX(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.timestamp ELSE NULL END) AS last_target_seen,
      AVG(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.token_mcap_usd ELSE NULL END) AS avg_target_mcap,
      AVG(CASE WHEN s.token_mcap_usd > 0 AND s.token_mcap_usd <= ? THEN s.amount_usd ELSE NULL END) AS avg_target_amount_usd
    FROM wallets w
    LEFT JOIN sightings s ON s.wallet_address = w.address
    GROUP BY w.address
  `).all(targetMcap, targetMcap, targetMcap, targetMcap, targetMcap);

  const ranked = rows
    .map(row => {
      const metrics = scoreWallet(row);
      const formulaTier = tierFor(row, metrics);
      const profile = profileFields(row, profileByAddress.get(row.address), ownerLabelByAddress.get(row.address));
      const llm = llmFields(latestLlmByAddress.get(row.address), formulaTier, profile);
      const adjustedScore = Math.round((metrics.score + llm.llm_score_adjustment) * 10) / 10;
      const adjustedMetrics = { ...metrics, score: adjustedScore };
      const adjustedTier = tierFor(row, adjustedMetrics);
      const exportRow = {
        ...row,
        ...metrics,
        formula_score: metrics.score,
        formula_tier: formulaTier,
        ...profile,
        ...llm,
        score: adjustedScore,
        tier: llm.stale_candidate ? 'stale' : adjustedTier,
      };
      return {
        ...exportRow,
        ...computeImportPolicy(exportRow, savedWalletAddresses),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = path.join(reportDir, `smart-wallet-priority-${timestamp}.csv`);
  const jsonPath = path.join(reportDir, `smart-wallet-priority-${timestamp}.json`);

  const header = [
    'rank',
    'tier',
    'priority_score',
    'formula_tier',
    'formula_score',
    'wallet_address',
    'gmgn_url',
    'label',
    'twitter_username',
    'twitter_name',
    'target_sightings',
    'target_tokens',
    'target_share',
    'total_sightings',
    'token_count',
    'sightings_per_day',
    'days_since_last_seen',
    'last_target_seen_iso',
    'last_seen_iso',
    'avg_target_mcap',
    'avg_target_amount_usd',
    'pnl_usd',
    'win_rate',
    'pnl_fresh',
    'pnl_age_days',
    'pnl_snapshot_at_iso',
    'avg_buy_usd',
    'gmgn_realized_profit_usd',
    'gmgn_pnl_ratio',
    'gmgn_winrate',
    'gmgn_buy_count',
    'gmgn_sell_count',
    'gmgn_period',
    'gmgn_snapshot_at_iso',
    'gmgn_snapshot_age_days',
    'gmgn_profile_fresh',
    'gmgn_tags',
    'okx_win_rate',
    'okx_avg_buy_value_usd',
    'okx_preferred_mcap',
    'okx_buy_tx_count',
    'okx_snapshot_at_iso',
    'kol_like',
    'owner_manual_label',
    'owner_manual_notes',
    'sources',
    'tags',
    'provider_tags',
    'token_tags',
    'llm_verdict',
    'llm_confidence',
    'llm_recommended_action',
    'llm_reasoning',
    'llm_reviewed_at_iso',
    'llm_review_fresh',
    'llm_score_adjustment',
    'llm_formula_disagreement',
    'stale_review_count',
    'stale_candidate',
    'stale_reason',
    'import_candidate',
    'import_blocked',
    'import_block_reason',
    'review_lane',
    'saved_but_now_blocked',
    'manual_rating',
    'manual_notes',
  ];

  const lines = [
    header.join(','),
    ...ranked.map((row, index) => [
      index + 1,
      row.tier,
      row.score,
      row.formula_tier,
      row.formula_score,
      row.address,
      `${REVIEW_BASE}/${row.address}`,
      row.wallet_label,
      row.twitter_username,
      row.twitter_name,
      row.target_sightings,
      row.target_tokens,
      row.targetShare.toFixed(3),
      row.total_sightings,
      row.token_count,
      row.sightingsPerDay,
      row.daysSinceLastSeen,
      iso(row.last_target_seen),
      iso(row.last_seen),
      row.avg_target_mcap != null ? Math.round(Number(row.avg_target_mcap)) : '',
      row.avg_target_amount_usd != null ? Math.round(Number(row.avg_target_amount_usd)) : '',
      row.pnl_usd,
      row.win_rate,
      row.pnlFresh ? 'yes' : 'no',
      row.pnlAgeDays ?? '',
      iso(row.pnl_snapshot_at),
      row.avg_buy_usd,
      row.gmgn_realized_profit_usd ?? '',
      row.gmgn_pnl_ratio ?? '',
      row.gmgn_winrate ?? '',
      row.gmgn_buy_count ?? '',
      row.gmgn_sell_count ?? '',
      row.gmgn_period,
      row.gmgn_snapshot_at_iso,
      row.gmgn_snapshot_age_days ?? '',
      row.gmgn_profile_fresh ? 'yes' : 'no',
      row.gmgn_tags.join('|'),
      row.okx_win_rate ?? '',
      row.okx_avg_buy_value_usd ?? '',
      row.okx_preferred_mcap,
      row.okx_buy_tx_count ?? '',
      row.okx_snapshot_at_iso,
      row.kol_like ? 'yes' : 'no',
      row.owner_manual_label,
      row.owner_manual_notes,
      row.sources.join('|'),
      row.tags.join('|'),
      row.providerTags.join('|'),
      row.tokenTags.join('|'),
      row.llm_verdict,
      row.llm_confidence,
      row.llm_recommended_action,
      row.llm_reasoning,
      row.llm_reviewed_at_iso,
      row.llm_review_fresh ? 'yes' : 'no',
      row.llm_score_adjustment,
      row.llm_formula_disagreement ? 'yes' : 'no',
      row.stale_review_count,
      row.stale_candidate ? 'yes' : 'no',
      row.stale_reason,
      row.import_candidate ? 'yes' : 'no',
      row.import_blocked ? 'yes' : 'no',
      row.import_block_reason,
      row.review_lane,
      row.saved_but_now_blocked ? 'yes' : 'no',
      '',
      '',
    ].map(csvCell).join(',')),
  ];

  fs.writeFileSync(csvPath, `${lines.join('\n')}\n`);
  fs.writeFileSync(jsonPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    harvesterDb,
    charonDb,
    targetMcap,
    limit,
    totalWalletsScored: rows.length,
    exported: ranked.length,
    tierCounts: ranked.reduce((acc, row) => {
      acc[row.tier] = (acc[row.tier] || 0) + 1;
      return acc;
    }, {}),
    scoring: {
      targetMcap,
      pnlFreshDays: PNL_FRESH_DAYS,
      llmReviewFreshDays: LLM_REVIEW_FRESH_DAYS,
      staleRule: 'tier=stale when the latest 3 consecutive LLM reviews all recommend remove; export only, no deletion',
      llmScoreAdjustment: {
        promote: '+10 * confidence',
        keep: '+3 * confidence',
        watch: '0',
        demote: '-12 * confidence',
        remove: '-25 * confidence',
        confidence: 'stored confidence normalized from 0-100 to 0-1',
      },
      minObservedDaysForFrequency: MIN_OBSERVED_DAYS_FOR_FREQ,
      ownerCalibration: 'User confirmed 2026-05-12 priority scoring matches wallets they want to follow; tiers preserved as calibrated-enough for manual import preview.',
    },
    staleCounts: {
      stale: ranked.filter(row => row.stale_candidate).length,
      nonStale: ranked.filter(row => !row.stale_candidate).length,
    },
    csvPath,
    rows: ranked,
  }, null, 2));

  db.close();
  const summary = importPolicySummary(ranked);

  console.log(`Priority CSV: ${csvPath}`);
  console.log(`Priority JSON: ${jsonPath}`);
  console.log(`Scored ${rows.length} wallets; exported top ${ranked.length}; target mcap <= ${targetMcap}.`);
  console.log(`Import lanes: ready=${summary.laneCounts.ready || 0} watch=${summary.laneCounts.watch || 0} blocked=${summary.laneCounts.blocked || 0} owner_review=${summary.laneCounts.owner_review || 0}`);
  console.log(`Block reasons: stale=${summary.reasonCounts.stale || 0} kol_like=${summary.reasonCounts.kol_like || 0} owner_label=${summary.reasonCounts.owner_label || 0} negative_pnl=${summary.reasonCounts.negative_pnl || 0} owner_exclude=${summary.reasonCounts.owner_exclude || 0} okx_negative_pnl=${summary.reasonCounts.okx_negative_pnl || 0}`);
  console.log(`Saved wallets now blocked: ${summary.savedBlocked.length}`);
  if (summary.savedBlocked.length > 0) {
    console.log(`Saved blocked addresses: ${summary.savedBlocked.map(address => `${address.slice(0, 6)}...${address.slice(-4)}`).join(', ')}`);
  }
}

main();
