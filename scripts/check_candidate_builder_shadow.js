#!/usr/bin/env node
/**
 * Run Charon's real buildCandidate() path once with provider stubs enabled.
 *
 * This does not start Charon, Telegram, PM2, trading, signing, swaps, LLM calls,
 * or provider HTTP calls. It sets CHARON_SKIP_DOTENV and CHARON_PROVIDER_STUBS
 * before importing Charon modules.
 *
 * Usage:
 *   node scripts/check_candidate_builder_shadow.js
 *   DB_PATH=/opt/trading-data/charon.sqlite HARVESTER_DB_PATH=/opt/trading-data/harvester.db node scripts/check_candidate_builder_shadow.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.CHARON_PROVIDER_STUBS = 'true';

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

process.env.DB_PATH = path.resolve(argValue('charon-db', process.env.DB_PATH || path.join(REPO_ROOT, 'charon.sqlite')));
process.env.HARVESTER_DB_PATH = path.resolve(argValue(
  'harvester-db',
  process.env.HARVESTER_DB_PATH || path.join(REPO_ROOT, 'tools/wallet-harvester/data/harvester.db'),
));

const limit = argNumber('limit', 8);
const mint = argValue('mint', 'SHADOW_MINT_FOR_CANDIDATE_BUILDER_CHECK');
process.env.CHARON_SHADOW_MINT = mint;

const [
  { initDb, db },
  { buildCandidate },
  { compactCandidateForLlm },
  { isKolLikeWallet, savedWallets },
] = await Promise.all([
  import('../src/db/connection.js'),
  import('../src/pipeline/candidateBuilder.js'),
  import('../src/pipeline/llm.js'),
  import('../src/enrichment/wallets.js'),
]);

initDb();

const wallets = savedWallets();
const kolLike = wallets.filter(isKolLikeWallet);
const selected = [
  ...kolLike,
  ...wallets.filter(wallet => !isKolLikeWallet(wallet)),
].slice(0, limit);

process.env.CHARON_SHADOW_HOLDER_ADDRESSES = selected.map(wallet => wallet.address).join(',');

const candidate = await buildCandidate({
  mint,
  route: 'shadow_candidate_builder_check',
});
const compact = compactCandidateForLlm({ id: 0, candidate });

const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.join(REPORT_DIR, `candidate-builder-shadow-${stamp}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify({
  created_at: createdAt,
  db_path: process.env.DB_PATH,
  harvester_db_path: process.env.HARVESTER_DB_PATH,
  provider_stubs: true,
  saved_wallet_count: wallets.length,
  kol_like_saved_wallet_count: kolLike.length,
  selected_holder_count: selected.length,
  candidate_summary: {
    mint: candidate.token?.mint,
    route: candidate.signals?.route,
    holder_count: candidate.holders?.holders?.length,
    saved_wallet_holder_count: candidate.savedWalletExposure?.holderCount,
    kol_holder_count: candidate.kolDumpRisk?.kolHolders?.length,
    filter_passed: candidate.filters?.passed,
    filter_failures: candidate.filters?.failures,
  },
  compact,
}, null, 2)}\n`);

db.close();

console.log(`Shadow candidate builder report written: ${reportPath}`);
console.log(JSON.stringify({
  savedWalletCount: wallets.length,
  kolLikeSavedWalletCount: kolLike.length,
  selectedHolderCount: selected.length,
  candidateHolderCount: candidate.holders?.holders?.length,
  savedWalletHolderCount: candidate.savedWalletExposure?.holderCount,
  kolHolderCount: candidate.kolDumpRisk?.kolHolders?.length,
  compactHasSavedWalletExposure: Boolean(compact.savedWalletExposure),
  compactHasKolDumpRisk: Boolean(compact.kolDumpRisk),
  providerStubs: true,
}, null, 2));
