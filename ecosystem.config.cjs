module.exports = {
  apps: [
    {
      name: "charon",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/start-charon.sh",
      interpreter: "/usr/bin/bash",
      time: true,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        DB_PATH: "/opt/trading-data/charon.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TRADING_MODE: "dry_run",
        LEDGER_WRITER_ENABLED: "true",
        LLM_BASE_URL: "http://127.0.0.1:8317/v1",
        LLM_API_KEY: "NO_API_KEY",
        LLM_MODEL: "gpt-5.4-mini",
        LLM_PROVIDER_ORDER: "legacy",
        LLM_REASONING_EFFORT: "low"
      }
    },
    {
      name: "charon-scout",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/start-charon.sh",
      interpreter: "/usr/bin/bash",
      time: true,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        INSTANCE_ID: "scout",
        SHADOW_MODE: "true",
        DB_PATH: "/var/oled/charon-data/trading-data/charon-scout.sqlite",
        GLOBAL_LIVE_LOCK_DB_PATH: "/var/oled/charon-data/trading-data/charon-live-lock.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TRADING_MODE: "dry_run",
        SCOUT_LIVE_ENABLED: "false",
        LIVE_EXECUTION_DISABLED: "true",
        TELEGRAM_POLLING_ENABLED: "false",
        SCOUT_POLICY_ENABLED: "true",
        SCOUT_POLICY_ACTIVE_VERSION: "scout-v1",
        SCOUT_DAILY_BUY_CAP: "3",
        SCOUT_DAILY_LOSS_STOP_SOL: "0.06",
        GLOBAL_LIVE_LOCK_ENABLED: "true",
        GLOBAL_LIVE_LOCK_MAX_OPEN_SOL: "0.08",
        MAX_OPEN_POSITIONS: "1",
        LEDGER_WRITER_ENABLED: "true",
        SHADOW_FLEET_NOTIFIER_ENABLED: "false",
        SCOUT_LLM_THROTTLE_ENABLED: "true",
        SCOUT_LLM_MINT_COOLDOWN_MS: "1800000",
        SCOUT_LLM_HOURLY_CAP: "20",
        SCOUT_LLM_DAILY_CAP: "200",
        SCOUT_LLM_PRE_SCORE_THRESHOLD: "-0.02",
        SCOUT_LLM_HIGH_SCORE_RESERVE_THRESHOLD: "0.03",
        SCOUT_EXPLORATION_RATE: "0.08",
        LLM_PROVIDER_ORDER: "gemini,mistral",
        MIMO_LLM_MODEL: "mimo-v2.5",
        GROQ_LLM_MODEL: "llama-3.1-8b-instant",
        MISTRAL_LLM_MODEL: "mistral-small-latest",
        GEMINI_LLM_MODEL: "gemini-2.5-flash-lite",
        SHADOW_LLM_BASE_URL: "http://127.0.0.1:8317/v1",
        SHADOW_LLM_API_KEY: "NO_API_KEY",
        SHADOW_LLM_MODEL: "gpt-5.4-mini",
        SHADOW_LLM_REASONING_EFFORT: "low"
      }
    },
    {
      name: "charon-scout-learning",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/scout_learning_tick.js",
      interpreter: "/usr/bin/node",
      cron_restart: "*/30 * * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        INSTANCE_ID: "scout-learner",
        DB_PATH: "/var/oled/charon-data/trading-data/charon-scout.sqlite",
        LLM_PROVIDER_ORDER: "gemini,mistral",
        MISTRAL_LLM_MODEL: "mistral-small-latest",
        GEMINI_LLM_MODEL: "gemini-2.5-flash-lite",
        SCOUT_POLICY_ENABLED: "true"
      },
      out_file: "/var/oled/charon-data/trading-data/logs/scout-learning.log",
      error_file: "/var/oled/charon-data/trading-data/logs/scout-learning-error.log",
      merge_logs: true,
      time: true
    },
    {
      // Wallet auto-sync pipeline: harvest → enrich → sync → safe restart
      // Runs every 2 hours. Skips restart if nothing new (exit 2) or positions
      // still open after 30 min (exit 3 — retries next cycle).
      // Logs: /opt/trading-data/logs/auto-sync-YYYY-MM-DD.log
      name: "charon-auto-sync",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/auto_sync_wallets.sh",
      interpreter: "/usr/bin/bash",
      cron_restart: "0 */2 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        CHARON_DB_PATH: "/opt/trading-data/charon.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        LOG_DIR: "/opt/trading-data/logs",
        HARVESTER_ENABLE_OKX_DISCOVERY: "true",
        HARVESTER_OKX_MAX_CALLS_PER_RUN: "55",
        HARVESTER_OKX_MIN_INTERVAL_MS: "1200"
      },
      out_file: "/opt/trading-data/logs/auto-sync.log",
      error_file: "/opt/trading-data/logs/auto-sync-error.log",
      merge_logs: true,
      time: true
    },
    {
      name: "charon-shadow",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/start-charon.sh",
      interpreter: "/usr/bin/bash",
      time: true,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        INSTANCE_ID: "shadow",
        SHADOW_MODE: "true",
        LIVE_EXECUTION_DISABLED: "true",
        DB_PATH: "/var/oled/charon-data/trading-data/charon-shadow.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TRADING_MODE: "dry_run",
        TELEGRAM_POLLING_ENABLED: "false",
        SHADOW_FLEET_NOTIFIER_ENABLED: "false",
        SHADOW_FLEET_NOTIFIER_INITIAL_DELAY_MS: "60000",
        SHADOW_FLEET_NOTIFIER_INTERVAL_MS: "1800000",
        SHADOW_FLEET_NOTIFIER_WINDOW_MS: "1800000",
        LEDGER_WRITER_ENABLED: "true",
        LLM_PROVIDER_ORDER: "legacy,cliproxy",
        SHADOW_LLM_BASE_URL: "https://integrate.api.nvidia.com/v1",
        SHADOW_LLM_MODEL: "meta/llama-4-maverick-17b-128e-instruct"
      }
    },
    {
      // Observation telemetry collector: provider calls are outside the Charon
      // decision path. Uses existing runtime env/.env for BIRDEYE_API_KEY but
      // never prints secrets.
      name: "charon-observation-collector",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/collect_observations.js",
      interpreter: "/usr/bin/node",
      time: true,
      autorestart: true,
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        INSTANCE_ID: "primary",
        DB_PATH: "/opt/trading-data/charon.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TELEMETRY_COLLECTOR_ENABLED: "true",
        TELEMETRY_COLLECTOR_ID: "primary-observation-collector",
        TELEMETRY_OHLCV_INTERVAL: "1m",
        TELEMETRY_PROVIDER_MIN_INTERVAL_MS: "15000",
        TELEMETRY_COLLECTOR_MODE: "outcome_ohlcv",
        TELEMETRY_BIRDEYE_ENDPOINTS: "ohlcv",
        TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED: "false",
        TELEMETRY_INITIAL_OBSERVE_DELAY_MS: "21600000",
        TELEMETRY_MIN_OBSERVE_AGE_MS: "21600000",
        TELEMETRY_FOLLOWUP_BUCKETS_MS: "21600000,86400000",
        TELEMETRY_MIN_WATCH_TIER: "A",
        TELEMETRY_BIRDEYE_DAILY_CALL_CAP: "6000",
        TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS: "3600000"
      },
      out_file: "/opt/trading-data/logs/observation-collector.log",
      error_file: "/opt/trading-data/logs/observation-collector-error.log",
      merge_logs: true
    },
    {
      // Disabled: was doubling BirdEye CU burn. Re-enable only with a higher
      // TELEMETRY_PROVIDER_MIN_INTERVAL_MS budget allocation.
      name: "charon-shadow-observation-collector",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/collect_observations.js",
      interpreter: "/usr/bin/node",
      time: true,
      autorestart: false,
      max_restarts: 5,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        INSTANCE_ID: "shadow",
        SHADOW_MODE: "true",
        LIVE_EXECUTION_DISABLED: "true",
        TELEGRAM_POLLING_ENABLED: "false",
        DB_PATH: "/var/oled/charon-data/trading-data/charon-shadow.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TELEMETRY_COLLECTOR_ENABLED: "true",
        TELEMETRY_COLLECTOR_ID: "shadow-observation-collector",
        TELEMETRY_OHLCV_INTERVAL: "1m",
        TELEMETRY_PROVIDER_MIN_INTERVAL_MS: "30000",
        TELEMETRY_COLLECTOR_MODE: "outcome_ohlcv",
        TELEMETRY_BIRDEYE_ENDPOINTS: "ohlcv",
        TELEMETRY_BIRDEYE_TOKEN_TX_FALLBACK_ENABLED: "false",
        TELEMETRY_INITIAL_OBSERVE_DELAY_MS: "21600000",
        TELEMETRY_MIN_OBSERVE_AGE_MS: "21600000",
        TELEMETRY_FOLLOWUP_BUCKETS_MS: "21600000,86400000",
        TELEMETRY_MIN_WATCH_TIER: "A",
        TELEMETRY_BIRDEYE_DAILY_CALL_CAP: "2000",
        TELEMETRY_BIRDEYE_BUDGET_COOLDOWN_MS: "3600000"
      },
      out_file: "/var/oled/charon-data/trading-data/logs/shadow-observation-collector.log",
      error_file: "/var/oled/charon-data/trading-data/logs/shadow-observation-collector-error.log",
      merge_logs: true
    },
    {
      // Exports read-only OHLCV artifacts consumed by Charon Intelligence.
      // Source DBs are read-only; only OHLCV output DBs are written.
      name: "charon-ohlcv-export",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/export_ohlcv_artifacts.sh",
      interpreter: "/usr/bin/bash",
      cron_restart: "*/5 * * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        CHARON_DIR: "/home/opc/charon",
        LIVE_SOURCE_DB: "/opt/trading-data/charon.sqlite",
        SHADOW_SOURCE_DB: "/var/oled/charon-data/trading-data/charon-shadow.sqlite",
        LIVE_OUTPUT_DB: "/opt/trading-data/live/ohlcv.sqlite",
        SHADOW_OUTPUT_DB: "/var/oled/charon-data/trading-data/shadow/ohlcv.sqlite"
      },
      out_file: "/opt/trading-data/logs/ohlcv-export.log",
      error_file: "/opt/trading-data/logs/ohlcv-export-error.log",
      merge_logs: true,
      time: true
    },
    {
      // Shadow baseline sync: primary DB read-only, shadow DB read/write.
      // Keeps wallets, blacklist, active lessons, settings, and strategies fresh
      // while preserving owner-marked shadow overrides.
      name: "charon-shadow-sync",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/shadow_sync_pm2.sh",
      interpreter: "/usr/bin/bash",
      cron_restart: "0 */2 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production"
      },
      out_file: "/var/oled/charon-data/trading-data/logs/shadow-sync.log",
      error_file: "/var/oled/charon-data/trading-data/logs/shadow-sync-error.log",
      merge_logs: true,
      time: true
    },
    {
      // Shadow fleet Telegram summary. Runs as a one-shot cron and loads
      // Telegram credentials from .env at runtime; no secrets live here.
      name: "charon-shadow-notifier",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/shadow_fleet_notifier.js",
      interpreter: "/usr/bin/node",
      cron_restart: "*/30 * * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        INSTANCE_ID: "shadow-notifier",
        SHADOW_MODE: "true",
        LIVE_EXECUTION_DISABLED: "true",
        TELEGRAM_POLLING_ENABLED: "false",
        DB_PATH: "/var/oled/charon-data/trading-data/charon-shadow.sqlite",
        SHADOW_NOTIFIER_WINDOW_MS: "1800000"
      },
      out_file: "/var/oled/charon-data/trading-data/logs/shadow-notifier.log",
      error_file: "/var/oled/charon-data/trading-data/logs/shadow-notifier-error.log",
      merge_logs: true,
      time: true
    }
  ]
};
