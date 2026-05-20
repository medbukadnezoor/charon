// ---------------------------------------------------------------------------
// Wallet Harvester — Strategy Report Generator (S5)
//
// Generates 5 reports from wallet_strategies, positions, and trade_context.
// No external API calls — all data from local SQLite.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import type pino from "pino";
import type { HarvesterStore } from "./store.js";
import type { WalletStrategyRecord, PositionRecord, TradeContextRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Config / result types
// ---------------------------------------------------------------------------

export interface ReportConfig {
  outputDir: string;         // default: 'reports'
  targetMcapMaxUsd: number;  // default: 200000
  minPositionSample: number; // default: 5
}

export interface ReportResult {
  walletProfilesWritten: number;
  reportsWritten: string[];  // list of output file paths
  durationMs: number;
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  outputDir: "reports",
  targetMcapMaxUsd: 200_000,
  minPositionSample: 5,
};

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) {
    if (hours > 0) return `${days}d ${hours}h`;
    return `${days}d`;
  }
  if (hours > 0) {
    if (minutes > 0) return `${hours}h ${minutes}m`;
    return `${hours}h`;
  }
  return `${minutes}m`;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const frac = rank - lower;
  return sorted[lower]! + frac * (sorted[upper]! - sorted[lower]!);
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const escape = (v: unknown): string => {
    const str = v == null ? "" : String(v);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  const header = columns.join(",");
  const dataRows = rows.map(row =>
    columns.map(col => escape(row[col])).join(",")
  );
  return [header, ...dataRows].join("\n");
}

