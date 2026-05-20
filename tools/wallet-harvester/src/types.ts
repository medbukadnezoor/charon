// ---------------------------------------------------------------------------
// Wallet Harvester — Shared Type Definitions
// ---------------------------------------------------------------------------

/** Provider source identifier */
export type Source = "gmgn" | "okx";

/** Wallet classification tag (union across providers) */
export type WalletTag =
  | "smart_degen"       // GMGN smart money
  | "renowned"          // GMGN KOL
  | "kol"               // OKX KOL (walletType=1)
  | "smart_money"       // OKX Smart Money (walletType=3)
  | "whale"             // OKX Whale (walletType=4)
  | "pump_smart_money"  // OKX Pump Smart Money (walletType=10)
  | "sniper"            // GMGN sniper tag
  | "dev"               // GMGN dev tag
  | "fresh_wallet"      // GMGN fresh wallet
  | "bundler"           // GMGN bundler
  | string;             // future tags

/** Action observed in a sighting */
export type SightingAction = "buy" | "sell" | "hold";

// ---------------------------------------------------------------------------
// Discovery types
// ---------------------------------------------------------------------------

/** A token discovered during the discovery phase */
export interface DiscoveredToken {
  mint: string;
  symbol: string;
  name: string;
  chain: string;
  marketCapUsd: number;
  volume24hUsd: number;
  holderCount: number;
  smartWalletCount: number;
  kolCount: number;
  createdAt: number;                // Unix ms
  discoverySource: Source | "both";
  discoveryMethod: string;          // "trending" | "trenches" | "signal"
}

// ---------------------------------------------------------------------------
// Extraction types
// ---------------------------------------------------------------------------

