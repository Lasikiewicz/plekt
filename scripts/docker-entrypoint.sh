#!/bin/sh
set -e
# When the container starts as root (the default on most Docker setups), fix
# /data ownership so the non-root plekt user can write to a host-mounted
# volume, then drop privilege and exec the real process.
DATA_PATH="${DATA_DIR:-/data}"
# PLEKT_* names win; the PLEMBFIN_* names from before the rename still work.
DEMO_MODE="${PLEKT_DEMO_MODE:-${PLEMBFIN_DEMO_MODE:-}}"
DEMO_SEED="${PLEKT_DEMO_SEED:-${PLEMBFIN_DEMO_SEED:-1}}"
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_PATH"
    chown -R plekt:plekt "$DATA_PATH" 2>/dev/null || true
    if [ "$DEMO_MODE" = "1" ] && [ "$DEMO_SEED" = "1" ]; then
        gosu plekt node /app/scripts/seed-demo-catalog.js
    fi
    exec gosu plekt "$@"
fi
if [ "$DEMO_MODE" = "1" ] && [ "$DEMO_SEED" = "1" ]; then
    node /app/scripts/seed-demo-catalog.js
fi
exec "$@"
