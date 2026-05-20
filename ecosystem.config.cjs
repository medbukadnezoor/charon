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
        LLM_REASONING_EFFORT: "low"
      }
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
        DB_PATH: "/opt/trading-data/charon-shadow.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TRADING_MODE: "dry_run",
        TELEGRAM_POLLING_ENABLED: "false",
        LEDGER_WRITER_ENABLED: "true",
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
        TELEMETRY_PROVIDER_MIN_INTERVAL_MS: "10000"
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
        DB_PATH: "/opt/trading-data/charon-shadow.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        TELEMETRY_COLLECTOR_ENABLED: "true",
        TELEMETRY_COLLECTOR_ID: "shadow-observation-collector",
        TELEMETRY_OHLCV_INTERVAL: "1m",
        TELEMETRY_PROVIDER_MIN_INTERVAL_MS: "1200"
      },
      out_file: "/opt/trading-data/logs/shadow-observation-collector.log",
      error_file: "/opt/trading-data/logs/shadow-observation-collector-error.log",
      merge_logs: true
    },
    {
      // Exports read-only OHLCV artifacts consumed by Charon Intelligence.
      // Source DBs are read-only; only /opt/trading-data/{live,shadow}/ohlcv.sqlite
      // are written.
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
        SHADOW_SOURCE_DB: "/opt/trading-data/charon-shadow.sqlite",
        LIVE_OUTPUT_DB: "/opt/trading-data/live/ohlcv.sqlite",
        SHADOW_OUTPUT_DB: "/opt/trading-data/shadow/ohlcv.sqlite"
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
      out_file: "/opt/trading-data/logs/shadow-sync.log",
      error_file: "/opt/trading-data/logs/shadow-sync-error.log",
      merge_logs: true,
      time: true
    }
  ]
};
