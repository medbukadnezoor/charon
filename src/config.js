import dotenv from 'dotenv';

if (process.env.CHARON_SKIP_DOTENV !== 'true') {
  dotenv.config();
}

export const APP_NAME = 'Charon';
export const DB_PATH = process.env.DB_PATH || './charon.sqlite';
export const INSTANCE_ID = process.env.INSTANCE_ID || 'primary';
export const SHADOW_MODE = process.env.SHADOW_MODE === 'true';
export const LIVE_EXECUTION_DISABLED = process.env.LIVE_EXECUTION_DISABLED === 'true';
export const TELEGRAM_POLLING_ENABLED = process.env.TELEGRAM_POLLING_ENABLED !== 'false';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const DISC_DIST_FEES = Buffer.from('a537817004b3ca28', 'hex');
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_MINT = 'So11111111111111111111111111111111111111111';

export const TELEGRAM_BOT_TOKEN = SHADOW_MODE
  ? (process.env.SHADOW_TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN)
  : process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID;
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
export const GMGN_API_KEY = process.env.GMGN_API_KEY;
export const GMGN_ENABLED = process.env.GMGN_ENABLED !== 'false';
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
export const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || process.env.BIRDEYE_BDS_API_KEY || process.env.BDS_API_KEY || process.env.BIRDEYE_KEY || '';
export const SOLANA_PRIVATE_KEY = SHADOW_MODE ? '' : (process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '');
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOLANA_WS_URL = process.env.SOLANA_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const PUMP_HELIUS_RPC_URL = process.env.PUMP_HELIUS_RPC_URL || '';
export const PUMP_HELIUS_WS_URL = process.env.PUMP_HELIUS_WS_URL || '';
export const JUPITER_SWAP_BASE_URL = process.env.JUPITER_SWAP_BASE_URL || 'https://api.jup.ag/swap/v2';
export const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || 300);
export const LIVE_MIN_SOL_RESERVE_LAMPORTS = Math.floor(Number(process.env.LIVE_MIN_SOL_RESERVE || 0.02) * 1_000_000_000);
export const DEFAULT_LLM_BASE_URL = 'http://127.0.0.1:8317/v1';
export const DEFAULT_LLM_API_KEY = 'NO_API_KEY';
export const DEFAULT_LLM_MODEL = 'gpt-5.5';
export const DEFAULT_SHADOW_LLM_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const DEFAULT_SHADOW_LLM_MODEL = 'meta/llama-4-maverick-17b-128e-instruct';
export const DEFAULT_MIMO_LLM_BASE_URL = 'https://token-plan-sgp.xiaomimimo.com/v1';
export const DEFAULT_MIMO_LLM_MODEL = 'mimo-v2.5-pro';
export const DEFAULT_GROQ_LLM_BASE_URL = 'https://api.groq.com/openai/v1';
export const DEFAULT_GROQ_LLM_MODEL = 'llama-3.1-8b-instant';
export const DEFAULT_MISTRAL_LLM_BASE_URL = 'https://api.mistral.ai/v1';
export const DEFAULT_MISTRAL_LLM_MODEL = 'open-mistral-nemo';
export const DEFAULT_GEMINI_LLM_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_LLM_MODEL = 'gemini-2.5-flash-lite';
export const DEFAULT_CLIPROXY_LLM_BASE_URL = 'http://127.0.0.1:8317/v1';
export const DEFAULT_CLIPROXY_LLM_MODEL = 'gpt-5.5';
export const LLM_PROVIDER_ORDER = process.env.LLM_PROVIDER_ORDER || (SHADOW_MODE ? 'legacy,cliproxy' : 'mimo,cliproxy');
export const MIMO_LLM_BASE_URL = process.env.MIMO_LLM_BASE_URL
  || process.env.XIAOMIMIMO_BASE_URL
  || process.env.MIMO_BASE_URL
  || DEFAULT_MIMO_LLM_BASE_URL;
export const MIMO_LLM_MODEL = process.env.MIMO_LLM_MODEL
  || process.env.XIAOMIMIMO_MODEL
  || process.env.MIMO_MODEL
  || DEFAULT_MIMO_LLM_MODEL;
export const MIMO_LLM_API_KEY = process.env.MIMO_LLM_API_KEY
  || process.env.MIMO_API_KEY
  || process.env.XIAOMIMIMO_API_KEY
  || process.env.MIMO_TOKEN_PLAN_API_KEY
  || process.env.TOKEN_PLAN_API_KEY
  || '';
export const GROQ_LLM_BASE_URL = process.env.GROQ_LLM_BASE_URL
  || process.env.GROQ_BASE_URL
  || DEFAULT_GROQ_LLM_BASE_URL;
export const GROQ_LLM_MODEL = process.env.GROQ_LLM_MODEL
  || process.env.GROQ_MODEL
  || DEFAULT_GROQ_LLM_MODEL;
