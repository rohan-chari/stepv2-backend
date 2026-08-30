#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../ecosystem.config.js"
GUARD="$SCRIPT_DIR/pm2-topology-guard.js"

cd /var/www/step-tracker-backend
export CONFIG GUARD
exec flock -w 120 /run/steps-tracker-pm2.lock sh -eu -c '
  BASELINE_DIR="$(mktemp -d /run/steps-pool-baseline.XXXXXX)"
  BASELINE_FILE="$BASELINE_DIR/live.json"
  trap '\''rm -f -- "$BASELINE_FILE"; rmdir -- "$BASELINE_DIR"'\'' EXIT HUP INT TERM

  node "$GUARD" --pool-budget-mode=static
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory
  node "$GUARD" --pool-budget-mode=baseline --baseline-file="$BASELINE_FILE"

  pm2 startOrReload "$CONFIG" --only steps-tracker-resolution
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory
  node "$GUARD" --pool-budget-mode=transition --transitioned-roles=resolution --baseline-file="$BASELINE_FILE"

  pm2 startOrReload "$CONFIG" --only steps-tracker-cron
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory
  node "$GUARD" --pool-budget-mode=transition --transitioned-roles=resolution,cron --baseline-file="$BASELINE_FILE"

  pm2 startOrReload "$CONFIG" --only steps-tracker
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory --verify-live-config
  node "$GUARD" --pool-budget-mode=transition --transitioned-roles=resolution,cron,http --baseline-file="$BASELINE_FILE"
  node "$GUARD" --pool-budget-mode=final --baseline-file="$BASELINE_FILE"
  pm2 save
'
