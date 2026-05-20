// ---------------------------------------------------------------------------
// Wallet Harvester — Hypothesis Testing
//
// Runs H1-H6 from the spec against the accumulated SQLite data.
// Each hypothesis has a pass/fail determination with a numeric threshold.
// ---------------------------------------------------------------------------

import { HarvesterStore } from "./store.js";
import { loadConfig } from "./config.js";
import type { HypothesisResult } from "./types.js";
import pino from "pino";

const logger = pino({ name: "hypotheses" });

const MIN_SAMPLE_SIZE = 20;  // Minimum wallets/sightings to draw a conclusion

// ---------------------------------------------------------------------------
// H1: Recurrence Predicts Quality
// Wallets with token_count >= 3 should have 1.5x median PnL vs token_count < 3
// ---------------------------------------------------------------------------

function testH1(store: HarvesterStore): HypothesisResult {
  const highFreq = store.query<{ pnl_usd: number }>(
    `SELECT pnl_usd FROM wallets WHERE token_count >= 3 AND pnl_usd IS NOT NULL ORDER BY pnl_usd`,
  );
  const lowFreq = store.query<{ pnl_usd: number }>(
    `SELECT pnl_usd FROM wallets WHERE token_count < 3 AND pnl_usd IS NOT NULL ORDER BY pnl_usd`,
  );

  if (highFreq.length < MIN_SAMPLE_SIZE || lowFreq.length < MIN_SAMPLE_SIZE) {
    return {
      id: "H1", name: "Recurrence Predicts Quality",
      passed: null, metric: null, threshold: 1.5,
      sampleSize: highFreq.length + lowFreq.length,
      detail: `Insufficient data: ${highFreq.length} high-freq, ${lowFreq.length} low-freq (need ${MIN_SAMPLE_SIZE} each)`,
      testedAt: Date.now(),
    };
  }

  const medianHigh = median(highFreq.map(r => r.pnl_usd));
  const medianLow = median(lowFreq.map(r => r.pnl_usd));
  const ratio = medianLow !== 0 ? medianHigh / medianLow : Infinity;

  return {
    id: "H1", name: "Recurrence Predicts Quality",
    passed: ratio >= 1.5,
    metric: ratio,
    threshold: 1.5,
    sampleSize: highFreq.length + lowFreq.length,
    detail: `Median PnL: high-freq=$${medianHigh.toFixed(2)}, low-freq=$${medianLow.toFixed(2)}, ratio=${ratio.toFixed(2)}x (threshold: 1.5x)`,
    testedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// H2: Cross-Source Agreement
// At least 20% of GMGN smart_degen wallets should also appear in OKX SM data
// ---------------------------------------------------------------------------

function testH2(store: HarvesterStore): HypothesisResult {
  const gmgnSmart = store.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM wallets WHERE tags LIKE '%smart_degen%'`,
  );
  const dualSmart = store.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM wallets
     WHERE tags LIKE '%smart_degen%'
     AND (tags LIKE '%smart_money%' OR sources LIKE '%okx%')`,
  );

  const total = gmgnSmart[0]?.cnt ?? 0;
  const overlap = dualSmart[0]?.cnt ?? 0;

  if (total < MIN_SAMPLE_SIZE) {
    return {
      id: "H2", name: "Cross-Source Agreement",
      passed: null, metric: null, threshold: 0.2,
      sampleSize: total,
      detail: `Insufficient data: ${total} GMGN smart_degen wallets (need ${MIN_SAMPLE_SIZE})`,
      testedAt: Date.now(),
    };
  }

  const overlapRate = overlap / total;

  return {
    id: "H2", name: "Cross-Source Agreement",
    passed: overlapRate >= 0.2,
    metric: overlapRate,
    threshold: 0.2,
    sampleSize: total,
    detail: `${overlap}/${total} GMGN smart_degen wallets also seen in OKX (${(overlapRate * 100).toFixed(1)}%, threshold: 20%)`,
    testedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// H3: Dual-Source Wallets Outperform
// Dual-source wallets should have win_rate at least 5pp higher than single-source
// ---------------------------------------------------------------------------

function testH3(store: HarvesterStore): HypothesisResult {
  const dual = store.query<{ win_rate: number }>(
    `SELECT win_rate FROM wallets
     WHERE sources LIKE '%gmgn%' AND sources LIKE '%okx%'
     AND win_rate IS NOT NULL`,
  );
  const single = store.query<{ win_rate: number }>(
    `SELECT win_rate FROM wallets
     WHERE NOT (sources LIKE '%gmgn%' AND sources LIKE '%okx%')
     AND win_rate IS NOT NULL`,
  );

  if (dual.length < MIN_SAMPLE_SIZE || single.length < MIN_SAMPLE_SIZE) {
    return {
      id: "H3", name: "Dual-Source Wallets Outperform",
      passed: null, metric: null, threshold: 0.05,
      sampleSize: dual.length + single.length,
      detail: `Insufficient data: ${dual.length} dual-source, ${single.length} single-source (need ${MIN_SAMPLE_SIZE} each)`,
      testedAt: Date.now(),
    };
  }

  const avgDual = mean(dual.map(r => r.win_rate));
  const avgSingle = mean(single.map(r => r.win_rate));
  const delta = avgDual - avgSingle;

  return {
    id: "H3", name: "Dual-Source Wallets Outperform",
    passed: delta >= 0.05,
    metric: delta,
    threshold: 0.05,
    sampleSize: dual.length + single.length,
    detail: `Win rate: dual=${(avgDual * 100).toFixed(1)}%, single=${(avgSingle * 100).toFixed(1)}%, delta=${(delta * 100).toFixed(1)}pp (threshold: 5pp)`,
    testedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// H4: Copyable Edge Survives Delay
// This is a placeholder — full test requires price data at sighting_time + 30min
// which the harvester does not yet collect. Mark as "not testable" until Phase H4.
// ---------------------------------------------------------------------------

function testH4(_store: HarvesterStore): HypothesisResult {
  return {
    id: "H4", name: "Copyable Edge Survives Delay",
    passed: null, metric: null, threshold: 0.8,
    sampleSize: 0,
    detail: "Requires price-at-delay data (not yet collected). Testable after Phase H4 adds price snapshots.",
    testedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// H5: Power-Law Concentration
// Top 50 wallets by sighting frequency should account for >= 30% of all sightings
// ---------------------------------------------------------------------------

function testH5(store: HarvesterStore): HypothesisResult {
  const totalSightings = store.query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM sightings`,
  );
  const top50Sightings = store.query<{ cnt: number }>(
    `SELECT SUM(total_sightings) as cnt FROM (
      SELECT COUNT(*) as total_sightings
      FROM sightings
      GROUP BY wallet_address
      ORDER BY total_sightings DESC
      LIMIT 50
    )`,
  );

  const total = totalSightings[0]?.cnt ?? 0;
  const top50 = top50Sightings[0]?.cnt ?? 0;

  if (total < 100) {
    return {
      id: "H5", name: "Power-Law Concentration",
      passed: null, metric: null, threshold: 0.3,
      sampleSize: total,
      detail: `Insufficient data: ${total} total sightings (need at least 100)`,
      testedAt: Date.now(),
    };
  }

  const concentration = top50 / total;

  return {
    id: "H5", name: "Power-Law Concentration",
    passed: concentration >= 0.3,
    metric: concentration,
    threshold: 0.3,
    sampleSize: total,
    detail: `Top 50 wallets account for ${top50}/${total} sightings (${(concentration * 100).toFixed(1)}%, threshold: 30%)`,
    testedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// H6: KOL vs Smart Money Timing Divergence
// KOL wallets should enter at higher mcap than Smart Money wallets
// ---------------------------------------------------------------------------

function testH6(store: HarvesterStore): HypothesisResult {
  const kolEntries = store.query<{ token_mcap_usd: number }>(
    `SELECT token_mcap_usd FROM sightings
     WHERE action = 'buy'
     AND (signal_type LIKE '%renowned%' OR signal_type LIKE '%kol%')
     AND token_mcap_usd IS NOT NULL AND token_mcap_usd > 0`,
  );
  const smEntries = store.query<{ token_mcap_usd: number }>(
    `SELECT token_mcap_usd FROM sightings
     WHERE action = 'buy'
     AND (signal_type LIKE '%smart_degen%' OR signal_type LIKE '%smart_money%')
     AND token_mcap_usd IS NOT NULL AND token_mcap_usd > 0`,
  );

  if (kolEntries.length < MIN_SAMPLE_SIZE || smEntries.length < MIN_SAMPLE_SIZE) {
    return {
      id: "H6", name: "KOL vs Smart Money Timing Divergence",
      passed: null, metric: null, threshold: 1.0,
      sampleSize: kolEntries.length + smEntries.length,
      detail: `Insufficient data: ${kolEntries.length} KOL entries, ${smEntries.length} SM entries (need ${MIN_SAMPLE_SIZE} each)`,
      testedAt: Date.now(),
    };
  }

  const medianKolMcap = median(kolEntries.map(r => r.token_mcap_usd));
  const medianSmMcap = median(smEntries.map(r => r.token_mcap_usd));
  const ratio = medianSmMcap !== 0 ? medianKolMcap / medianSmMcap : Infinity;

  return {
    id: "H6", name: "KOL vs Smart Money Timing Divergence",
    passed: ratio > 1.0,
    metric: ratio,
    threshold: 1.0,
    sampleSize: kolEntries.length + smEntries.length,
    detail: `Median mcap at entry: KOL=$${fmt(medianKolMcap)}, SM=$${fmt(medianSmMcap)}, ratio=${ratio.toFixed(2)}x (KOLs enter later if >1.0x)`,
    testedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

// ---------------------------------------------------------------------------
// Main test runner
// ---------------------------------------------------------------------------

export function runAllHypotheses(store: HarvesterStore): HypothesisResult[] {
  return [
    testH1(store),
    testH2(store),
    testH3(store),
    testH4(store),
    testH5(store),
    testH6(store),
  ];
}

// ---------------------------------------------------------------------------
// CLI: npm run harvest:hypotheses
// ---------------------------------------------------------------------------

if (process.argv[1]?.endsWith("hypotheses.ts") || process.argv[1]?.endsWith("hypotheses.js")) {
  const cfg = loadConfig();
  const store = new HarvesterStore(cfg.dbPath);

  console.log("\n=== Wallet Harvester — Hypothesis Test Results ===\n");

  const results = runAllHypotheses(store);

  for (const r of results) {
    const icon = r.passed === true ? "PASS" : r.passed === false ? "FAIL" : "----";
    const metric = r.metric != null ? r.metric.toFixed(3) : "n/a";
    console.log(`[${icon}] ${r.id}: ${r.name}`);
    console.log(`       Metric: ${metric}  Threshold: ${r.threshold}  Sample: ${r.sampleSize}`);
    console.log(`       ${r.detail}`);
    console.log();
  }

  const passCount = results.filter(r => r.passed === true).length;
  const failCount = results.filter(r => r.passed === false).length;
  const pendingCount = results.filter(r => r.passed === null).length;

  console.log(`--- Summary: ${passCount} passed, ${failCount} failed, ${pendingCount} pending ---`);

  if (passCount >= 3 && failCount === 0) {
    console.log("\nRecommendation: Wallet Intelligence revisit trigger may be ready to fire.");
  } else if (failCount >= 3) {
    console.log("\nRecommendation: Current wallet data does not support Wallet Intelligence. Consider adjusting filters or extending harvest period.");
  } else {
    console.log("\nRecommendation: Continue harvesting. Re-run after more data accumulates.");
  }

  store.close();
}
