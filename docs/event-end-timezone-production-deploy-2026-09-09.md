# Event ends and immediate timezone — production deployment

User explicitly authorized deployment on September 9, 2026.

- Runtime commit: `442b749cd29f50efc0be3028e129193bc624882e`.
- Previous production / rollback anchor: `83d749484bab807fb2da10088d4bf3be6dc50387`,
  tag `pre-event-timezone-20260909`.
- Deployment tag: `deploy/event-timezone-20260909-442b749`.
- Frontend request-timezone refresh `00c749e` remains on its review branch;
  no mobile build, upload or store release occurred.

## Cutover

Used the approved nonrolling sequence under the existing PM2 deployment lock,
with the existing static, baseline, topology and final pool-budget guards.
All old HTTP, cron and resolution processes were stopped before source/client
replacement. Their exact PIDs were verified gone and PostgreSQL reported no
remaining in-flight transactions. Waited 30 seconds for legacy delivery leases.
This intentionally supersedes the generic rolling-reload sequence for this release.

- Cutover began 11:23:14 UTC (07:23:14 Eastern).
- Old writers verified gone 11:23:16 UTC.
- Migration `20260909050000_event_end_retry` completed 11:23:50 UTC.
- New workers started 11:24:33 UTC.
- The wrapper's immediate health request ran before HTTP finished binding and
  returned connection refused. Subsequent local and public retry checks passed;
  no source rollback or extra worker restart was needed. Final guarded topology
  and pool checks passed before `pm2 save`.

This was a brief maintenance cutover, not a zero-downtime rolling deployment.
Dependencies were unchanged, so no package installation was needed. Generated
Prisma for the migrated schema. Preserved the pre-existing server package-lock
metadata difference and backed it up with the operational cutover log.

## Verification

- Production source hashes match every recorded reviewed implementation hash.
- 250 migrations applied; no failed migration. New partial index is valid/ready.
- Public and loopback `/health`: status ok, Redis ok.
- Unauthenticated `/auth/me`: expected HTTP 401.
- Exactly 2 HTTP workers, 1 existing cron and 1 existing resolution process;
  configured pool ceiling remains 32. Staging remains stopped.
- No overdue/deferred event ends in post-deploy samples.
- Resolution queue advanced from 4 queued / 1,570 succeeded to all 1,574 succeeded.
- Powerup-copy synchronization found no changes. Balance drift reported existing
  live DECOY configuration differences; live balance was preserved.
- Required referral audit → apply → final audit: zero missing rows and zero writes.

These are deployment health checks, not a new production CPU-capacity benchmark.
No account-specific timezone repair or modification of started events was run.
