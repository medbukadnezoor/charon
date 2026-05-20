#!/usr/bin/env node
/**
 * Evaluate one provider-stubbed candidate against every configured strategy.
 *
 * This copies the Charon DB to a temp file by default, then switches active
 * strategies inside that temp copy only. It does not start Charon, Telegram,
 * PM2, trading, signing, swaps, LLM calls, provider calls, or read .env.
 *
 * Usage:
 *   node scripts/check_strategy_matrix_shadow.js
 *   DB_PATH=/opt/trading-data/charon.sqlite HARVESTER_DB_PATH=/opt/trading-data/harvester.db node scripts/check_strategy_matrix_shadow.js
 */

import fs from 'fs';
import os from 'os';
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

const sourceDbPath = path.resolve(argValue('charon-db', process.env.DB_PATH || path.join(REPO_ROOT, 'charon.sqlite')));
if (!fs.existsSync(sourceDbPath)) throw new Error(`Charon DB not found: ${sourceDbPath}`);

const tempDbPath = path.join(os.tmpdir(), `charon-strategy-shadow-${Date.now()}.sqlite`);
fs.copyFileSync(sourceDbPath, tempDbPath);
process.env.DB_PATH = tempDbPath;
process.env.HARVESTER_DB_PATH = path.resolve(argValue(
  'harvester-db',
  process.env.HARVESTER_DB_PATH || path.join(REPO_ROOT, 'tools/wallet-harvester/data/harvester.db'),
));

const limit = argNumber('limit', 8);
const mint = argValue('mint', 'SHADOW_MINT_FOR_STRATEGY_MATRIX_CHECK');
process.env.CHARON_SHADOW_MINT = mint;

const [
  { initDb, db },
  { allStrategies, setActiveStrategy },
  { buildCandidate },
  { isKolLikeWallet, savedWallets },
] = await Promise.all([
  import('../src/db/connection.js'),
  import('../src/db/settings.js'),
  import('../src/pipeline/candidateBuilder.js'),
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

const strategies = allStrategies();
const results = [];

for (const strategy of strategies) {
  setActiveStrategy(strategy.id);
  const candidate = await buildCandidate({
    mint,
    route: `shadow_strategy_matrix_${strategy.id}`,
  });
  results.push({
    strategy_id: strategy.id,
    strategy_name: strategy.name,
    enabled_before_shadow: strategy.enabled,
    entry_mode: strategy.entry_mode,
    use_llm: strategy.use_llm,
    position_size_sol: strategy.position_size_sol,
    tp_percent: strategy.tp_percent,
    sl_percent: strategy.sl_percent,
    max_open_positions: strategy.max_open_positions,
    passed: candidate.filters.passed,
    failures: candidate.filters.failures,
    saved_wallet_holders: candidate.savedWalletExposure.holderCount,
    kol_holders: candidate.kolDumpRisk.kolHolders.length,
    market_cap_usd: candidate.metrics.marketCapUsd,
    holder_count: candidate.metrics.holderCount,
    distance_from_ath_percent: candidate.chart.distanceFromAthPercent,
  });
}

const createdAt = new Date().toISOString();
const stamp = createdAt.replace(/[:.]/g, '-');
fs.mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = path.join(REPORT_DIR, `strategy-matrix-shadow-${stamp}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify({
  created_at: createdAt,
  source_db_path: sourceDbPath,
  temp_db_path: tempDbPath,
  harvester_db_path: process.env.HARVESTER_DB_PATH,
  provider_stubs: true,
  saved_wallet_count: wallets.length,
  kol_like_saved_wallet_count: kolLike.length,
  selected_holder_count: selected.length,
  results,
}, null, 2)}\n`);

db.close();
fs.rmSync(tempDbPath, { force: true });

console.log(`Shadow strategy matrix report written: ${reportPath}`);
console.log(JSON.stringify({
  savedWalletCount: wallets.length,
  kolLikeSavedWalletCount: kolLike.length,
  selectedHolderCount: selected.length,
  strategies: results.map(result => ({
    id: result.strategy_id,
    passed: result.passed,
    failures: result.failures,
    positionSizeSol: result.position_size_sol,
    tpPercent: result.tp_percent,
    slPercent: result.sl_percent,
    useLlm: result.use_llm,
  })),
}, null, 2));
