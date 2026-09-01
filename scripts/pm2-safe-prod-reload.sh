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

  OLD_CRON_PID="$(pm2 pid steps-tracker-cron | tail -n 1 | tr -d "[:space:]")"
  case "$OLD_CRON_PID" in
    ""|0|*[!0-9]*) echo "safe reload requires one live steps-tracker-cron PID" >&2; exit 1 ;;
  esac
  OLD_CRON_START="$(awk "{print \$22}" "/proc/$OLD_CRON_PID/stat")"
  pm2 stop steps-tracker-cron
  CRON_EXIT_DEADLINE="$(( $(date +%s) + 120 ))"
  while kill -0 "$OLD_CRON_PID" 2>/dev/null; do
    CURRENT_CRON_START="$(awk "{print \$22}" "/proc/$OLD_CRON_PID/stat" 2>/dev/null || true)"
    [ "$CURRENT_CRON_START" != "$OLD_CRON_START" ] && break
    [ "$(date +%s)" -ge "$CRON_EXIT_DEADLINE" ] && {
      echo "old cron PID did not exit before safe-reload deadline" >&2
      exit 1
    }
    sleep 1
  done
  # The exact old owner is gone. Wait the full legacy delivery lease before a
  # new cron can claim any row that an old binary might have held.
  sleep 30
  pm2 start "$CONFIG" --only steps-tracker-cron
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory
  node "$GUARD" --pool-budget-mode=transition --transitioned-roles=resolution,cron --baseline-file="$BASELINE_FILE"

  pm2 startOrReload "$CONFIG" --only steps-tracker
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory --verify-live-config
  node "$GUARD" --pool-budget-mode=transition --transitioned-roles=resolution,cron,http --baseline-file="$BASELINE_FILE"
  node "$GUARD" --pool-budget-mode=final --baseline-file="$BASELINE_FILE"
  pm2 save
'
