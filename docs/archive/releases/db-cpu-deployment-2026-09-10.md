# Database CPU remediation deployment — September 10, 2026

Production deployment was explicitly authorized by the user. Runtime commit `14d2ddeb08df7aaec6e51ee0d4c04e80cab78ee8` is deployed; the previous runtime was `3a60332e17dac7f843f107fb788e8479875104ef`. The reviewed release was fast-forwarded into main and pushed before deployment.

## Deployment verification

- Additive migration `20260910010000_capture_root_readonly_sweep` finished at `2026-09-10T18:25:15.551Z`. Production checksum matches `38f8cdf49a2c5d626ae5483095121c88cbea56c9096060a8ae73b4bb325f34ba`.
- Migration used the verified direct PostgreSQL connection. The initial connection preflight failed before any migration ran because temporary URL cleanup misplaced a query parameter; correcting the temporary connection handling resolved it. No failed migration row was introduced by that attempt. Historical rolled-back migrations already had successful replacement entries and were left alone.
- Serialized `scripts/pm2-safe-prod-reload.sh` completed. Exactly two HTTP workers, one resolution worker and one cron worker are online; all four previous PIDs exited. Staging remains stopped. Static and live pool guards pass: HTTP10 each, resolution8, cron4, total32.
- DigitalOcean preflight confirmed the existing one-vCPU/2GB cluster, transaction pool size40, prepared support128 and direct max_connections50. No provider or pool configuration was changed.
- Existing server environment and modified package-lock were backed up and verified byte-identical afterward. Dependencies and Prisma schema did not change; dependency reinstall was unnecessary. Prisma client generation completed.
- Local/public API health and the marketing root/privacy/support pages returned success. Authenticated legacy Home, shell-v1 and sync-refresh-v1 returned200 with their expected contracts.
- Powerup copy dry-run found no changes. Referral audit/apply/audit all reported zero missing/applied rows. Those audit scripts left an open process handle after printing verified completion; only their dedicated audit processes were closed, without touching runtime workers.
- No prepared-statement protocol errors or unhandled exceptions appeared in the bounded fresh-log check. Transaction acquisition/expiry errors and a post-task receipt identity mismatch did appear; similar messages exist in the retained pre-observation log segment, but an equivalent pre-deployment error rate was not measured. They are not presented as fixed or conclusively attributed to this release.

## Post-deployment observation — in progress

Read-only collection runs from **18:29 through19:29 UTC**, with completed-bucket/log finalization shortly afterward. It uses DigitalOcean managed-host metrics, ten-second activity samples, minute statistics snapshots, completed pg_stat_monitor buckets, five-minute table counters and aggregate application telemetry. It does not reset statistics, cancel application queries or modify application data.

The initial full-text pg_stat_statements snapshot timed out after five seconds. The collector was restarted without fetching query text, retaining the original end time. The initial gap is explicitly recorded; completed pg_stat_monitor buckets continue independently. All collectors have bounded end times, and a finalizer stops any remaining owned collector processes and writes aggregate `summary.json` in the private observation directory.

At18:36:47UTC, only seven completed minutes were available:4,193 requests, one HTTP5xx,319 step-intake requests and557 committed resolutions. Sixteen CPU samples averaged73.75% non-idle. Traffic and resolution volume are higher than the baseline-hour averages; these early data are **not** evidence of a matched production CPU improvement or regression. Worker PIDs stayed unchanged through the verification period.

Private raw data and the bounded finalizer are under `/tmp/bara-db-after-cpu-20260910` on the production application host. After19:29:30UTC, inspect `summary.json`, collector completeness/errors and traffic mix before drawing conclusions or updating the [validation report](db-cpu-remediation-validation.md). Actual production CPU savings remain pending. The [baseline hour](db-cpu-hour-2026-09-10.md) and [implementation evidence](db-cpu-backend-implementation.md) remain separate from this rollout observation.
