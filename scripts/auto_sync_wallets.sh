#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CHARON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Paths — adjust for VPS layout via HARVESTER_DIR env override
HARVESTER_DIR="${HARVESTER_DIR:-$CHARON_DIR/tools/wallet-harvester}"
# Allow env var overrides for VPS layouts where DBs live outside the repo dir
CHARON_DB="${CHARON_DB_PATH:-$CHARON_DIR/charon.sqlite}"
HARVESTER_DB="${HARVESTER_DB_PATH:-$HARVESTER_DIR/data/harvester.db}"

db_has_table() {
  local db_path="$1"
  local table_name="$2"

  if command -v sqlite3 >/dev/null 2>&1; then
    local found
    found="$(sqlite3 "$db_path" "SELECT name FROM sqlite_master WHERE type='table' AND name='$table_name';")"
    [ "$found" = "$table_name" ]
    return
  fi

  CHECK_DB="$db_path" CHECK_TABLE="$table_name" NODE_PATH="$CHARON_DIR/node_modules" node <<'NODE'
const Database = require('better-sqlite3');

const dbPath = process.env.CHECK_DB;
const tableName = process.env.CHECK_TABLE;

if (!dbPath || !tableName) {
  process.exit(2);
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true });
try {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  process.exit(row ? 0 : 1);
} finally {
  db.close();
}
NODE
}

echo "[auto-sync] Validating environment..."
echo "[auto-sync]   CHARON_DB=$CHARON_DB"
echo "[auto-sync]   HARVESTER_DB=$HARVESTER_DB"
echo "[auto-sync]   HARVESTER_DIR=$HARVESTER_DIR"

missing_db_env=0
if [ -z "${CHARON_DB_PATH:-}" ]; then
  echo "FATAL: CHARON_DB_PATH must be set; refusing to use default Charon DB path $CHARON_DB" >&2
  missing_db_env=1
fi
if [ -z "${HARVESTER_DB_PATH:-}" ]; then
  echo "FATAL: HARVESTER_DB_PATH must be set; refusing to use default harvester DB path $HARVESTER_DB" >&2
  missing_db_env=1
fi
if [ "$missing_db_env" -ne 0 ]; then
  exit 1
fi

if [ ! -d "$HARVESTER_DIR" ]; then
  echo "FATAL: Harvester directory not found at $HARVESTER_DIR" >&2
  exit 1
fi

if [ ! -f "$CHARON_DB" ]; then
  echo "FATAL: Charon DB not found at $CHARON_DB" >&2
  exit 1
fi

if [ ! -f "$HARVESTER_DB" ]; then
  echo "FATAL: Harvester DB not found at $HARVESTER_DB" >&2
  exit 1
fi

if ! db_has_table "$CHARON_DB" "saved_wallets"; then
  echo "FATAL: Charon DB at $CHARON_DB missing table: saved_wallets" >&2
  exit 1
fi

for required_table in wallets wallet_profiles runs; do
  if ! db_has_table "$HARVESTER_DB" "$required_table"; then
    echo "FATAL: Harvester DB at $HARVESTER_DB missing table: $required_table" >&2
    exit 1
  fi
done

echo "[auto-sync] Validation passed"

LOG_DIR="${LOG_DIR:-/opt/trading-data/logs}"
LOG_FILE="$LOG_DIR/auto-sync-$(date -u +%Y-%m-%d).log"
LOG_PREFIX="[auto-sync $(date -u +%Y-%m-%dT%H:%M:%SZ)]"

# Tee to both stdout (captured by PM2) and a dated log file
exec > >(tee -a "$LOG_FILE") 2>&1

echo "$LOG_PREFIX Starting wallet auto-sync pipeline"
echo "$LOG_PREFIX CHARON_DIR=$CHARON_DIR"
echo "$LOG_PREFIX HARVESTER_DIR=$HARVESTER_DIR"

HARVESTER_ENV="${HARVESTER_ENV_PATH:-$HARVESTER_DIR/.env}"
if [ -f "$HARVESTER_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$HARVESTER_ENV"
  set +a
  echo "$LOG_PREFIX Loaded harvester environment from $HARVESTER_ENV"
else
  echo "$LOG_PREFIX Harvester .env not found at $HARVESTER_ENV; using PM2/process env only"
fi

# GMGN discovery breadth. These defaults widen each token's holder/trader scan
# without increasing the number of tokens scanned per run.
export HARVESTER_GMGN_HOLDER_LIMIT="${HARVESTER_GMGN_HOLDER_LIMIT:-100}"
export HARVESTER_GMGN_TRADER_LIMIT="${HARVESTER_GMGN_TRADER_LIMIT:-100}"
export HARVESTER_PROFILE_ENRICH_LIMIT="${HARVESTER_PROFILE_ENRICH_LIMIT:-100}"
export HARVESTER_ENABLE_OKX_DISCOVERY="${HARVESTER_ENABLE_OKX_DISCOVERY:-false}"

echo "$LOG_PREFIX GMGN holder limit=$HARVESTER_GMGN_HOLDER_LIMIT"
echo "$LOG_PREFIX GMGN trader limit=$HARVESTER_GMGN_TRADER_LIMIT"
echo "$LOG_PREFIX Profile enrich limit=$HARVESTER_PROFILE_ENRICH_LIMIT"
echo "$LOG_PREFIX OKX extra discovery=$HARVESTER_ENABLE_OKX_DISCOVERY"

# Step 1: Run harvester. OKX can expand the harvester wallet pool, but Charon
# sync remains gated on GMGN profile evidence in Step 3.
echo "$LOG_PREFIX Step 1: Running harvester..."
cd "$HARVESTER_DIR"
if [ "$HARVESTER_ENABLE_OKX_DISCOVERY" = "true" ]; then
  npm run harvest:run:okx 2>&1 | tail -8
else
  npm run harvest:run:gmgn 2>&1 | tail -5
fi
echo "$LOG_PREFIX Step 1: Harvester complete"

# Step 2: Enrich wallets with GMGN profiles (non-fatal if profile API is limited)
echo "$LOG_PREFIX Step 2: Enriching wallet profiles (limit $HARVESTER_PROFILE_ENRICH_LIMIT)..."
npx tsx src/enrichWalletProfile.ts --limit="$HARVESTER_PROFILE_ENRICH_LIMIT" 2>&1 | tail -10 || true
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
