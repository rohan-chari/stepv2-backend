# Event fingerprint cache production release — 2026-09-11

User explicitly authorized production deployment in this session.

## Release baseline

Production preflight found `ee86200`, newer than the original cache test
baseline `136e682`. The release branch is based on the actual deployed recap
and receipt-recovery release. Preserve its canonical event query and retired
capture behavior when integrating the cache; do not restore the old branch.

Production preflight: API and Redis healthy; 264 migrations applied, none
unfinished. Two HTTP processes, one resolution, one cron; staging stopped.
Role pool ceilings remain 20 + 8 + 4 = 32. Managed transaction pool size is
40, staging pool size 3, direct PostgreSQL maximum 50. No capacity change.

## Deployment order

1. Verify exact integrated release with dedicated local test PostgreSQL and
   isolated Redis; complete independent review.
2. Push the release branch. Preserve the server's package-lock metadata diff
   in a restricted deployment backup; verify the server still has the expected
   baseline before updating its checkout.
3. Apply only the four new additive fingerprint migrations: revisions,
   concurrent race index, incarnations, database epoch. Generate Prisma.
4. Run the existing serialized `pm2-safe-prod-reload.sh` wrapper. Preserve
   two HTTP workers, one resolution, one cron, and stopped staging.
5. Verify API/Redis, all migrations, index validity, process topology, fresh
   worker activity and errors. Run required referral convergence audit.

Rollback source is `ee86200`; leave additive schema installed, regenerate its
Prisma client, and use the same guarded reload wrapper. Do not run the recap cutover/final-drop
scripts in production for this cache release, or change flags or catalog policy.

## Exact release validation

Runtime `393edb4`: 107/107 final-drop integrations, 49/49 retained-schema
integrations, 3383/3383 unit tests passed. Redis envelope/namespace is v2;
fingerprint digest schema remains 4. Retired query fields and trigger
dependencies were removed. Entitlement SQL inputs now project five explicit
fields to prevent database-only BigInt revision serialization. Owned local
Redis was stopped. No integration test used production.

## Outcome

Deployed source **`83940f9`**, beginning 2026-09-11 17:35:50 UTC. Independent
review approved the integrated runtime with no remaining issues. Origin/main
contains the release. All four migrations succeeded; production now has 268
applied migrations. The new index is ready and valid; seven fingerprint
triggers are installed. Prisma generation and the serialized reload succeeded;
the wrapper verified the final pool budget and saved PM2.

Verified two HTTP workers, one resolution, one cron online; staging stopped.
Public API reports API/Redis healthy, and all three marketing URLs return 200.
Observed the new v2 scoring cache in production Redis. The transient queue
backlog fell from 27 queued jobs (oldest 96 seconds) to three (oldest 28
seconds), with 47 race jobs completing in the last two-minute sample. No
running/failed jobs appeared in that final census. Referral audit/apply/final
audit all reported zero missing rows; apply inserted nothing.

Fresh logs showed no missing-column, BigInt, uncaught-exception, or deadlock
signals. Billing availability/realm warnings, insufficient-participant
scheduled starts, notification terminal-failure alerts, and referral HMAC
configuration warnings continued; each was also present before deployment.
A transient queue-age alarm occurred during startup and the backlog then
drained. These pre-existing warnings were not changed by this release.

Restricted server backup: `/root/backups/event-fingerprint-cache-20260911T173550Z`
contains the original package-lock, source diff, and log offsets/process IDs.
No dependency installation, environment change, staging start, recap
cutover/final-drop, catalog mutation, or app release was needed.

The earlier 31-to-30 read
comparison describes the original test baseline, not measured production CPU
savings or a new measurement against this integrated release.

Independent source verification: the extracted canonical event SQL is exactly
the 2,993-character statement from deployed `ee86200`. It does not restore the
retired attribution fields from the original cache test baseline.
