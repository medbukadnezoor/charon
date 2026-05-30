import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

process.env.CHARON_SKIP_DOTENV = 'true';
process.env.CHARON_PROVIDER_STUBS = 'true';
process.env.TELEGRAM_POLLING_ENABLED = 'false';
process.env.TELEGRAM_BOT_TOKEN = 'test:entry-watch';
process.env.TELEGRAM_CHAT_ID = '0';
process.env.HELIUS_API_KEY = 'test-helius';
process.env.GMGN_ENABLED = 'false';

const tempDir = mkdtempSync(path.join(tmpdir(), 'charon-entry-watch-'));
process.env.DB_PATH = path.join(tempDir, 'entry-watch.sqlite');

const { db, initDb } = await import('../src/db/connection.js');
const {
  activeEntryWatchCount,
  entryWatchBirdeyeCuUsedToday,
  getActiveEntryWatch,
  insertEntryWatch,
  listDueEntryWatches,
  markEntryWatchChecked,
  markEntryWatchStatus,
  reserveEntryWatchBirdeyeBudget,
} = await import('../src/db/entryWatch.js');
const { setSetting, updateStrategyConfig, strategyById } = await import('../src/db/settings.js');
const { isWatchableEntryReject } = await import('../src/analysis/ohlcvSignals.js');
const { computeWatchDipTrigger, evaluateWatchDipEligibility, watchDipExecutionOverrides } = await import('../src/analysis/watchDip.js');
const { fetchEntryWatchCandlesWithBudget } = await import('../src/enrichment/entryCandles.js');
const { shouldStartEntryWatch, shouldStartWatchDip } = await import('../src/pipeline/entryWatch.js');
const { shouldStartWatchDipForCurrentDecision } = await import('../src/pipeline/orchestrator.js');
const { bot } = await import('../src/telegram/bot.js');
const { validateDecisionAction, validateDecisionStage } = await import('../src/telemetry/laneTags.js');

