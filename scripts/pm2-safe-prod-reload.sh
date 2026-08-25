#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../ecosystem.config.js"
GUARD="$SCRIPT_DIR/pm2-topology-guard.js"

cd /var/www/step-tracker-backend
export CONFIG GUARD
exec flock -w 120 /run/steps-tracker-pm2.lock sh -eu -c '
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory
  pm2 startOrReload "$CONFIG" --only steps-tracker
  node "$GUARD" --remediate --skip-memory --verify-live-config
  pm2 startOrReload "$CONFIG" --only steps-tracker-resolution
  node "$GUARD"
  pm2 startOrReload "$CONFIG" --only steps-tracker-cron
  node "$GUARD"
  pm2 save
'
