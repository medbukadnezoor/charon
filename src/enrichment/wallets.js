import { db } from '../db/connection.js';
import { fetchJupiterWalletPnl } from './jupiter.js';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const KOL_TAG_RE = /(kol|renowned|influencer|caller|alpha)/i;
const DEFAULT_HARVESTER_DB_PATH = path.resolve(
  process.cwd(),
  '../moonbags/tools/wallet-harvester/data/harvester.db',
);

// In-memory cache — populated at startup and refreshed every 5 min
let _walletCache = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function loadWalletCache() {
  const rows = db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
  const addressSet = new Set(rows.map(r => r.address));
  const walletMap = new Map(rows.map(r => [r.address, r]));
  _walletCache = { addressSet, walletMap, loadedAt: Date.now() };
  return _walletCache;
}

function getWalletCache() {
  if (!_walletCache || Date.now() - _walletCache.loadedAt > CACHE_TTL_MS) {
    loadWalletCache();
  }
  return _walletCache;
}

export { loadWalletCache };

export function savedWallets() {
  const { walletMap } = getWalletCache();
  return [...walletMap.values()];
}

function tagList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.flatMap(tagList);
  }
  if (typeof value === 'object') {
    return tagList(value.name ?? value.id ?? value.label ?? Object.values(value));
  }
  const text = String(value).trim();
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      return tagList(JSON.parse(text));
    } catch {
      // Fall through to delimiter splitting for malformed provider tag payloads.
    }
  }
  return text
    .split(/[,\s|/]+/)
    .map(tag => tag.trim())
    .filter(Boolean);
}

function walletTags(wallet) {
  return [
    ...tagList(wallet?.tags),
    ...tagList(wallet?.provider_tags),
    ...tagList(wallet?.providerTags),
    ...tagList(wallet?.gmgn_tags),
    ...tagList(wallet?.gmgnTags),
    ...tagList(wallet?.owner_manual_label),
    ...tagList(wallet?.ownerManualLabel),
  ];
}

function walletDetail(wallet) {
  return {
    address: wallet.address,
    label: wallet.label,
    tags: walletTags(wallet),
    ownerManualLabel: wallet.owner_manual_label || null,
    ownerManualNotes: wallet.owner_manual_notes || null,
    gmgnTwitterUsername: wallet.gmgn_twitter_username || null,
    gmgnTwitterName: wallet.gmgn_twitter_name || null,
  };
}

export function isKolLikeWallet(wallet) {
  const haystack = [
    wallet?.label,
    ...walletTags(wallet),
  ].filter(Boolean).join(' ');
  return KOL_TAG_RE.test(haystack);
}

