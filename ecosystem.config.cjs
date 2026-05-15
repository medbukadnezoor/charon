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
        TRADING_MODE: "dry_run"
      }
    },
    {
      // Wallet auto-sync pipeline: harvest → enrich → sync → safe restart
      // Runs every 6 hours. Skips restart if nothing new (exit 2) or positions
      // still open after 30 min (exit 3 — retries next cycle).
      // Logs: /opt/trading-data/logs/auto-sync-YYYY-MM-DD.log
      name: "charon-auto-sync",
      cwd: "/home/opc/charon",
      script: "/home/opc/charon/scripts/auto_sync_wallets.sh",
      interpreter: "/usr/bin/bash",
      cron_restart: "0 */6 * * *",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        CHARON_DB_PATH: "/opt/trading-data/charon.sqlite",
        HARVESTER_DB_PATH: "/opt/trading-data/harvester.db",
        MOONBAGS_DIR: "/home/opc/moonbags",
        LOG_DIR: "/opt/trading-data/logs"
      },
      out_file: "/opt/trading-data/logs/auto-sync.log",
      error_file: "/opt/trading-data/logs/auto-sync-error.log",
      merge_logs: true,
      time: true
    }
  ]
};
