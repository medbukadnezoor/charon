#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const KOL_TAG_RE = /(kol|renowned|influencer|caller|alpha)/i;
const DEFAULT_CHARON_DB_PATH = path.resolve(process.cwd(), 'charon.sqlite');
const DEFAULT_HARVESTER_DB_PATH = path.resolve(
  process.cwd(),
  'tools/wallet-harvester/data/harvester.db',
);

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find(arg => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function tagList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(tagList);
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
    ...tagList(wallet.tags),
    ...tagList(wallet.provider_tags),
    ...tagList(wallet.providerTags),
    ...tagList(wallet.gmgn_tags),
    ...tagList(wallet.owner_manual_label),
  ];
}

function isKolLikeWallet(wallet) {
  return KOL_TAG_RE.test([
    wallet.label,
    wallet.owner_manual_label,
    wallet.gmgn_twitter_username,
    wallet.gmgn_twitter_name,
    ...walletTags(wallet),
  ].filter(Boolean).join(' '));
}

function hasTable(database, name) {
  return Boolean(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name));
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function loadHarvesterMetadata(dbPath, addresses) {
  const uniqueAddresses = [...new Set(addresses.filter(Boolean))];
  if (!uniqueAddresses.length || !fs.existsSync(dbPath)) return new Map();

  const metadata = new Map();
  const database = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const inClause = placeholders(uniqueAddresses.length);
    if (hasTable(database, 'owner_labels')) {
      for (const row of database.prepare(`
        SELECT address, manual_label, manual_notes
        FROM owner_labels
        WHERE address IN (${inClause})
      `).all(...uniqueAddresses)) {
        metadata.set(row.address, {
          ...(metadata.get(row.address) || {}),
          owner_manual_label: row.manual_label,
          owner_manual_notes: row.manual_notes,
        });
      }
    }
    if (hasTable(database, 'wallet_profiles')) {
      for (const row of database.prepare(`
        SELECT
          address,
          gmgn_tags,
          gmgn_twitter_username,
          gmgn_twitter_name,
          gmgn_snapshot_at
        FROM wallet_profiles
        WHERE address IN (${inClause})
      `).all(...uniqueAddresses)) {
        metadata.set(row.address, {
          ...(metadata.get(row.address) || {}),
          gmgn_tags: row.gmgn_tags,
          gmgn_twitter_username: row.gmgn_twitter_username,
          gmgn_twitter_name: row.gmgn_twitter_name,
          gmgn_snapshot_at: row.gmgn_snapshot_at,
        });
      }
    }
  } finally {
    database.close();
  }
  return metadata;
}

function compactCandidateForShadow(candidate) {
  return {
    candidate_id: 0,
    mint: candidate.token.mint,
    route: candidate.signals.route,
    signals: candidate.signals,
    token: candidate.token,
    metrics: candidate.metrics,
    holders: candidate.holders,
    savedWalletExposure: candidate.savedWalletExposure,
    kolDumpRisk: candidate.kolDumpRisk,
  };
}

const charonDbPath = argValue('charon-db', process.env.CHARON_DB_PATH || DEFAULT_CHARON_DB_PATH);
const harvesterDbPath = argValue('harvester-db', process.env.HARVESTER_DB_PATH || DEFAULT_HARVESTER_DB_PATH);
const limit = Number(argValue('limit', '8'));

if (!fs.existsSync(charonDbPath)) {
  console.error(`Charon DB not found: ${charonDbPath}`);
  process.exit(1);
}

const charonDb = new Database(charonDbPath, { readonly: true, fileMustExist: true });
const savedRows = charonDb.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
charonDb.close();

const metadata = loadHarvesterMetadata(harvesterDbPath, savedRows.map(row => row.address));
const savedWallets = savedRows.map(row => ({
  ...row,
  ...(metadata.get(row.address) || {}),
}));
const kolLikeSavedWallets = savedWallets.filter(isKolLikeWallet);
const selected = kolLikeSavedWallets.slice(0, limit);

const syntheticHolders = {
  holders: selected.map(wallet => ({ address: wallet.address })),
};
const holderSet = new Set(syntheticHolders.holders.map(holder => holder.address));
const matchedWallets = savedWallets
  .filter(wallet => holderSet.has(wallet.address))
  .map(wallet => ({
    address: wallet.address,
    label: wallet.label,
    tags: walletTags(wallet),
    ownerManualLabel: wallet.owner_manual_label || null,
    ownerManualNotes: wallet.owner_manual_notes || null,
    gmgnTwitterUsername: wallet.gmgn_twitter_username || null,
    gmgnTwitterName: wallet.gmgn_twitter_name || null,
  }));

const savedWalletExposure = {
  holderCount: matchedWallets.length,
  checked: savedWallets.length,
  wallets: matchedWallets.map(wallet => wallet.label),
  matchedWallets,
};
const kolDumpRisk = {
  kolHolders: matchedWallets.filter(isKolLikeWallet).map(wallet => ({
    address: wallet.address,
    label: wallet.label,
    tag: wallet.tags.find(tag => KOL_TAG_RE.test(tag)) || wallet.ownerManualLabel,
    pnlOnToken: null,
    pnlPercent: null,
    profitable: false,
  })),
  anyProfitable: false,
  maxPnlPercent: null,
};
const compactCandidate = compactCandidateForShadow({
  token: { mint: 'SHADOW_MINT_FOR_METADATA_CHECK' },
  signals: { route: 'shadow_kol_dump_risk_check' },
  metrics: {},
  holders: { total: syntheticHolders.holders.length },
  savedWalletExposure,
  kolDumpRisk,
});

console.log(JSON.stringify({
  charonDbPath,
  harvesterDbPath,
  savedWalletCount: savedWallets.length,
  metadataMatchedWallets: [...metadata.keys()].length,
  kolLikeSavedWallets: kolLikeSavedWallets.length,
  selectedKolLikeWallets: selected.length,
  savedWalletExposure,
  kolDumpRisk,
  compactPayloadHasSavedWalletExposure: Boolean(compactCandidate.savedWalletExposure),
  compactPayloadHasKolDumpRisk: Boolean(compactCandidate.kolDumpRisk),
}, null, 2));
