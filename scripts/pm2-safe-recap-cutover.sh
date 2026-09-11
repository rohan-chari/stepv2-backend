#!/bin/sh
set -eu
# JSON secret input is forwarded on stdin, never expanded into shell arguments.
cd /var/www/step-tracker-backend
exec flock -w 120 /run/steps-tracker-pm2.lock node scripts/recap-cutover-operator.cjs