function parseTagsJson(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function topTierOf(tiers) {
  if (tiers.includes('A')) return 'A';
  if (tiers.includes('B')) return 'B';
  if (tiers.includes('C')) return 'C';
  if (tiers.includes('universe')) return 'universe';
  return null;
}

function emptySummary() {
  return { avgGmgnWinrate: null, kolCount: 0, smartMoneyCount: 0, topTier: null, strongCount: 0 };
}

function buildEvidence(matched) {
  const now = Date.now();
  const GMGN_STALE_MS = 3 * 86_400_000;
  const JUP_STALE_MS  = 1 * 86_400_000;

  const wallets = matched.map(w => {
    const gmgnFresh = w.gmgn_snapshot_at != null
      && (now - Number(w.gmgn_snapshot_at)) < GMGN_STALE_MS;
    const jupFresh = w.jup_snapshot_at != null
      && (now - Number(w.jup_snapshot_at)) < JUP_STALE_MS;

    const tags = parseTagsJson(w.tags_json);

    return {
      addr: shortAddress(w.address),
      label: w.label,
      tags,
      tier: w.tier || 'universe',
      gmgn: w.gmgn_winrate != null
        ? { wr: w.gmgn_winrate, pnl: w.gmgn_realized_pnl ?? null, fresh: gmgnFresh }
        : null,
      okx: w.okx_winrate != null
        ? { wr: w.okx_winrate, mcap: w.okx_preferred_mcap ?? null, fresh: true }
        : null,
      jup: w.jup_winrate != null
        ? { pnl: w.jup_total_pnl ?? null, wr: w.jup_winrate, fresh: jupFresh }
        : null,
      owner: w.owner_label || null,
    };
  });

  const gmgnWinrates = wallets
    .map(w => w.gmgn?.wr)
    .filter(v => v != null && Number.isFinite(v));

  const summary = {
    avgGmgnWinrate: gmgnWinrates.length
      ? Math.round((gmgnWinrates.reduce((a, b) => a + b, 0) / gmgnWinrates.length) * 1000) / 1000
      : null,
    kolCount: wallets.filter(w => w.tags.some(t => KOL_TAG_RE.test(t))).length,
    smartMoneyCount: wallets.filter(w => w.tags.some(t => /smart_money|smart_degen/i.test(t))).length,
    topTier: topTierOf(wallets.map(w => w.tier)),
    strongCount: wallets.filter(w => w.tier === 'A' || w.tier === 'B').length,
  };

  return { wallets, summary };
}

export async function fetchSavedWalletExposure(mint, holders) {
  const { addressSet, walletMap } = getWalletCache();
  const total = walletMap.size;

  if (!total || !holders?.holders?.length) {
    return {
      holderCount: 0,
      checked: total,
      wallets: [],
      matchedWallets: [],
      evidence: { wallets: [], summary: emptySummary() },
    };
  }

  const matched = holders.holders
    .filter(h => addressSet.has(h.address))
    .map(h => walletMap.get(h.address));

  return {
    holderCount: matched.length,
    checked: total,
    wallets: matched.map(w => w.label),
    matchedWallets: matched.map(walletDetail),
    evidence: buildEvidence(matched),
  };
}

function numericValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function tokenPnlEntry(pnlByMint, mint) {
  if (!pnlByMint || typeof pnlByMint !== 'object') return null;
  return pnlByMint[mint] ?? pnlByMint.data?.[mint] ?? null;
}

function pnlValuesForToken(entry) {
  const empty = { value: null, percent: null };
  if (entry == null) return empty;
  if (typeof entry === 'number' || typeof entry === 'string') {
    const value = numericValue(entry);
    return { value, percent: value };
  }
  if (typeof entry !== 'object') return empty;
  const percentFields = [
    'pnlPercent',
    'pnl_percent',
    'totalPnlPercent',
    'total_pnl_percent',
    'unrealizedPnlPercent',
    'unrealized_pnl_percent',
  ];
  const valueFields = [
    ...percentFields,
    'pnlUsd',
    'pnl_usd',
  ];
  const percent = percentFields
    .map(field => numericValue(entry[field]))
    .find(value => value != null) ?? null;
  for (const field of valueFields) {
    const value = numericValue(entry[field]);
    if (value != null) return { value, percent };
  }
  return empty;
}

function kolTag(wallet) {
  return [
    ...walletTags(wallet),
    wallet?.label,
    wallet?.ownerManualLabel,
    wallet?.owner_manual_label,
    wallet?.gmgnTwitterUsername,
    wallet?.gmgn_twitter_username,
  ].find(text => KOL_TAG_RE.test(String(text || ''))) || null;
}

function harvesterDbPath() {
  return process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB_PATH;
}

function hasTable(database, name) {
  return Boolean(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function harvesterWalletMetadata(addresses = []) {
  const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
  const dbPath = harvesterDbPath();
  if (!uniqueAddresses.length || !fs.existsSync(dbPath)) return new Map();

  const metadata = new Map();
  const harvesterDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const params = uniqueAddresses;
    const inClause = placeholders(params.length);

    if (hasTable(harvesterDb, 'owner_labels')) {
      for (const row of harvesterDb.prepare(`
        SELECT address, manual_label, manual_notes
        FROM owner_labels
        WHERE address IN (${inClause})
      `).all(...params)) {
        metadata.set(row.address, {
          ...(metadata.get(row.address) || {}),
          owner_manual_label: row.manual_label,
          owner_manual_notes: row.manual_notes,
        });
      }
    }

    if (hasTable(harvesterDb, 'wallet_profiles')) {
      for (const row of harvesterDb.prepare(`
        SELECT
          address,
          gmgn_tags,
          gmgn_twitter_username,
          gmgn_twitter_name,
          gmgn_snapshot_at
        FROM wallet_profiles
        WHERE address IN (${inClause})
      `).all(...params)) {
        metadata.set(row.address, {
          ...(metadata.get(row.address) || {}),
          gmgn_tags: row.gmgn_tags,
          gmgn_twitter_username: row.gmgn_twitter_username,
          gmgn_twitter_name: row.gmgn_twitter_name,
          gmgn_snapshot_at: row.gmgn_snapshot_at,
        });
      }
    }
  } catch (err) {
    console.log(`[wallet-metadata] harvester read skipped: ${err.message}`);
  } finally {
    harvesterDb.close();
  }
  return metadata;
}

function shortAddress(address = '') {
  return `${String(address).slice(0, 4)}...${String(address).slice(-4)}`;
}

export async function fetchKolDumpRisk(mint, savedWalletExposure = {}) {
  const matchedWallets = Array.isArray(savedWalletExposure.matchedWallets)
    ? savedWalletExposure.matchedWallets
    : [];
  const kolWallets = matchedWallets.filter(isKolLikeWallet);
  if (!kolWallets.length) {
    return { kolHolders: [], anyProfitable: false, maxPnlPercent: null };
  }

  const kolHolders = [];
  for (const wallet of kolWallets) {
    try {
      const pnlByMint = await fetchJupiterWalletPnl(wallet.address);
      const { value: pnlOnToken, percent: pnlPercent } = pnlValuesForToken(tokenPnlEntry(pnlByMint, mint));
      kolHolders.push({
        address: wallet.address,
        label: wallet.label,
        tag: kolTag(wallet),
        pnlOnToken,
        pnlPercent,
        profitable: pnlOnToken != null ? pnlOnToken > 0 : false,
      });
    } catch (err) {
      console.log(`[kol-risk] ${shortAddress(wallet.address)} ${err.message}`);
    }
  }

  const pnlValues = kolHolders
    .map(holder => holder.pnlPercent)
    .filter(value => Number.isFinite(value));
  return {
    kolHolders,
    anyProfitable: kolHolders.some(holder => holder.profitable),
    maxPnlPercent: pnlValues.length ? Math.max(...pnlValues) : null,
  };
}

export async function fetchWalletPnl(address) {
  try {
    const url = `https://datapi.jup.ag/v1/pnl?addresses=${encodeURIComponent(address)}&includeClosed=false`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data?.[address] ?? data?.data?.[address] ?? data;
    if (!d || typeof d !== 'object') return null;
    return {
      totalTrades: Number(d.totalTrades ?? d.total_trades ?? 0),
      wins: Number(d.wins ?? d.winCount ?? d.win_count ?? 0),
      winRate: Number(d.winRate ?? d.win_rate ?? 0),
      totalPnlPercent: Number(d.totalPnlPercent ?? d.total_pnl_percent ?? d.totalPnlUsd ?? 0),
    };
  } catch {
    return null;
  }
}
