# Fixed team payout rollout

This feature has two immutable deployment boundaries. Do not combine them and
do not use a runtime flag. Production deployment and every production repair
step require separate, in-the-moment authorization.

## Deployment A — compatibility readers

1. Apply migration `20260827010000_add_fixed_team_payout_stamps`. It adds only
   nullable columns; there is no backfill.
2. Deploy the Deployment A commit to both production PM2 workers.
3. Verify both workers run Deployment A before proceeding. During this phase,
   creation keeps both stamp columns `NULL`. Duration edit/start keeps null or
   malformed rows unchanged, but atomically re-prices any valid V1 row that a B
   worker may have created during a mixed-worker window.
4. Smoke-test legacy funded team races through list, detail, progress, public,
   featured, shared-preview, and Home payloads. Both additive wire fields must
   be present as `null`, and projections/settlement must remain legacy.
5. Verify the permanent five-membership ceiling on race and tournament paths:
   the sixth simultaneous user-created funded competition returns HTTP 409 /
   `FUNDED_EXPOSURE_LIMIT`. The cap lives in A so an A worker cannot admit a
   sixth membership during the later rolling B deployment.

Deployment A can safely read and settle a valid V1 stamp if one exists, which
makes a mixed A/B worker window safe. Partial, malformed, or unknown stamp
pairs serialize as two nulls and use the legacy formula.

## Deployment B — permanent writer activation

Proceed only after every production worker is verified on Deployment A.

1. Deploy the Deployment B commit to both workers.
2. Verify a newly created one-day user-funded team race stores version `1` and
   reward `100`; verify the API returns the same pair.
3. Verify 2–3, 4–7, and 8+ day creations stamp `200`, `500`, and `1000`.
4. Reconfirm the five-membership ceiling remains enforced across race and
   tournament paths.

Rolling application code back from B to A is compatible: A honors races that
B already stamped and stops creating new stamps. Leave the additive columns in
place. Do not roll back the migration destructively.

## Separately authorized open-race repair

Run repair only after all workers are on Deployment B. It is intentionally not
part of either deployment.

1. With a separately authorized production environment, run the default dry
   report: `npm run team-payouts:repair`.
2. Review every `upward` row and every `skippedNonUpward` row. The candidate
   query excludes completed/cancelled, seeded, tournament, buy-in, already
   stamped, and partial-stamp races.
   Record the emitted `reportDigest`; it binds the IDs, duration/reward, current
   and repaired projections, and both side liabilities to the review.
3. Obtain separate enqueue authorization for that exact report, then run
   `npm run team-payouts:repair -- --enqueue --confirm-enqueue=FIXED_TEAM_PAYOUT_REPAIR_V1 --report-digest=<reviewed digest>`.
   Enqueue refuses if a fresh report differs and holds the resulting command
   cohort so the worker cannot execute it yet.
4. Obtain separate execution authorization for the exact enqueued digest, then
   run `npm run team-payouts:repair -- --authorize-execution --confirm-execution=FIXED_TEAM_PAYOUT_EXECUTION_V1 --report-digest=<reviewed digest>`.
5. Verify the admin-command worker reports each command complete. A command
   re-reads and fences the race, refuses any no-longer-open/out-of-scope or
   non-upward row, uses a compare-and-set stamp write, and invalidates progress
   plus participant race-list caches.
6. Re-run the dry report. Repaired rows must be absent and replaying an already
   completed command must not mint coins or change a race again.

Never edit the candidate JSON or stamp rows directly. If a row needs a payout
decrease, has a partial/malformed stamp, or changed after review, stop and
investigate rather than forcing it through this repair.
