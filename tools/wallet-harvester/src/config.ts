// ---------------------------------------------------------------------------
// Wallet Harvester — Configuration
// ---------------------------------------------------------------------------

import { config as loadDotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");

// Load only the harvester-local env file. The harvester is intentionally
// isolated from parent app runtime .env files so it cannot read wallet material.
loadDotenv({ path: path.resolve(PROJECT_ROOT, ".env") });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envString(key: string, fallback: string): string {
  return process.env[key]?.trim() || fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1";
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface HarvesterConfig {
  // Discovery filters (mcap is data enrichment, not a filter)
  maxTokenAgeDays: number;
  maxTokensPerRun: number;
  trendingIntervals: string[];

  // Extraction
  gmgnHolderLimit: number;
  gmgnTraderLimit: number;
  gmgnTags: string[];

  // Rate limiting
  gmgnMinIntervalMs: number;
  okxMinIntervalMs: number;
  gmgnDailyCallCap: number;
  okxDailyCallCap: number;
  okxMaxCallsPerRun: number;

  // Schedule
  runIntervalHours: number;

  // Storage
  dbPath: string;
  reportDir: string;

  // Provider credentials
  gmgnApiKey: string;
  gmgnBaseUrl: string;
  okxApiKey: string;
  okxSecretKey: string;
  okxPassphrase: string;
  okxProjectId: string;
  okxBaseUrl: string;

  // Helius / trade history
  heliusApiKey: string;
  heliusBaseUrl: string;
  tradeHistoryLookbackDays: number;
  tradeHistoryRateLimitMs: number;

  // Birdeye / trade context (S3)
  birdeyeApiKey: string;
  birdeyeBaseUrl: string;
  birdeyeDailyCuCap: number;

  // Flags
  discoverOnly: boolean;
  enableFullRun: boolean;
  enableOkxExtraction: boolean;
  verbose: boolean;
}

export function loadConfig(): HarvesterConfig {
  return {
    // Discovery (mcap is data enrichment, not a filter)
    maxTokenAgeDays: envInt("HARVESTER_MAX_TOKEN_AGE_DAYS", 30),
    maxTokensPerRun: envInt("HARVESTER_MAX_TOKENS_PER_RUN", 30),
    trendingIntervals: (envString("HARVESTER_TRENDING_INTERVALS", "1h,6h,24h")).split(","),

    // Extraction
    gmgnHolderLimit: envInt("HARVESTER_GMGN_HOLDER_LIMIT", 50),
    gmgnTraderLimit: envInt("HARVESTER_GMGN_TRADER_LIMIT", 50),
    gmgnTags: (envString("HARVESTER_GMGN_TAGS", "smart_degen,renowned")).split(","),

    // Rate limiting
    gmgnMinIntervalMs: envInt("HARVESTER_GMGN_MIN_INTERVAL_MS", 500),
    okxMinIntervalMs: envInt("HARVESTER_OKX_MIN_INTERVAL_MS", 1200),
    gmgnDailyCallCap: envInt("HARVESTER_GMGN_DAILY_CAP", 2000),
    okxDailyCallCap: envInt("HARVESTER_OKX_DAILY_CAP", 500),
    okxMaxCallsPerRun: envInt("HARVESTER_OKX_MAX_CALLS_PER_RUN", 55),

    // Schedule
    runIntervalHours: envInt("HARVESTER_RUN_INTERVAL_HOURS", 4),

    // Storage
    dbPath: envString("HARVESTER_DB_PATH", path.resolve(PROJECT_ROOT, "data", "harvester.db")),
    reportDir: envString("HARVESTER_REPORT_DIR", path.resolve(PROJECT_ROOT, "reports")),

    // Helius / trade history
    heliusApiKey: envString("HELIUS_API_KEY", ""),
    heliusBaseUrl: envString("HELIUS_BASE_URL", "https://api.helius.xyz"),
    tradeHistoryLookbackDays: envInt("TRADE_HISTORY_LOOKBACK_DAYS", 30),
    tradeHistoryRateLimitMs: envInt("TRADE_HISTORY_RATE_LIMIT_MS", 500),

    // Birdeye / trade context (S3)
    birdeyeApiKey: envString("BIRDEYE_API_KEY", ""),
    birdeyeBaseUrl: envString("BIRDEYE_BASE_URL", "https://public-api.birdeye.so"),
    birdeyeDailyCuCap: envInt("BIRDEYE_DAILY_CU_CAP", 100000),

    // Provider credentials (read from tools/wallet-harvester/.env only)
    gmgnApiKey: envString("GMGN_API_KEY", ""),
    gmgnBaseUrl: envString("GMGN_HOST", "https://openapi.gmgn.ai"),
    okxApiKey: envString("OKX_API_KEY", ""),
    okxSecretKey: envString("OKX_SECRET_KEY", ""),
    okxPassphrase: envString("OKX_PASSPHRASE", ""),
    okxProjectId: envString("OKX_PROJECT_ID", ""),
    okxBaseUrl: envString("OKX_BASE_URL", "https://web3.okx.com"),

    // Flags
    discoverOnly: process.argv.includes("--discover-only"),
    enableFullRun: envBool("HARVESTER_ENABLE_FULL_RUN", false) || process.argv.includes("--enable-full-run"),
    enableOkxExtraction: envBool("HARVESTER_ENABLE_OKX", false) || process.argv.includes("--enable-okx"),
    verbose: envBool("HARVESTER_VERBOSE", false) || process.argv.includes("--verbose"),
  };
}

export function validateConfig(cfg: HarvesterConfig): string[] {
  const errors: string[] = [];
  if (!cfg.gmgnApiKey) errors.push("GMGN_API_KEY is required");
  const partialOkx = [cfg.okxApiKey, cfg.okxSecretKey, cfg.okxPassphrase, cfg.okxProjectId].some(Boolean);
  const completeOkx = [cfg.okxApiKey, cfg.okxSecretKey, cfg.okxPassphrase, cfg.okxProjectId].every(Boolean);
  if (partialOkx && !completeOkx) {
    errors.push("OKX credentials are incomplete (set OKX_API_KEY, OKX_SECRET_KEY, OKX_PASSPHRASE, and OKX_PROJECT_ID, or leave all blank)");
  }
  if (cfg.maxTokensPerRun < 1) errors.push("maxTokensPerRun must be >= 1");
  return errors;
}

export const PROJECT_ROOT_PATH = PROJECT_ROOT;