export const GROQ_LLM_API_KEY = process.env.GROQ_LLM_API_KEY
  || process.env.GROQ_API_KEY
  || '';
export const MISTRAL_LLM_BASE_URL = process.env.MISTRAL_LLM_BASE_URL
  || process.env.MISTRAL_BASE_URL
  || DEFAULT_MISTRAL_LLM_BASE_URL;
export const MISTRAL_LLM_MODEL = process.env.MISTRAL_LLM_MODEL
  || process.env.MISTRAL_MODEL
  || DEFAULT_MISTRAL_LLM_MODEL;
export const MISTRAL_LLM_API_KEY = process.env.MISTRAL_LLM_API_KEY
  || process.env.MISTRAL_API_KEY
  || '';
export const GEMINI_LLM_BASE_URL = process.env.GEMINI_LLM_BASE_URL
  || process.env.GEMINI_BASE_URL
  || DEFAULT_GEMINI_LLM_BASE_URL;
export const GEMINI_LLM_MODEL = process.env.GEMINI_LLM_MODEL
  || process.env.GEMINI_MODEL
  || DEFAULT_GEMINI_LLM_MODEL;
export const GEMINI_LLM_API_KEY = process.env.GEMINI_LLM_API_KEY
  || process.env.GEMINI_API_KEY
  || '';
const SHADOW_LLM_BASE_URL_OVERRIDE = process.env.SHADOW_LLM_BASE_URL || '';
const SHADOW_LLM_POINTS_TO_CLIPROXY = /(^https?:\/\/)?(127\.0\.0\.1|localhost):8317(\/|$)/i.test(SHADOW_LLM_BASE_URL_OVERRIDE);
export const CLIPROXY_LLM_BASE_URL = process.env.CLIPROXY_LLM_BASE_URL
  || (SHADOW_LLM_POINTS_TO_CLIPROXY ? process.env.SHADOW_LLM_BASE_URL : '')
  || DEFAULT_CLIPROXY_LLM_BASE_URL;
export const CLIPROXY_LLM_MODEL = process.env.CLIPROXY_LLM_MODEL
  || (SHADOW_LLM_POINTS_TO_CLIPROXY ? process.env.SHADOW_LLM_MODEL : '')
  || DEFAULT_CLIPROXY_LLM_MODEL;
export const CLIPROXY_LLM_API_KEY = process.env.CLIPROXY_LLM_API_KEY
  || (SHADOW_LLM_POINTS_TO_CLIPROXY ? DEFAULT_LLM_API_KEY : '')
  || (CLIPROXY_LLM_BASE_URL === DEFAULT_CLIPROXY_LLM_BASE_URL ? DEFAULT_LLM_API_KEY : '')
  || process.env.LLM_API_KEY
  || DEFAULT_LLM_API_KEY;
export const LLM_BASE_URL = SHADOW_MODE
  ? (process.env.SHADOW_LLM_BASE_URL || DEFAULT_SHADOW_LLM_BASE_URL)
  : (process.env.LLM_BASE_URL || DEFAULT_LLM_BASE_URL);
const SHADOW_LLM_API_KEY = SHADOW_MODE
  && LLM_BASE_URL.includes('integrate.api.nvidia.com')
  && process.env.SHADOW_LLM_API_KEY === DEFAULT_LLM_API_KEY
  ? ''
  : process.env.SHADOW_LLM_API_KEY;
export const LLM_API_KEY = SHADOW_MODE
  ? (SHADOW_LLM_API_KEY || process.env.NVIDIA_API_KEY || process.env.LLM_API_KEY || DEFAULT_LLM_API_KEY)
  : (process.env.LLM_API_KEY || DEFAULT_LLM_API_KEY);
export const LLM_MODEL = SHADOW_MODE
  ? (process.env.SHADOW_LLM_MODEL || DEFAULT_SHADOW_LLM_MODEL)
  : (process.env.LLM_MODEL || DEFAULT_LLM_MODEL);
export const LLM_REASONING_EFFORT = SHADOW_MODE
  ? (process.env.SHADOW_LLM_REASONING_EFFORT || '')
  : (process.env.LLM_REASONING_EFFORT || 'low');
export const LLM_MAX_COMPLETION_TOKENS = Number(process.env.LLM_MAX_COMPLETION_TOKENS || (SHADOW_MODE ? 1024 : 0));

