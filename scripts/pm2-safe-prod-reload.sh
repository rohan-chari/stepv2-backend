#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/../ecosystem.config.js"
GUARD="$SCRIPT_DIR/pm2-topology-guard.js"

cd /var/www/step-tracker-backend
MIN_SUPPORTED_APP_VERSION="$(node -e '
  const fs = require("node:fs");
  const dotenv = require("dotenv");
  const { isSafeAppVersion } = require("./src/shared/validation/appVersion");
  const env = dotenv.parse(fs.readFileSync(".env"));
  const value = env.MIN_SUPPORTED_APP_VERSION;
  if (!isSafeAppVersion(value) || value === "unknown") process.exit(1);
  process.stdout.write(value);
')"
LATEST_APP_VERSION="$(node -e '
  const fs = require("node:fs");
  const dotenv = require("dotenv");
  const { isSafeAppVersion } = require("./src/shared/validation/appVersion");
  const env = dotenv.parse(fs.readFileSync(".env"));
  const value = env.LATEST_APP_VERSION || env.MIN_SUPPORTED_APP_VERSION;
  if (!isSafeAppVersion(value) || value === "unknown") process.exit(1);
  process.stdout.write(value);
')"
export CONFIG GUARD MIN_SUPPORTED_APP_VERSION LATEST_APP_VERSION

exec flock -w 120 /run/steps-tracker-pm2.lock sh -eu -c '
  stop_and_wait_if_present() {
    NAME="$1"
    PID="$(pm2 pid "$NAME" 2>/dev/null | tail -n 1 | tr -d "[:space:]" || true)"
    case "$PID" in
      ""|0) return 0 ;;
      *[!0-9]*) echo "invalid PID for $NAME: $PID" >&2; exit 1 ;;
    esac

    START="$(awk "{print \$22}" "/proc/$PID/stat" 2>/dev/null || true)"
    [ -n "$START" ] || { echo "cannot identify live $NAME process $PID" >&2; exit 1; }

    pm2 stop "$NAME"
    DEADLINE="$(( $(date +%s) + 120 ))"
    while kill -0 "$PID" 2>/dev/null; do
      CURRENT_START="$(awk "{print \$22}" "/proc/$PID/stat" 2>/dev/null || true)"
      [ "$CURRENT_START" != "$START" ] && break
      [ "$(date +%s)" -ge "$DEADLINE" ] && {
        echo "$NAME PID $PID did not exit before safe-reload deadline" >&2
        exit 1
      }
      sleep 1
    done
  }

  # Target config must be internally valid before any PID changes. The live
  # source may be the reviewed legacy 4-process topology on the first rollout
  # or the split 7-process topology on every later rollout. No partial topology
  # is accepted.
  node "$GUARD" --pool-budget-mode=static
  node "$GUARD" --source-topology

  # HTTP becomes producer-only first. A rolling cluster reload preserves both
  # public workers while removing any historical background ownership from the
  # request tier.
  pm2 startOrReload "$CONFIG" --only steps-tracker --update-env

  # Stop every possible old background owner before any candidate consumer
  # starts. Missing split roles are expected on the first rollout.
  stop_and_wait_if_present steps-tracker-cron
  stop_and_wait_if_present steps-tracker-notification
  stop_and_wait_if_present steps-tracker-event
  stop_and_wait_if_present steps-tracker-step
  stop_and_wait_if_present steps-tracker-resolution

  # Redis stream reclaim and database delivery leases use 30-second windows.
  # Waiting here prevents the new artifact from racing an old claimed message
  # whose process just exited.
  sleep 30

  # Start only the candidate artifact, in dependency order. Queue intake can
  # accumulate safely while background owners are down.
  pm2 startOrReload "$CONFIG" --only steps-tracker-step --update-env
  pm2 startOrReload "$CONFIG" --only steps-tracker-resolution --update-env
  pm2 startOrReload "$CONFIG" --only steps-tracker-event --update-env
  pm2 startOrReload "$CONFIG" --only steps-tracker-notification --update-env
  pm2 startOrReload "$CONFIG" --only steps-tracker-cron --update-env

  # Save only after exact topology, HTTP memory safety and the reviewed
  # 39-connection role budget are all proven live.
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory
  node "$GUARD" --remediate --stabilize-ms=30000 --skip-memory --verify-live-config
  node "$GUARD" --pool-budget-mode=final
  pm2 save
'