after(async () => {
  await bot.stopPolling().catch(() => {});
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

test('initDb creates entry watch schema and default disabled config', () => {
  initDb();
  const columns = db.prepare('PRAGMA table_info(entry_watchlist)').all().map(row => row.name);
  assert.equal(columns.includes('original_candidate_id'), true);
  assert.equal(columns.includes('watch_type'), true);
  assert.equal(columns.includes('cohort'), true);
  assert.equal(columns.includes('last_error'), true);
  const sniper = strategyById('sniper');
  assert.equal(sniper.entry_watch_enabled, false);
  assert.equal(sniper.entry_watch_max_active, 10);
  assert.equal(sniper.llm_watch_dip_enabled, false);
  assert.equal(sniper.llm_watch_dip_position_size_sol, 0.03);
  assert.equal(sniper.llm_watch_dip_sl_percent, -60);
  assert.equal(sniper.llm_watch_dip_tp_percent, 300);
});

test('entry watch CRUD bounds active rows by status and expiry', () => {
  initDb();
  const dueAt = Date.now() - 1;
  const inserted = insertEntryWatch({
    mint: 'WatchMint11111111111111111111111111111111',
    strategyId: 'sniper',
    originalCandidateId: 10,
    originalRejectReason: 'rsi_overbought',
    nextCheckAtMs: dueAt,
    windowMs: 60_000,
    snapshot: { ok: true },
  });
  assert.equal(inserted.inserted, true);
  const duplicate = insertEntryWatch({
    mint: 'WatchMint11111111111111111111111111111111',
    strategyId: 'sniper',
    originalCandidateId: 11,
  });
  assert.equal(duplicate.inserted, false);
  assert.equal(activeEntryWatchCount(), 1);
  assert.equal(getActiveEntryWatch('WatchMint11111111111111111111111111111111', 'sniper').snapshot.ok, true);
  assert.equal(listDueEntryWatches({ limit: 5 }).length, 1);

  markEntryWatchChecked(inserted.id, {
    nextCheckAtMs: Date.now() + 60_000,
    reason: 'pullback_too_small',
    entryScore: 44,
    candleSource: 'pair_ohlcv',
    candleCount: 15,
  });
  assert.equal(listDueEntryWatches({ limit: 5 }).length, 0);

  markEntryWatchStatus(inserted.id, 'expired', { reason: 'test_expired' });
  assert.equal(activeEntryWatchCount(), 0);
});

test('entry watch Birdeye CU budget reserves and blocks at daily cap', () => {
  initDb();
  setSetting('entry_watch_birdeye_daily_cu_cap', '3');
  const first = reserveEntryWatchBirdeyeBudget({
    watchId: 1,
    mint: 'BudgetMint111111111111111111111111111111',
    estimatedCu: 3,
  });
  assert.equal(first.ok, true);
  assert.equal(entryWatchBirdeyeCuUsedToday(), 3);
  const second = reserveEntryWatchBirdeyeBudget({
    watchId: 2,
    mint: 'BudgetMint222222222222222222222222222222',
    estimatedCu: 1,
  });
  assert.equal(second.ok, false);
  const skipped = db.prepare("SELECT * FROM provider_call_ledger WHERE endpoint = 'entry_watch_budget' AND status = 'skipped' ORDER BY id DESC LIMIT 1").get();
  assert.equal(skipped.skip_reason, 'entry_watch_birdeye_daily_cu_cap_reached');
});

test('entry watch GMGN-first candles do not reserve Birdeye CU when sufficient', async () => {
  initDb();
  setSetting('gmgn_kline_enabled', 'true');
  setSetting('entry_watch_ohlcv_provider_order', 'gmgn,birdeye');
  setSetting('entry_watch_birdeye_daily_cu_cap', '1');
  process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT = '8';
  const before = entryWatchBirdeyeCuUsedToday();
  try {
    const result = await fetchEntryWatchCandlesWithBudget('WatchGmgnMint11111111111111111111111111111', {
      watchId: 77,
      interval: '1m',
      count: 15,
      minCandles: 5,
      atMs: 1_779_024_600_000,
    });
    assert.equal(result.budgetDeferred, false);
    assert.equal(result.ohlcv.provider, 'gmgn');
    assert.equal(result.ohlcv.gmgnKlineCount, 8);
    assert.equal(entryWatchBirdeyeCuUsedToday(), before);
  } finally {
    delete process.env.CHARON_PROVIDER_STUB_GMGN_KLINE_COUNT;
  }
});

test('entry watch starts only for enabled watchable timing rejects', () => {
  initDb();
  const sniper = strategyById('sniper');
  const timingReject = { confirm: false, reject_reason: 'rsi_overbought', score: 20 };
  const dataReject = { confirm: false, reject_reason: 'insufficient_candles', score: 0 };
  assert.equal(isWatchableEntryReject(timingReject), true);
  assert.equal(isWatchableEntryReject(dataReject), false);
  assert.equal(shouldStartEntryWatch(timingReject, sniper).start, false);
  updateStrategyConfig('sniper', { ...sniper, entry_watch_enabled: true, entry_watch_max_active: 10 });
  assert.equal(shouldStartEntryWatch(timingReject, strategyById('sniper')).start, true);
  assert.equal(shouldStartEntryWatch(dataReject, strategyById('sniper')).start, false);
});

test('entry watch lifecycle tags are accepted by telemetry validators', () => {
  assert.equal(validateDecisionStage('entry_confirmation'), 'entry_confirmation');
  for (const action of [
    'entry_rejected_ohlcv',
    'entry_watch_started',
    'entry_watch_checked',
    'entry_watch_triggered',
    'entry_watch_expired',
    'entry_watch_invalidated',
    'entry_watch_cancelled',
  ]) {
  assert.equal(validateDecisionAction(action), action);
  }
  for (const action of [
    'llm_watch_dip_not_started',
    'llm_watch_dip_started',
    'llm_watch_dip_checked',
    'llm_watch_dip_triggered',
  ]) {
    assert.equal(validateDecisionAction(action), action);
  }
});

function watchDipCandidate(overrides = {}) {
  return {
    token: { mint: 'WatchDipMint11111111111111111111111111111', symbol: 'WDIP' },
    metrics: {
      marketCapUsd: 18_000,
      priceUsd: 0.000018,
      liquidityUsd: 13_000,
      gmgnTotalFeesSol: 6,
    },
    chart: { distanceFromAthPercent: -45 },
    holders: { maxHolderPercent: 30, top20Percent: 70 },
    savedWalletExposure: { holderCount: 5 },
    signals: { route: 'dual_source', sourceCount: 2, sources: ['fee', 'trending'] },
    trending: { rug_ratio: 0.1, bundler_rate: 0.2, is_wash_trading: false },
    filters: { passed: true, strategy: 'sniper' },
    ...overrides,
  };
}

test('current WATCH decisions with passed filters start the watch-dip lane', () => {
  assert.equal(shouldStartWatchDipForCurrentDecision({ verdict: 'WATCH' }, { filters: { passed: true } }), true);
  assert.equal(shouldStartWatchDipForCurrentDecision({ verdict: 'PASS' }, { filters: { passed: true } }), false);
  assert.equal(shouldStartWatchDipForCurrentDecision({ verdict: 'WATCH' }, { filters: { passed: false } }), false);
});

test('watch-dip eligibility gates LLM WATCH rows and preserves sniper-style execution defaults', () => {
  initDb();
  const sniper = strategyById('sniper');
  const enabled = { ...sniper, llm_watch_dip_enabled: true };
  updateStrategyConfig('sniper', enabled);
  const decision = { verdict: 'WATCH', confidence: 61, reason: 'watch for dip' };
  const candidate = watchDipCandidate();

  const eligibility = evaluateWatchDipEligibility(candidate, decision, strategyById('sniper'));
  assert.equal(eligibility.eligible, true);
  assert.equal(eligibility.cohort, 'core');
  assert.equal(shouldStartWatchDip(candidate, decision, strategyById('sniper')).start, true);
  assert.deepEqual(watchDipExecutionOverrides(strategyById('sniper')), {
    suggested_position_size_sol: 0.03,
    suggested_sl_percent: -60,
    suggested_tp_percent: 300,
    suggested_trailing_enabled: true,
    suggested_trailing_arm_percent: 100,
    suggested_trailing_percent: 35,
    suggested_breakeven_after_profit_percent: 80,
    suggested_breakeven_lock_percent: 20,
  });

  assert.equal(evaluateWatchDipEligibility(watchDipCandidate({ holders: { maxHolderPercent: 46, top20Percent: 70 } }), decision, strategyById('sniper')).reason, 'max_holder_hard_reject');
  assert.equal(evaluateWatchDipEligibility(watchDipCandidate({ signals: { route: 'graduated_trending', sourceCount: 1 } }), decision, strategyById('sniper')).reason, 'route_not_dual_source');
  assert.equal(evaluateWatchDipEligibility(watchDipCandidate({ metrics: { ...candidate.metrics, marketCapUsd: 60_000 } }), decision, strategyById('sniper')).reason, 'mcap_out_of_range');
});

test('watch-dip trigger requires real pullback, reclaim, and anti-swing-high distance', () => {
  initDb();
  const strat = { ...strategyById('sniper'), llm_watch_dip_min_pullback_pct: 12, llm_watch_dip_max_pullback_pct: 45 };
  const watch = {
    original_mcap: 20_000,
    best_low_mcap: 14_000,
    original_price: null,
    best_low_price: null,
  };
  const candidate = watchDipCandidate({ metrics: { ...watchDipCandidate().metrics, marketCapUsd: 16_000, priceUsd: null } });
  const goodCandles = [
    { o: 0.00002, h: 0.000021, l: 0.000019, c: 0.0000195, v: 100 },
    { o: 0.000019, h: 0.0000192, l: 0.000015, c: 0.0000155, v: 120 },
    { o: 0.0000155, h: 0.000016, l: 0.000014, c: 0.0000145, v: 130 },
    { o: 0.0000145, h: 0.0000165, l: 0.0000142, c: 0.000016, v: 140 },
    { o: 0.000016, h: 0.000017, l: 0.0000158, c: 0.0000162, v: 150 },
  ];
  const good = computeWatchDipTrigger(watch, candidate, goodCandles, strat);
  assert.equal(good.trigger, true);

  const tooHigh = computeWatchDipTrigger(watch, watchDipCandidate({ metrics: { ...watchDipCandidate().metrics, marketCapUsd: 19_500, priceUsd: null } }), goodCandles, strat);
  assert.equal(tooHigh.trigger, false);
  assert.equal(tooHigh.reason, 'too_close_to_recent_high');

  const staircase = Array.from({ length: 6 }, (_, index) => {
    const base = 0.000014 + index * 0.000001;
    return { o: base, h: base * 1.03, l: base * 0.99, c: base * 1.02, v: 100 };
  });
  const stair = computeWatchDipTrigger(watch, candidate, staircase, strat);
  assert.equal(stair.trigger, false);
  assert.equal(stair.reason, 'staircase_without_pullback');
});
