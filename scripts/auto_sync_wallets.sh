#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHARON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Paths — adjust for VPS layout via MOONBAGS_DIR env override
MOONBAGS_DIR="${MOONBAGS_DIR:-$(cd "$CHARON_DIR/../moonbags" && pwd 2>/dev/null || echo "$CHARON_DIR/../moonbags")}"
HARVESTER_DIR="$MOONBAGS_DIR/tools/wallet-harvester"
# Allow env var overrides for VPS layouts where DBs live outside the repo dir
CHARON_DB="${CHARON_DB_PATH:-$CHARON_DIR/charon.sqlite}"
HARVESTER_DB="${HARVESTER_DB_PATH:-$HARVESTER_DIR/data/harvester.db}"
LOG_DIR="${LOG_DIR:-/opt/trading-data/logs}"
LOG_FILE="$LOG_DIR/auto-sync-$(date -u +%Y-%m-%d).log"
LOG_PREFIX="[auto-sync $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

# Tee to both stdout (captured by PM2) and a dated log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "$LOG_PREFIX Starting wallet auto-sync pipeline"
echo "$LOG_PREFIX CHARON_DIR=$CHARON_DIR"
echo "$LOG_PREFIX HARVESTER_DIR=$HARVESTER_DIR"

MOONBAGS_ENV="$MOONBAGS_DIR/.env"
if [ -f "$MOONBAGS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$MOONBAGS_ENV"
  set +a
  echo "$LOG_PREFIX Loaded MoonBags environment for harvester"
else
  echo "$LOG_PREFIX MoonBags environment file not found; harvester enrichment may be limited"
fi

# Step 1: Run GMGN harvester
echo "$LOG_PREFIX Step 1: Running harvester..."
cd "$HARVESTER_DIR"
npm run harvest:run:gmgn 2>&1 | tail -5
echo "$LOG_PREFIX Step 1: Harvester complete"

# Step 2: Enrich new wallets with GMGN + OKX profiles (non-fatal if API key missing)
echo "$LOG_PREFIX Step 2: Enriching wallet profiles (limit 50)..."
npx tsx src/enrichWalletProfile.ts --limit=50 2>&1 | tail -10 || true
echo "$LOG_PREFIX Step 2: Enrichment complete"

# Step 3: Sync new enriched wallets to Charon
echo "$LOG_PREFIX Step 3: Syncing new enriched wallets to Charon..."
cd "$CHARON_DIR"
SYNC_EXIT=0
node scripts/sync_saved_wallets.js \
  --commit \
  --new-only \
  --require-profile=gmgn \
  --harvester-db="$HARVESTER_DB" \
  --charon-db="$CHARON_DB" \
  2>&1 | tail -15 || SYNC_EXIT=$?

if [ "$SYNC_EXIT" -eq 2 ]; then
  echo "$LOG_PREFIX Step 3: No new enriched wallets to sync, skipping restart"
  echo "$LOG_PREFIX Pipeline complete (no changes)"
  exit 0
elif [ "$SYNC_EXIT" -ne 0 ]; then
  echo "$LOG_PREFIX Step 3: Sync failed with exit code $SYNC_EXIT"
  exit 1
fi

echo "$LOG_PREFIX Step 3: Sync complete, new wallets added"

# Step 4: Safe restart Charon (wait for no open positions, up to 30 min)
echo "$LOG_PREFIX Step 4: Waiting for safe restart window..."
RESTART_EXIT=0
node scripts/safe_restart_charon.js \
  --charon-db="$CHARON_DB" \
  --max-wait-minutes=30 \
  --poll-interval-sec=30 \
  2>&1 || RESTART_EXIT=$?

if [ "$RESTART_EXIT" -eq 3 ]; then
  echo "$LOG_PREFIX Step 4: Restart skipped (positions still open after 30 min), will retry next cycle"
elif [ "$RESTART_EXIT" -ne 0 ]; then
  echo "$LOG_PREFIX Step 4: Restart failed with exit code $RESTART_EXIT"
  exit 1
else
  echo "$LOG_PREFIX Step 4: Charon restarted successfully"
fi

echo "$LOG_PREFIX Pipeline complete"
