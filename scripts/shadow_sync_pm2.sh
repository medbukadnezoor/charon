#!/usr/bin/env bash
set -euo pipefail

cd /home/opc/charon

SOURCE_DB="${SHADOW_SYNC_SOURCE_DB:-/opt/trading-data/charon.sqlite}"
TARGET_DB="${SHADOW_SYNC_TARGET_DB:-/var/oled/charon-data/trading-data/charon-shadow.sqlite}"

exec /usr/bin/node /home/opc/charon/scripts/shadow_bootstrap.js \
  --mode=sync \
  --source="$SOURCE_DB" \
  --target="$TARGET_DB"
