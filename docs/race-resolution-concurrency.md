# Race-resolution concurrency

Production uses the existing `ASYNC_RACE_RESOLUTION_CONCURRENCY` operational
setting. Set it explicitly to an integer from `1` through `5` in the deployed environment and
use `scripts/pm2-safe-prod-reload.sh` to apply it. This is a startup setting, not
a live feature flag. No database migration or app update is needed.

The same valid setting now governs both the scheduler and the shared process-wide
budget for core resolution plus post-resolution tasks. Five means at most five
combined handlers, not five of each. Race leases/fences and post/core fairness
are unchanged. API process count and database pool ceilings are independent and
must not be increased along with this setting.

The shared budget defaults to two on missing/invalid settings. The legacy
scheduler retains its own unset default of one; use an explicit valid value for
deployment, never rely on malformed-value coercion. `workLaneMaxActive` in queue
service telemetry reports the actual shared cap; `workLaneActive` reports usage.

For the approved increase from three to five, observe multiple minutes of real
traffic: successful step requests, completed resolutions, expired leases,
queue age, process CPU/RSS, health, and unexpected restarts. Compare with the
pre-change baseline; a known startup-only cron warning is not evidence that
the concurrency change introduced it. If new request/worker failures, OOMs,
restarts, or sustained loss of queue progress appear, restore the setting to
`3`, rerun the safe reload, and verify recovery. Do not scale PM2 or raise the
database pool limits as an implicit workaround.
