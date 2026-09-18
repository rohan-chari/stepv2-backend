# Database work reduction production release

The user explicitly authorized production deployment and merging to main on September 13, 2026. This release changes only the backend; existing iOS and Android binaries use the same contracts without a build or upload.

Runtime commit: `3ae65f5b8cf2066aac3990928eb94f7755e364fd`, rebased cleanly onto `d4b8b12` to retain the already-deployed admin changes. Review found no integration conflicts. The release was fast-forwarded to `origin/main`; the original local backend checkout's unrelated uncommitted work was preserved.

Rollback anchor: `pre-db-work-reduction-20260913`, pointing to previous runtime `9471f15247b154a3ec654a09c88d02b7f769c625`. The environment, pre-existing remote lockfile modification, and current operational safety files were preserved before deployment. Dependency definitions were unchanged; no package install or configuration update was necessary. Prisma client generation succeeded.

## Migration and reload

The control plane confirmed a transaction pool of 40, a separate staging pool of 3, and direct PostgreSQL maximum 50. Direct access was verified against the production database using the managed CA, strict TLS, and session-only 30-minute statement / 5-second lock limits. There were no unfinished migrations. Only `20260914010000_global_event_pending_parent_index` was pending.

The concurrent index migration succeeded before application reload. Exact definition, `indisvalid`, `indisready`, and successful migration bookkeeping were verified. The resulting production index occupied 49,152 bytes. An initial Node diagnostic connection rejected a URL/CA option mismatch before any migration was attempted; the connection construction was corrected, retaining certificate verification. No failed migration recovery or production setting change was needed.

The guarded reload completed at 23:25:46 UTC with exactly two HTTP workers, one resolution worker and one cron worker, aggregate pool budget 32. Staging remained stopped. Worker PIDs and restart counters remained stable during the subsequent verification period. Environment and lockfile hashes matched their pre-deployment values.

Powerup copy audit/apply found zero changes. Balance drift reported only the three previously recorded Decoy-related differences; live economic policy was left unchanged. Required referral catch-up audit/apply/audit reported zero missing or applied rows for both activity and review ownership.

## Verification

- Rebased release: 15 enrollment/parent, 8 deadline and 21 cache checks passed on local test infrastructure. Initial fixture guard mismatches were corrected without changing assertions. Earlier complete implementation validation and reproduced baseline suite failures remain in the implementation record.
- Local and public production health returned HTTP 200 with API and Redis healthy. Public health also passed from the development machine with the app user agent; a generic Python user agent received an edge 403. Marketing home, privacy and support returned 200.
- The existing review account received HTTP 200 for both old/current authentication and race-progress requests. Its available race was completed; participant/score response shapes were valid. No synthetic account, race, step upload or effect activation was created in production.
- All four database-pool heartbeat identities appeared: `http:0`, `http:1`, `resolution:0`, `cron:0`. New schema-v2 cache telemetry appeared for live worker identities, including complete approximately 60-second intervals after startup intervals.
- A bounded read of all log bytes added during the recorded verification window found no matched database, fatal, unhandled or scheduler failures. The normalized combined discovery SQL had executed 602 times by 23:31:41 UTC. Production instrumentation strips its comment marker, so the final check matched normalized SQL shape.

Sanitized evidence: [production verification](evidence/db-work-reduction/production-release-20260913.json). Private configuration backups and raw operational logs remain on the production host. Local test PostgreSQL and Redis services were stopped after verification.

This completes the authorized deployment, not the later comparative CPU study. No production CPU improvement is claimed. B1/C cache-policy decisions still require the specified comparable two-hour and midnight-spanning evidence; the new telemetry supplies that attribution.