function round2(n: number | null | undefined): number | null {
  if (n == null) return null;
  return Math.round(n * 100) / 100;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function numericSummary(values: number[]): Record<string, number | null> {
  return {
    count: values.length,
    mean: round2(mean(values)),
    median: round2(median(values)),
    p25: round2(percentile(values, 25)),
    p75: round2(percentile(values, 75)),
    min: round2(values.length > 0 ? Math.min(...values) : null),
    max: round2(values.length > 0 ? Math.max(...values) : null),
  };
}

function bucketValue(
  value: number | null,
  buckets: Array<{ label: string; test: (v: number) => boolean }>,
): string {
  if (value == null || !Number.isFinite(value)) return "unknown";
  return buckets.find(b => b.test(value))?.label ?? "unknown";
}

function distribution(rows: string[]): Array<{ bucket: string; count: number; pct: number | null }> {
  const total = rows.length;
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row, (counts.get(row) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([bucket, count]) => ({
      bucket,
      count,
      pct: round2(total > 0 ? count / total * 100 : 0),
    }));
}

// ---------------------------------------------------------------------------
// Main report generator
// ---------------------------------------------------------------------------

export async function generateStrategyReports(
  cfg: ReportConfig,
  store: HarvesterStore,
  logger: pino.Logger,
): Promise<ReportResult> {
  const startMs = Date.now();

  // Ensure output directory exists
  if (!fs.existsSync(cfg.outputDir)) {
    fs.mkdirSync(cfg.outputDir, { recursive: true });
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const reportsWritten: string[] = [];

  // Load data
  const strategies = store.getAllWalletStrategies();
  const closedPositions = store.getClosedPositionsWithPnl();
  const entryContextPairs = store.getEntryTradeContextForPositions();

  logger.info(
    { strategies: strategies.length, closedPositions: closedPositions.length },
    "Loaded strategy data"
  );

  // Build bot wallet set for filtering
  const botWallets = new Set(
    strategies.filter(s => s.isLikelyBot === 1).map(s => s.walletAddress)
  );

  // -------------------------------------------------------------------------
  // Report 1: Per-wallet strategy cards (JSON + CSV)
  // -------------------------------------------------------------------------

  const walletCards = strategies
    .map(s => ({
      wallet_address: s.walletAddress,
      archetype: s.archetype,
      is_likely_bot: s.isLikelyBot,
      confidence: round2(s.confidence),
      win_rate: round2(s.winRate),
      avg_pnl_pct: round2(s.avgPnlPct),
      median_pnl_pct: round2(s.medianPnlPct),
      sharpe_like: round2(s.sharpeLike),
      median_tp_pct: round2(s.medianTpPct),
      median_sl_pct: round2(s.medianSlPct),
      median_hold_s: s.medianHoldS != null ? formatDuration(s.medianHoldS) : null,
      dca_pct: round2(s.dcaPct),
      single_entry_pct: round2(s.singleEntryPct),
      partial_tp_pct: round2(s.partialTpPct),
      total_positions: s.totalPositions,
      closed_positions: s.closedPositions,
      pct_under_200k: round2(s.pctUnder200k),
    }))
    .sort((a, b) => {
      // Bots at end, then sort by win_rate DESC, avg_pnl_pct DESC
      if (a.is_likely_bot !== b.is_likely_bot) return a.is_likely_bot - b.is_likely_bot;
      const wr = (b.win_rate ?? -Infinity) - (a.win_rate ?? -Infinity);
      if (wr !== 0) return wr;
      return (b.avg_pnl_pct ?? -Infinity) - (a.avg_pnl_pct ?? -Infinity);
    });

  const jsonPath1 = path.join(cfg.outputDir, `strategy-wallets-${ts}.json`);
  const csvPath1 = path.join(cfg.outputDir, `strategy-wallets-${ts}.csv`);

  fs.writeFileSync(jsonPath1, JSON.stringify(walletCards, null, 2), "utf-8");
  reportsWritten.push(jsonPath1);

  const csvColumns = [
    "wallet_address", "archetype", "is_likely_bot", "win_rate",
    "avg_pnl_pct", "median_tp_pct", "median_sl_pct", "median_hold_s",
    "total_positions", "pct_under_200k", "sharpe_like",
  ];
  fs.writeFileSync(csvPath1, toCsv(walletCards as Record<string, unknown>[], csvColumns), "utf-8");
  reportsWritten.push(csvPath1);

  logger.info({ count: walletCards.length }, "Report 1: wallet cards written");

  // -------------------------------------------------------------------------
  // Report 2: Aggregate strategy distribution
  // -------------------------------------------------------------------------

  const totalWallets = strategies.length;
  const botCount = strategies.filter(s => s.isLikelyBot === 1).length;
  const humanCount = totalWallets - botCount;

  const archetypeMap: Record<string, {
    count: number;
    winRates: number[];
    pnlPcts: number[];
  }> = {};

  for (const s of strategies) {
    if (!archetypeMap[s.archetype]) {
      archetypeMap[s.archetype] = { count: 0, winRates: [], pnlPcts: [] };
    }
    const entry = archetypeMap[s.archetype]!;
    entry.count++;
    if (s.winRate != null) entry.winRates.push(s.winRate);
    if (s.avgPnlPct != null) entry.pnlPcts.push(s.avgPnlPct);
  }

  const archetypeDistribution: Record<string, {
    count: number;
    pct: number;
    avgWinRate: number | null;
    avgPnlPct: number | null;
    medianTpPct: number | null;
    medianSlPct: number | null;
  }> = {};
  for (const [archetype, data] of Object.entries(archetypeMap)) {
    const group = strategies.filter(s => s.archetype === archetype);
    archetypeDistribution[archetype] = {
      count: data.count,
      pct: totalWallets > 0 ? round2(data.count / totalWallets * 100)! : 0,
      avgWinRate: round2(mean(data.winRates)),
      avgPnlPct: round2(mean(data.pnlPcts)),
      medianTpPct: round2(median(group.map(s => s.medianTpPct).filter((v): v is number => v != null))),
      medianSlPct: round2(median(group.map(s => s.medianSlPct).filter((v): v is number => v != null))),
    };
  }

  let singleEntryCount = 0, dcaCount = 0, scaleInCount = 0;
  let singleExitCount = 0, partialTpCount = 0;
  for (const s of strategies) {
    const dominant = getDominantEntryStyle(s);
    if (dominant === "singleEntry") singleEntryCount++;
    else if (dominant === "dca") dcaCount++;
    else scaleInCount++;

    const exitDominant = getDominantExitStyle(s);
    if (exitDominant === "partialTp") partialTpCount++;
    else singleExitCount++;
  }

  const dist2: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    totalWallets,
    botCount,
    humanCount,
    archetypeDistribution,
    profitableHumanWallets: strategies.filter(s =>
      s.isLikelyBot !== 1 && (s.avgPnlPct ?? 0) > 0 && s.closedPositions >= cfg.minPositionSample
    ).length,
    profitableHumanTpPct: numericSummary(strategies
      .filter(s => s.isLikelyBot !== 1 && (s.avgPnlPct ?? 0) > 0 && s.closedPositions >= cfg.minPositionSample)
      .map(s => s.medianTpPct)
      .filter((v): v is number => v != null)),
    profitableHumanSlPct: numericSummary(strategies
      .filter(s => s.isLikelyBot !== 1 && (s.avgPnlPct ?? 0) > 0 && s.closedPositions >= cfg.minPositionSample)
      .map(s => s.medianSlPct)
      .filter((v): v is number => v != null)),
    entryStyleDistribution: {
      singleEntry: { count: singleEntryCount, pct: round2(totalWallets > 0 ? singleEntryCount / totalWallets * 100 : 0) },
      dca: { count: dcaCount, pct: round2(totalWallets > 0 ? dcaCount / totalWallets * 100 : 0) },
      scaleIn: { count: scaleInCount, pct: round2(totalWallets > 0 ? scaleInCount / totalWallets * 100 : 0) },
    },
    exitStyleDistribution: {
      singleExit: { count: singleExitCount, pct: round2(totalWallets > 0 ? singleExitCount / totalWallets * 100 : 0) },
      partialTp: { count: partialTpCount, pct: round2(totalWallets > 0 ? partialTpCount / totalWallets * 100 : 0) },
    },
  };

  const jsonPath2 = path.join(cfg.outputDir, `strategy-distribution-${ts}.json`);
  fs.writeFileSync(jsonPath2, JSON.stringify(dist2, null, 2), "utf-8");
  reportsWritten.push(jsonPath2);

  logger.info("Report 2: distribution written");

  // -------------------------------------------------------------------------
  // Report 3: Optimal SL/TP analysis
  // -------------------------------------------------------------------------

  const filteredPositions = closedPositions.filter(p => {
    if (botWallets.has(p.walletAddress)) return false;
    // include if entry_mcap_usd is null OR < targetMcapMaxUsd
    if (p.entryMcapUsd != null && p.entryMcapUsd >= cfg.targetMcapMaxUsd) return false;
    return p.realizedPct != null;
  });

  const winners = filteredPositions.filter(p => (p.realizedPct ?? 0) > 0).map(p => p.realizedPct!);
  const losers = filteredPositions.filter(p => (p.realizedPct ?? 0) <= 0).map(p => p.realizedPct!);
  const trailingPositions = filteredPositions.filter(p => p.isTrailingLike === 1);
  const fixedExitPositions = filteredPositions.filter(p => p.isTrailingLike !== 1);
  const trailingPcts = trailingPositions.map(p => p.realizedPct).filter((v): v is number => v != null);
  const fixedExitPcts = fixedExitPositions.map(p => p.realizedPct).filter((v): v is number => v != null);
  const trailingWalletDrops = strategies
    .filter(s => s.isLikelyBot !== 1 && s.trailingDetected === 1)
    .map(s => s.trailingDropPct)
    .filter((v): v is number => v != null);

  const buckets = [
    { label: "[-100,-50)", min: -100, max: -50 },
    { label: "[-50,-20)", min: -50, max: -20 },
    { label: "[-20,-5)", min: -20, max: -5 },
    { label: "[-5,0)", min: -5, max: 0 },
    { label: "(0,20]", min: 0, max: 20 },
    { label: "(20,50]", min: 20, max: 50 },
    { label: "(50,100]", min: 50, max: 100 },
    { label: "(100,200]", min: 100, max: 200 },
    { label: "(200,+)", min: 200, max: Infinity },
  ];

  const allPcts = filteredPositions.map(p => p.realizedPct!);
  const pnlHistogram = buckets.map(b => {
    const count = allPcts.filter(v => {
      if (b.max === Infinity) return v > b.min;
      if (b.min === -100) return v >= b.min && v < b.max;
      if (b.min <= 0 && b.max <= 0) return v >= b.min && v < b.max;
      return v > b.min && v <= b.max;
    }).length;
    return {
      bucket: b.label,
      count,
      pct: round2(filteredPositions.length > 0 ? count / filteredPositions.length * 100 : 0),
    };
  });

  const report3: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    targetMcapMaxUsd: cfg.targetMcapMaxUsd,
    positionsAnalyzed: filteredPositions.length,
    winRate: round2(filteredPositions.length > 0 ? winners.length / filteredPositions.length : null),
    suggestedTpPct: round2(percentile(winners, 75)),
    suggestedSlPct: round2(percentile(losers, 25)),
    medianWinnerTp: round2(median(winners)),
    medianLoserSl: round2(median(losers)),
    winnerTpPct: numericSummary(winners),
    loserSlPct: numericSummary(losers),
    fixedVsTrailing: {
      trailing: {
        positions: trailingPositions.length,
        pnlPct: numericSummary(trailingPcts),
      },
      fixed: {
        positions: fixedExitPositions.length,
        pnlPct: numericSummary(fixedExitPcts),
      },
      trailingAvgAdvantagePct: round2(
        mean(trailingPcts) != null && mean(fixedExitPcts) != null
          ? mean(trailingPcts)! - mean(fixedExitPcts)!
          : null
      ),
    },
    commonTrailingDropPct: numericSummary(trailingWalletDrops),
    suggestedCharonDefaults: {
      takeProfitPct: {
        value: round2(percentile(winners, 75)),
        confidenceInterval: {
          low: round2(percentile(winners, 25)),
          high: round2(percentile(winners, 75)),
        },
      },
      stopLossPct: {
        value: round2(percentile(losers, 25)),
        confidenceInterval: {
          low: round2(percentile(losers, 25)),
          high: round2(percentile(losers, 75)),
        },
      },
      trailingDropPct: {
        value: round2(median(trailingWalletDrops)),
        confidenceInterval: {
          low: round2(percentile(trailingWalletDrops, 25)),
          high: round2(percentile(trailingWalletDrops, 75)),
        },
      },
      sampleSize: filteredPositions.length,
    },
    pnlHistogram,
  };

  const jsonPath3 = path.join(cfg.outputDir, `strategy-optimal-sltp-${ts}.json`);
  fs.writeFileSync(jsonPath3, JSON.stringify(report3, null, 2), "utf-8");
  reportsWritten.push(jsonPath3);

  logger.info({ positionsAnalyzed: filteredPositions.length }, "Report 3: optimal SL/TP written");

  // -------------------------------------------------------------------------
  // Report 4: Entry indicator analysis
  // -------------------------------------------------------------------------

  // Build position outcome map: position id -> winner/loser
  const positionOutcomes = new Map<number, "winner" | "loser">();
  for (const p of closedPositions) {
    if (p.id == null || botWallets.has(p.walletAddress)) continue;
    positionOutcomes.set(p.id, (p.realizedPct ?? 0) > 0 ? "winner" : "loser");
  }

  const winnerContexts: TradeContextRecord[] = [];
  const loserContexts: TradeContextRecord[] = [];

  for (const { position, context } of entryContextPairs) {
    if (context == null || position.id == null) continue;
    const outcome = positionOutcomes.get(position.id);
    if (outcome == null) continue;
    if (outcome === "winner") winnerContexts.push(context);
    else loserContexts.push(context);
  }

  const tradesAnalyzed = winnerContexts.length + loserContexts.length;

  const extractNums = (ctxs: TradeContextRecord[], field: keyof TradeContextRecord): number[] =>
    ctxs.map(c => c[field] as number | null).filter((v): v is number => v != null);

  const rsiInsight = buildInsight(
    "rsi_14",
    extractNums(winnerContexts, "rsi14"),
    extractNums(loserContexts, "rsi14"),
    (wMean, lMean) => {
      const diff = Math.abs(wMean - lMean) / (Math.abs(lMean) || 1) * 100;
      if (diff < 10) return "No significant RSI difference between winners and losers";
      if (wMean < lMean) return `Winners enter at lower RSI (${round2(wMean)} vs ${round2(lMean)})`;
      return `Losers enter at lower RSI (${round2(lMean)} vs ${round2(wMean)} for winners)`;
    }
  );

  const bbInsight = buildInsight(
    "bb_position",
    extractNums(winnerContexts, "bbPosition"),
    extractNums(loserContexts, "bbPosition"),
    (wMean, lMean) => {
      const diff = Math.abs(wMean - lMean) / (Math.abs(lMean) || 1) * 100;
      if (diff < 10) return "No significant BB position difference";
      if (wMean < lMean) return `Winners enter closer to lower BB band (${round2(wMean)} vs ${round2(lMean)})`;
      return `Losers enter closer to lower BB band (${round2(lMean)} vs ${round2(wMean)} for winners)`;
    }
  );

  const volInsight = buildInsight(
    "volume_ratio",
    extractNums(winnerContexts, "volumeRatio"),
    extractNums(loserContexts, "volumeRatio"),
    (wMean, lMean) => {
      const diff = Math.abs(wMean - lMean) / (Math.abs(lMean) || 1) * 100;
      if (diff < 10) return "No significant volume ratio difference";
      if (wMean > lMean) return `Winners enter on higher volume spikes (${round2(wMean)}x vs ${round2(lMean)}x avg)`;
      return `Losers enter on higher volume spikes (${round2(lMean)}x vs ${round2(wMean)}x for winners)`;
    }
  );

  // EMA trend distribution
  const countEmaTrend = (ctxs: TradeContextRecord[], trend: string): number =>
    ctxs.filter(c => c.emaTrend === trend).length;

  const wBullish = winnerContexts.length > 0 ? round2(countEmaTrend(winnerContexts, "bullish") / winnerContexts.length * 100)! : 0;
  const wBearish = winnerContexts.length > 0 ? round2(countEmaTrend(winnerContexts, "bearish") / winnerContexts.length * 100)! : 0;
  const wCrossing = winnerContexts.length > 0 ? round2(countEmaTrend(winnerContexts, "crossing") / winnerContexts.length * 100)! : 0;
  const lBullish = loserContexts.length > 0 ? round2(countEmaTrend(loserContexts, "bullish") / loserContexts.length * 100)! : 0;
  const lBearish = loserContexts.length > 0 ? round2(countEmaTrend(loserContexts, "bearish") / loserContexts.length * 100)! : 0;
  const lCrossing = loserContexts.length > 0 ? round2(countEmaTrend(loserContexts, "crossing") / loserContexts.length * 100)! : 0;

  const emaDiff = Math.abs(wBullish - lBullish);
  const emaInsight = emaDiff < 10
    ? "No significant EMA trend difference between winners and losers"
    : `Winners more likely to enter in bullish EMA trend (${wBullish}% vs ${lBullish}%)`;

  const indicatorBuckets = {
    rsiRange: {
      winners: distribution(winnerContexts.map(c => bucketValue(c.rsi14, [
        { label: "oversold_lt_30", test: v => v < 30 },
        { label: "neutral_30_70", test: v => v >= 30 && v <= 70 },
        { label: "overbought_gt_70", test: v => v > 70 },
      ]))),
      losers: distribution(loserContexts.map(c => bucketValue(c.rsi14, [
        { label: "oversold_lt_30", test: v => v < 30 },
        { label: "neutral_30_70", test: v => v >= 30 && v <= 70 },
        { label: "overbought_gt_70", test: v => v > 70 },
      ]))),
    },
    volumeRatio: {
      winners: distribution(winnerContexts.map(c => bucketValue(c.volumeRatio, [
        { label: "low_lt_1x", test: v => v < 1 },
        { label: "normal_1_2x", test: v => v >= 1 && v < 2 },
        { label: "spike_2_5x", test: v => v >= 2 && v < 5 },
        { label: "extreme_gt_5x", test: v => v >= 5 },
      ]))),
      losers: distribution(loserContexts.map(c => bucketValue(c.volumeRatio, [
        { label: "low_lt_1x", test: v => v < 1 },
        { label: "normal_1_2x", test: v => v >= 1 && v < 2 },
        { label: "spike_2_5x", test: v => v >= 2 && v < 5 },
        { label: "extreme_gt_5x", test: v => v >= 5 },
      ]))),
    },
    bbPosition: {
      winners: distribution(winnerContexts.map(c => bucketValue(c.bbPosition, [
        { label: "lower_band_0_0.33", test: v => v < 0.33 },
        { label: "middle_0.33_0.66", test: v => v >= 0.33 && v <= 0.66 },
        { label: "upper_band_gt_0.66", test: v => v > 0.66 },
      ]))),
      losers: distribution(loserContexts.map(c => bucketValue(c.bbPosition, [
        { label: "lower_band_0_0.33", test: v => v < 0.33 },
        { label: "middle_0.33_0.66", test: v => v >= 0.33 && v <= 0.66 },
        { label: "upper_band_gt_0.66", test: v => v > 0.66 },
      ]))),
    },
  };

  const report4: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    tradesAnalyzed,
    indicators: {
      rsi_14: rsiInsight,
      bb_position: bbInsight,
      volume_ratio: volInsight,
      ema_trend: {
        winners: { bullish_pct: wBullish, bearish_pct: wBearish, crossing_pct: wCrossing },
        losers: { bullish_pct: lBullish, bearish_pct: lBearish, crossing_pct: lCrossing },
        insight: emaInsight,
      },
    },
    conditionDistributions: indicatorBuckets,
  };

  const jsonPath4 = path.join(cfg.outputDir, `strategy-indicators-${ts}.json`);
  fs.writeFileSync(jsonPath4, JSON.stringify(report4, null, 2), "utf-8");
  reportsWritten.push(jsonPath4);

  logger.info({ tradesAnalyzed }, "Report 4: indicator analysis written");

  // -------------------------------------------------------------------------
  // Report 5: Anomaly report
  // -------------------------------------------------------------------------

  const anomalies: Array<Record<string, unknown>> = [];

  for (const s of strategies) {
    const flags: string[] = [];

    // 1. Outlier performance
    if ((s.winRate ?? 0) > 0.9 && s.totalPositions >= 5) {
      flags.push("outlier_performance");
    }
    // 2. Extreme loss takers
    if ((s.avgPnlPct ?? 0) < -50 && s.closedPositions >= 3) {
      flags.push("extreme_loss");
    }
    // 3. Inconsistent archetype
    if (s.isLikelyBot === 1 && s.archetype !== "sniper_bot") {
      flags.push("inconsistent_archetype");
    }
    // 4. High confidence bot
    if (s.confidence > 0.8) {
      flags.push("high_confidence_bot");
    }
    if (s.archetype === "unknown" || s.confidence < 0.25) {
      flags.push("unclassified_low_confidence");
    }

    if (flags.length > 0) {
      const noteFragments: string[] = [];
      if (flags.includes("outlier_performance")) {
        noteFragments.push(`Win rate ${round2(s.winRate)} across ${s.totalPositions} positions — review for wash trading`);
      }
      if (flags.includes("extreme_loss")) {
        noteFragments.push(`Avg PnL ${round2(s.avgPnlPct)}% across ${s.closedPositions} closed positions`);
      }
      if (flags.includes("inconsistent_archetype")) {
        noteFragments.push(`Bot flag set but archetype is '${s.archetype}'`);
      }
      if (flags.includes("high_confidence_bot")) {
        noteFragments.push(`High bot confidence: ${round2(s.confidence)}`);
      }
      if (flags.includes("unclassified_low_confidence")) {
        noteFragments.push(`Low-confidence archetype assignment: '${s.archetype}' at ${round2(s.confidence)}`);
      }

      anomalies.push({
        wallet_address: s.walletAddress,
        flags,
        archetype: s.archetype,
        win_rate: round2(s.winRate),
        avg_pnl_pct: round2(s.avgPnlPct),
        confidence: round2(s.confidence),
        note: noteFragments.join("; "),
      });
    }
  }

  const copyTradingGroups = detectCopyTradingGroups(closedPositions, botWallets);
  for (const group of copyTradingGroups) {
    anomalies.push({
      wallet_address: group.wallets.join("|"),
      flags: ["copy_trading_cluster"],
      archetype: "multi_wallet_cluster",
      win_rate: null,
      avg_pnl_pct: null,
      confidence: null,
      note: `${group.wallets.length} wallets entered ${group.mint} within ${group.windowS}s`,
      mint: group.mint,
      first_entry_ts: group.firstEntryTs,
      window_s: group.windowS,
      position_count: group.positionCount,
    });
  }

  const report5: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    anomalies,
    copyTradingClusters: copyTradingGroups,
  };

  const jsonPath5 = path.join(cfg.outputDir, `strategy-anomalies-${ts}.json`);
  fs.writeFileSync(jsonPath5, JSON.stringify(report5, null, 2), "utf-8");
  reportsWritten.push(jsonPath5);

  logger.info({ anomalies: anomalies.length }, "Report 5: anomaly report written");

  return {
    walletProfilesWritten: walletCards.length,
    reportsWritten,
    durationMs: Date.now() - startMs,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getDominantEntryStyle(s: WalletStrategyRecord): "singleEntry" | "dca" | "scaleIn" {
  const single = s.singleEntryPct ?? 0;
  const dca = s.dcaPct ?? 0;
  const scaleIn = s.scaleInPct ?? 0;
  if (single >= dca && single >= scaleIn) return "singleEntry";
  if (dca >= scaleIn) return "dca";
  return "scaleIn";
}

function getDominantExitStyle(s: WalletStrategyRecord): "singleExit" | "partialTp" {
  return (s.partialTpPct ?? 0) > (s.singleExitPct ?? 0) ? "partialTp" : "singleExit";
}

function buildInsight(
  _field: string,
  winnerValues: number[],
  loserValues: number[],
  buildText: (wMean: number, lMean: number) => string,
): Record<string, unknown> {
  const wMeanVal = mean(winnerValues);
  const lMeanVal = mean(loserValues);
  const wMedianVal = median(winnerValues);
  const lMedianVal = median(loserValues);

  const insight =
    wMeanVal != null && lMeanVal != null
      ? buildText(wMeanVal, lMeanVal)
      : "Insufficient data for comparison";

  return {
    winners: { mean: round2(wMeanVal), median: round2(wMedianVal) },
    losers: { mean: round2(lMeanVal), median: round2(lMedianVal) },
    insight,
  };
}

function detectCopyTradingGroups(
  positions: PositionRecord[],
  botWallets: Set<string>,
): Array<{
  mint: string;
  wallets: string[];
  firstEntryTs: number;
  windowS: number;
  positionCount: number;
}> {
  const byMint = new Map<string, PositionRecord[]>();
  for (const pos of positions) {
    if (botWallets.has(pos.walletAddress)) continue;
    const rows = byMint.get(pos.mint) ?? [];
    rows.push(pos);
    byMint.set(pos.mint, rows);
  }

  const clusters: Array<{
    mint: string;
    wallets: string[];
    firstEntryTs: number;
    windowS: number;
    positionCount: number;
  }> = [];

  for (const [mint, rows] of byMint.entries()) {
    const sorted = [...rows].sort((a, b) => a.firstEntryTs - b.firstEntryTs);
    for (let start = 0; start < sorted.length; start++) {
      const cluster = [sorted[start]!];
      for (let i = start + 1; i < sorted.length; i++) {
        if (sorted[i]!.firstEntryTs - sorted[start]!.firstEntryTs > 10) break;
        cluster.push(sorted[i]!);
      }

      const wallets = [...new Set(cluster.map(p => p.walletAddress))];
      if (wallets.length < 2) continue;

      clusters.push({
        mint,
        wallets,
        firstEntryTs: cluster[0]!.firstEntryTs,
        windowS: cluster[cluster.length - 1]!.firstEntryTs - cluster[0]!.firstEntryTs,
        positionCount: cluster.length,
      });
      break;
    }
  }

  return clusters.sort((a, b) => b.wallets.length - a.wallets.length || a.mint.localeCompare(b.mint));
}