/** A wallet extracted from a provider for a specific token */
export interface ExtractedWallet {
  address: string;
  source: Source;
  tags: WalletTag[];
  walletLabel?: string | null;
  twitterUsername?: string | null;
  twitterName?: string | null;
  avatarUrl?: string | null;
  providerTags?: string[];
  tokenTags?: string[];
  metadataSnapshotAt?: number | null;
  pnlUsd: number | null;
  winRate: number | null;
  avgBuyUsd: number | null;
  /** The token this wallet was seen on (context for the sighting) */
  mint: string;
  /** What the wallet did */
  action: SightingAction;
  amountUsd: number | null;
  tokenMcapUsd: number | null;
  timestamp: number;                // Unix ms
  signalType: string | null;        // e.g. "smart_degen_buy", "kol_sell"
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

/** Wallet record as stored in SQLite */
export interface WalletRecord {
  address: string;
  sources: Source[];
  tags: WalletTag[];
  walletLabel: string | null;
  twitterUsername: string | null;
  twitterName: string | null;
  avatarUrl: string | null;
  providerTags: string[];
  tokenTags: string[];
  metadataSnapshotAt: number | null;
  firstSeen: number;
  lastSeen: number;
  tokenCount: number;
  pnlUsd: number | null;
  winRate: number | null;
  avgBuyUsd: number | null;
  pnlSnapshotAt: number | null;
}

/** Sighting record as stored in SQLite */
export interface SightingRecord {
  id?: number;
  walletAddress: string;
  mint: string;
  action: SightingAction;
  amountUsd: number | null;
  tokenMcapUsd: number | null;
  timestamp: number;
  source: Source;
  signalType: string | null;
  runId: string;
}

/** Token record as stored in SQLite */
export interface TokenRecord {
  mint: string;
  symbol: string | null;
  name: string | null;
  mcapAtHarvest: number | null;
  volume24hUsd: number | null;
  holderCount: number | null;
  smartWalletCount: number | null;
  kolCount: number | null;
  createdAt: number | null;
  firstHarvestedAt: number;
  lastHarvestedAt: number;
}

/** Run record as stored in SQLite */
export interface RunRecord {
  runId: string;
  startedAt: number;
  finishedAt: number | null;
  tokensDiscovered: number;
  tokensHarvested: number;
  walletsNew: number;
  walletsUpdated: number;
  sightingsAdded: number;
  errors: string[];
  status: "running" | "completed" | "failed";
}

/** Provider-level metrics captured for a run */
export interface ProviderRunMetric {
  runId: string;
  provider: Source;
  callsUsed: number;
  rateLimitHits: number;
  stoppedEarly: boolean;
  walletsExtracted: number;
  sightingsExtracted: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Trade history types
// ---------------------------------------------------------------------------

/** A single swap trade record collected from Helius Enhanced Transactions API */
export interface TradeRecord {
  walletAddress: string;
  signature: string;
  mint: string;
  side: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  usdAmount: number | null;
  priceUsd: number | null;
  priceSol: number | null;
  timestamp: number;
  program: string | null;
  slot: number | null;
  rawJson: string | null;
  collectedAtMs: number;
}

// ---------------------------------------------------------------------------
// Position types
// ---------------------------------------------------------------------------

/** A reconstructed position record built from trade history */
export interface PositionRecord {
  id?: number;
  walletAddress: string;
  mint: string;
  status: 'open' | 'closed';
  entryCount: number;
  firstEntryTs: number;
  lastEntryTs: number;
  avgEntryPrice: number | null;
  totalSolIn: number;
  totalTokenIn: number;
  entryMcapUsd: number | null;
  exitCount: number;
  firstExitTs: number | null;
  lastExitTs: number | null;
  avgExitPrice: number | null;
  totalSolOut: number;
  totalTokenOut: number;
  realizedSol: number | null;
  realizedUsd: number | null;
  realizedPct: number | null;
  holdDurationS: number | null;
  entrySpreadS: number;
  exitSpreadS: number | null;
  isDca: number;
  isScaleIn: number;
  isPartialTp: number;
  isFullExit: number;
  isTrailingLike: number;
  tradeIdsJson: string;
  builtAtMs: number;
}

// ---------------------------------------------------------------------------
// Trade context types (S3)
// ---------------------------------------------------------------------------

/** OHLCV + indicator context enriched for each trade */
export interface TradeContextRecord {
  id?: number;
  tradeId: number;
  positionId: number | null;
  mint: string;
  candleOpen: number | null;
  candleHigh: number | null;
  candleLow: number | null;
  candleClose: number | null;
  candleVolume: number | null;
  rsi14: number | null;
  vwap: number | null;
  bbUpper: number | null;
  bbMiddle: number | null;
  bbLower: number | null;
  bbPosition: number | null;
  volumeRatio: number | null;
  ema9: number | null;
  ema21: number | null;
  emaTrend: string | null;
  distanceFromHighPct: number | null;
  distanceFromLowPct: number | null;
  atr14: number | null;
  momentum5: number | null;
  momentum15: number | null;
  momentum60: number | null;
  timeframe: string;
  candlesUsed: number | null;
  computedAtMs: number;
}

// ---------------------------------------------------------------------------
// Strategy classifier types (S4)
// ---------------------------------------------------------------------------

export interface WalletStrategyRecord {
  walletAddress: string;
  totalPositions: number;
  closedPositions: number;
  openPositions: number;
  singleEntryPct: number | null;
  dcaPct: number | null;
  scaleInPct: number | null;
  avgEntriesPerPos: number | null;
  singleExitPct: number | null;
  partialTpPct: number | null;
  trailingExitPct: number | null;
  avgExitsPerPos: number | null;
  medianTpPct: number | null;
  p25TpPct: number | null;
  p75TpPct: number | null;
  medianSlPct: number | null;
  p25SlPct: number | null;
  p75SlPct: number | null;
  trailingDetected: number;
  trailingDropPct: number | null;
  medianHoldS: number | null;
  avgHoldS: number | null;
  medianEntryHour: number | null;
  medianEntryMcap: number | null;
  avgEntryMcap: number | null;
  pctUnder200k: number | null;
  winRate: number | null;
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  sharpeLike: number | null;
  archetype: string;
  isLikelyBot: number;
  confidence: number;
  analyzedAtMs: number;
  analysisVersion: number;
}

// ---------------------------------------------------------------------------
// Hypothesis types
// ---------------------------------------------------------------------------

export interface HypothesisResult {
  id: string;                       // H1, H2, etc.
  name: string;
  passed: boolean | null;           // null = insufficient data
  metric: number | null;
  threshold: number;
  sampleSize: number;
  detail: string;
  testedAt: number;
}