export const GRADUATED_POLL_MS = Number(process.env.GRADUATED_POLL_MS || 30_000);
export const GRADUATED_LOOKBACK_MS = Number(process.env.GRADUATED_LOOKBACK_MS || 2 * 60 * 60 * 1000);
export const TRENDING_POLL_MS = Number(process.env.TRENDING_POLL_MS || 60_000);
export const TRENDING_LOOKBACK_MS = Number(process.env.TRENDING_LOOKBACK_MS || 10 * 60 * 1000);
export const GMGN_CACHE_TTL_MS = Number(process.env.GMGN_CACHE_TTL_MS || 5 * 60 * 1000);
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 10_000);
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';
export const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL || 'http://localhost:3456';
export const SIGNAL_SERVER_KEY = process.env.SIGNAL_SERVER_KEY || '';
export const SIGNAL_POLL_MS = Number(process.env.SIGNAL_POLL_MS || 30_000);
export const LEDGER_WRITER_ENABLED = process.env.LEDGER_WRITER_ENABLED === 'true';
export const TELEMETRY_COLLECTOR_ENABLED = process.env.TELEMETRY_COLLECTOR_ENABLED === 'true';
export const TELEMETRY_CACHE_DB_PATH = process.env.TELEMETRY_CACHE_DB_PATH || DB_PATH;
export const TELEMETRY_COLLECTOR_ID = process.env.TELEMETRY_COLLECTOR_ID || `${INSTANCE_ID}-${process.pid}`;
export const TELEMETRY_PROVIDER_TIMEOUT_MS = Number(process.env.TELEMETRY_PROVIDER_TIMEOUT_MS || 12_000);
export const TELEMETRY_PROVIDER_MIN_INTERVAL_MS = Number(process.env.TELEMETRY_PROVIDER_MIN_INTERVAL_MS || 1_200);
export const TELEMETRY_OHLCV_INTERVAL = process.env.TELEMETRY_OHLCV_INTERVAL || '1m';
export const TELEMETRY_COLLECTOR_MODE = process.env.TELEMETRY_COLLECTOR_MODE || 'full';
export const TELEMETRY_BIRDEYE_ENDPOINTS = process.env.TELEMETRY_BIRDEYE_ENDPOINTS || '';
export const TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED = process.env.TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED !== 'false';
export const TELEMETRY_BIRDEYE_DAILY_CALL_CAP = Number(process.env.TELEMETRY_BIRDEYE_DAILY_CALL_CAP || 0);
export const TELEMETRY_BIRDEYE_BUDGET_START_MS = Number(process.env.TELEMETRY_BIRDEYE_BUDGET_START_MS || 0);
export const TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS = Number(process.env.TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS || 60 * 60_000);
export const TELEMETRY_MIN_WATCH_TIER = process.env.TELEMETRY_MIN_WATCH_TIER || 'C';
export const TELEMETRY_MIN_OBSERVE_AGE_MS = Number(process.env.TELEMETRY_MIN_OBSERVE_AGE_MS || 0);
export const TELEMETRY_INITIAL_OBSERVE_DELAY_MS = Number(process.env.TELEMETRY_INITIAL_OBSERVE_DELAY_MS || 0);
export const TELEMETRY_MAX_QUEUE_ATTEMPTS = Number(process.env.TELEMETRY_MAX_QUEUE_ATTEMPTS || 5);
export const TELEMETRY_DEFAULT_WATCH_MS = Number(process.env.TELEMETRY_DEFAULT_WATCH_MS || 24 * 60 * 60_000);
export const TELEMETRY_TIER_B_WATCH_MS = Number(process.env.TELEMETRY_TIER_B_WATCH_MS || 6 * 60 * 60_000);
export const TELEMETRY_TIER_C_WATCH_MS = Number(process.env.TELEMETRY_TIER_C_WATCH_MS || 60 * 60_000);
export const TELEMETRY_CHEAP_EXTENDED_WATCH_MS = Number(process.env.TELEMETRY_CHEAP_EXTENDED_WATCH_MS || 72 * 60 * 60_000);
export const TELEMETRY_FOLLOWUP_BUCKETS_MS = String(process.env.TELEMETRY_FOLLOWUP_BUCKETS_MS || '300000,900000,3600000,21600000,86400000')
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0);
export const SHADOW_FLEET_NOTIFIER_ENABLED = process.env.SHADOW_FLEET_NOTIFIER_ENABLED !== 'false';
export const SHADOW_FLEET_NOTIFIER_INTERVAL_MS = Number(process.env.SHADOW_FLEET_NOTIFIER_INTERVAL_MS || 30 * 60_000);
export const SHADOW_FLEET_NOTIFIER_INITIAL_DELAY_MS = Number(process.env.SHADOW_FLEET_NOTIFIER_INITIAL_DELAY_MS || 60_000);
export const SHADOW_FLEET_NOTIFIER_WINDOW_MS = Number(process.env.SHADOW_FLEET_NOTIFIER_WINDOW_MS || 30 * 60_000);

export const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required.');
  if (!HELIUS_API_KEY && (!process.env.SOLANA_RPC_URL || !process.env.SOLANA_WS_URL)) {
    throw new Error('HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.');
  }
  if (GMGN_ENABLED && !GMGN_API_KEY) throw new Error('GMGN_API_KEY is required unless GMGN_ENABLED=false.');
}
