#!/usr/bin/env node
/**
 * Build one synthetic candidate payload through Charon's real wallet exposure
 * and LLM compacting modules, then exit.
 *
 * This is provider-free and runtime-free. It sets CHARON_SKIP_DOTENV before
 * importing Charon modules, so it does not read .env. It does not start Charon,
 * Telegram, PM2, trading, signing, swaps, or LLM/provider calls.
 *
 * Usage:
 *   node scripts/check_candidate_payload_shadow.js
 *   node scripts/check_candidate_payload_shadow.js --limit=8
 *   DB_PATH=/path/to/charon.sqlite HARVESTER_DB_PATH=/path/to/harvester.db node scripts/check_candidate_payload_shadow.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.CHARON_SKIP_DOTENV = 'true';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(REPO_ROOT, 'reports');

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function argNumber(name, fallback) {
  const raw = argValue(name, '');
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function shortAddress(address = '') {
  return `${String(address).slice(0, 4)}...${String(address).slice(-4)}`;
}

process.env.DB_PATH = path.resolve(argValue('charon-db', process.env.DB_PATH || path.join(REPO_ROOT, 'charon.sqlite')));
process.env.HARVESTER_DB_PATH = path.resolve(argValue(
  'harvester-db',
  process.env.HARVESTER_DB_PATH || path.join(REPO_ROOT, '../moonbags/tools/wallet-harvester/data/harvester.db'),
));

const limit = argNumber('limit', 8);
const mint = argValue('mint', 'SHADOW_MINT_FOR_CANDIDATE_PAYLOAD_CHECK');

const [
  { db },
  { compactCandidateForLlm },
  { fetchSavedWalletExposure, isKolLikeWallet, savedWallets },
] = await Promise.all([
  import('../src/db/connection.js'),
  import('../src/pipeline/llm.js'),
  import('../src/enrichment/wallets.js'),
]);

const wallets = savedWallets();
const kolLike = wallets.filter(isKolLikeWallet);
const selected = [
  ...kolLike,
  ...wallets.filter(wallet => !isKolLikeWallet(wallet)),
].slice(0, limit);

const holders = {
  count: selected.length,
  holders: selected.map((wallet, index) => ({
    address: wallet.address,
    rank: index + 1,
    amount: 1,
    percent: null,
    tags: [],
  })),
  top20: [],
  top20Percent: null,
  maxHolderPercent: null,
};
holders.top20 = holders.holders.slice(0, 20);

const savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
const kolHolders = savedWalletExposure.matchedWallets
  .filter(isKolLikeWallet)
  .map(wallet => ({
    address: wallet.address,
    label: wallet.label,
    tag: wallet.tags.find(tag => /kol|renowned|influencer|caller|alpha/i.test(tag)) || wallet.ownerManualLabel,
    pnlOnToken: null,
    pnlPercent: null,
    profitable: false,
  }));
const kolDumpRisk = {
  kolHolders,
  anyProfitable: false,
  maxPnlPercent: null,
  source: 'shadow_no_provider_call',
};

const row = {
  id: 0,
  candidate: {
    token: {
      mint,
      name: 'Shadow Candidate',
      symbol: 'SHADOW',
      gmgnUrl: '',
      twitter: '',
      website: '',
      telegram: '',
    },
    signals: {
      route: 'shadow_candidate_payload_check',
      label: 'shadow',
      hasFeeClaim: false,
      hasGraduated: false,
      hasTrending: false,
      triggerSignature: null,
      strategy: 'shadow',
    },
    metrics: {
      priceUsd: null,
      marketCapUsd: null,
      liquidityUsd: 0,
      holderCount: holders.count,
    },
    chart: {
      purpose: 'shadow payload shape only',
      currentNative: null,
      rangeHighNative: null,
      distanceFromAthPercent: null,
      topBlastRisk: null,
      windows: [],
    },
    holders,
    savedWalletExposure,
    kolDumpRisk,
    filters: {
      passed: false,
      failures: ['shadow payload only'],
      strategy: 'shadow',
    },
  },
};

const compact = compactCandidateForLlm(row);
const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.join(REPORT_DIR, `candidate-payload-shadow-${stamp}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify({
  created_at: createdAt,
  db_path: process.env.DB_PATH,
  harvester_db_path: process.env.HARVESTER_DB_PATH,
  saved_wallet_count: wallets.length,
  kol_like_saved_wallet_count: kolLike.length,
  selected_holder_count: selected.length,
  matched_wallet_count: savedWalletExposure.matchedWallets.length,
  kol_holder_count: kolDumpRisk.kolHolders.length,
  matched_wallet_labels: savedWalletExposure.matchedWallets.map(wallet => wallet.label),
  kol_holder_labels: kolDumpRisk.kolHolders.map(wallet => wallet.label),
  compact,
}, null, 2)}\n`);

db.close();

console.log(`Shadow candidate payload written: ${reportPath}`);
console.log(JSON.stringify({
  savedWalletCount: wallets.length,
  kolLikeSavedWalletCount: kolLike.length,
  selectedHolderCount: selected.length,
  matchedWalletCount: savedWalletExposure.matchedWallets.length,
  kolHolderCount: kolDumpRisk.kolHolders.length,
  compactHasSavedWalletExposure: Boolean(compact.savedWalletExposure),
  compactHasKolDumpRisk: Boolean(compact.kolDumpRisk),
  matchedWallets: savedWalletExposure.matchedWallets.map(wallet => `${wallet.label}:${shortAddress(wallet.address)}`),
}, null, 2));
