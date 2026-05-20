#!/usr/bin/env bash
set -euo pipefail

cd /home/opc/charon

if [ ! -f /home/opc/charon/.env ]; then
  echo "[charon] /home/opc/charon/.env is missing; refusing to start. Create it from .env.operator.example." >&2
  exit 64
fi

# Preserve PM2/runtime instance overrides before sourcing .env. The .env file
# provides credentials; PM2 owns per-process identity and DB isolation.
PM2_INSTANCE_ID="${INSTANCE_ID:-}"
PM2_SHADOW_MODE="${SHADOW_MODE:-}"
PM2_LIVE_EXECUTION_DISABLED="${LIVE_EXECUTION_DISABLED:-}"
PM2_DB_PATH="${DB_PATH:-}"
PM2_HARVESTER_DB_PATH="${HARVESTER_DB_PATH:-}"
PM2_TRADING_MODE="${TRADING_MODE:-}"
PM2_TELEGRAM_POLLING_ENABLED="${TELEGRAM_POLLING_ENABLED:-}"
PM2_LLM_BASE_URL="${LLM_BASE_URL:-}"
PM2_LLM_MODEL="${LLM_MODEL:-}"
PM2_LLM_API_KEY="${LLM_API_KEY:-}"
PM2_LLM_REASONING_EFFORT="${LLM_REASONING_EFFORT:-}"
PM2_SHADOW_LLM_BASE_URL="${SHADOW_LLM_BASE_URL:-}"
PM2_SHADOW_LLM_MODEL="${SHADOW_LLM_MODEL:-}"
PM2_SHADOW_LLM_API_KEY="${SHADOW_LLM_API_KEY:-}"

set -a
. /home/opc/charon/.env
set +a

export CHARON_SKIP_DOTENV="true"

export INSTANCE_ID="${PM2_INSTANCE_ID:-${INSTANCE_ID:-primary}}"
export SHADOW_MODE="${PM2_SHADOW_MODE:-${SHADOW_MODE:-false}}"
export LIVE_EXECUTION_DISABLED="${PM2_LIVE_EXECUTION_DISABLED:-${LIVE_EXECUTION_DISABLED:-false}}"
export DB_PATH="${PM2_DB_PATH:-${DB_PATH:-/opt/trading-data/charon.sqlite}}"
export HARVESTER_DB_PATH="${PM2_HARVESTER_DB_PATH:-${HARVESTER_DB_PATH:-/opt/trading-data/harvester.db}}"
export TRADING_MODE="${PM2_TRADING_MODE:-${TRADING_MODE:-dry_run}}"
export TELEGRAM_POLLING_ENABLED="${PM2_TELEGRAM_POLLING_ENABLED:-${TELEGRAM_POLLING_ENABLED:-true}}"
export LLM_BASE_URL="${PM2_LLM_BASE_URL:-${LLM_BASE_URL:-}}"
export LLM_MODEL="${PM2_LLM_MODEL:-${LLM_MODEL:-}}"
export LLM_API_KEY="${PM2_LLM_API_KEY:-${LLM_API_KEY:-}}"
export LLM_REASONING_EFFORT="${PM2_LLM_REASONING_EFFORT:-${LLM_REASONING_EFFORT:-}}"
export SHADOW_LLM_BASE_URL="${PM2_SHADOW_LLM_BASE_URL:-${SHADOW_LLM_BASE_URL:-}}"
export SHADOW_LLM_MODEL="${PM2_SHADOW_LLM_MODEL:-${SHADOW_LLM_MODEL:-}}"
export SHADOW_LLM_API_KEY="${PM2_SHADOW_LLM_API_KEY:-${SHADOW_LLM_API_KEY:-}}"

if [ "$SHADOW_MODE" = "true" ]; then
  export LIVE_EXECUTION_DISABLED="true"
  export TRADING_MODE="dry_run"
  export TELEGRAM_POLLING_ENABLED="false"
  unset SOLANA_PRIVATE_KEY
  unset PRIVATE_KEY
fi

if [ "$TRADING_MODE" != "dry_run" ]; then
  echo "[charon] TRADING_MODE=$TRADING_MODE; refusing PM2 bot start unless TRADING_MODE=dry_run." >&2
  exit 65
fi

for required in TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
  if [ -z "${!required:-}" ]; then
    echo "[charon] $required is missing; refusing to start." >&2
    exit 66
  fi
done

if [ -z "${HELIUS_API_KEY:-}" ] && { [ -z "${SOLANA_RPC_URL:-}" ] || [ -z "${SOLANA_WS_URL:-}" ]; }; then
  echo "[charon] HELIUS_API_KEY or both SOLANA_RPC_URL/SOLANA_WS_URL are required; refusing to start." >&2
  exit 67
fi

exec /usr/bin/node index.js
