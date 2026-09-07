# Race effect expiry deployment

Public API contract is unchanged. Existing progress endpoints, authentication,
status codes, effect identities/timestamps and compact/paged/team variants are
preserved. All new deadline/publication metadata stays internal. Backend deploy
must precede the matching iOS and Android releases.

No deployment is authorized by this document. Production deployment requires
in-the-moment approval; staging stays stopped. Retain the current production
process capacity, including exactly two HTTP PM2 workers.

## Additive migration and backfill

1. Apply `20260906210000_race_effect_deadlines` using the established production
   migration procedure. It creates three internal tables and a default-zero
   committed-generation column. Source deadline and failed snapshot triggers
   cover older processes during a rolling restart. No existing table/index is
   rebuilt, no gameplay field is changed and no data is removed.
2. Apply `20260906220000_race_expiry_publication_indexes`. Its three partial
   indexes use `CREATE INDEX CONCURRENTLY` on retained post-task/receipt tables;
   do not wrap the migration in a transaction. They bound the independent
   snapshot lane and keyset failure census even with a large notification backlog.
   Verify all three indexes are valid (`pg_index.indisvalid`) before continuing.
   If interrupted, inspect only these named indexes:
   `race_post_snapshot_pending_idx`, `race_post_snapshot_failure_census_idx`,
   `race_post_receipt_failure_census_idx`. Drop an invalid partial build with
   `DROP INDEX CONCURRENTLY <name>` under the authorized maintenance procedure,
   resolve the interrupted migration as rolled back, and retry. Never drop a
   valid index to hide another migration error. `IF NOT EXISTS` alone does not
   repair an invalid concurrent build.
3. Run `NODE_ENV=production npm run race-effects:backfill-deadlines` from the
   deployed backend directory under the authorized production environment.
   This exact npm lifecycle/entrypoint pair is audited for the maintenance
   pool (default two connections). Do not run a roleless arbitrary Node command.
   The command locks at most 100 source effects in ID order per transaction,
   inserts missing eligible deadlines and yields between batches. It can be
   restarted safely. Save its `scanned`, `deadlines`, and `missing` counts;
   `missing` must be zero before declaring backfill complete.
4. Reload through the existing safe PM2 deployment procedure. Only resolution
   and local all-role processes register the scheduler. HTTP processes do not.
   Startup immediately probes due work and admits old failed snapshot history.
5. Check overdue ages, failed jobs, snapshot repair age, deferred viewer age,
   and stage logs/metrics. `race_effect_expiry_stage_seconds` has bounded kind
   labels; sampled `[EFFECT_EXPIRY]` traces join deadline revision to race job
   generation without exposing user identities, steps or device data. Existing
   resolution phase traces provide authoritative commit timing.

The due range uses stable UTC database statement time so PostgreSQL can form
an indexed deadline bound. The scheduler caps candidate and per-race batches
at 100, bounds job lock waiting to 150ms, and temporarily bypasses a busy race
for five seconds. It does not scan active users/races each second. The original
five-minute recovery remains; the new bounded repair pass never re-enqueues a
healthy running/retryable generation. Recovery keyset cursors move past pending
post tasks; the legacy failure census examines at most 100 task and 100 receipt
rows per pass. Deferred viewer scope survives undispatched deadlines via an
internal generation-zero sentinel and resolves that sentinel under the job fence.
Failed/lost generations can be recovered even after their source deadline is gone.

## Rollback and compatibility

Roll back application code with the existing safe PM2 procedure. RETAIN the
additive schema, source triggers and all pending deadlines/intents. Older
writers continue maintaining deadlines and failed snapshot intents, while the
existing sweep remains available. Do not drop the trigger or pending data as
part of application rollback. A later re-upgrade drains retained work.

Notification ordering relative to other notifications and at-most-once intent
receipts are retained. Snapshot publication now precedes providers and has an
independent bounded scheduling lane in the existing process. A failed/ambiguous
snapshot remains terminal under its existing state contract; its atomic repair
intent creates fresh display work without replaying notification intents.

## Local evidence

Integration runs target dedicated local test databases, including
`steps-tracker-integration_test` for initial TDD and
`steps-tracker-expiry-review_test` for reviewer regressions. The parent final
regression run uses `steps-tracker-expiry-final_test`. Database identities and
loopback server addresses were verified before writes.
Production has not been mutated. TDD evidence and final load/regression results
are summarized by the parent release report. Latency limits apply to the tested
workload/hardware; they are not a million-user capacity claim. Old app binaries
still retain their normal polling delay, and offline devices have no visible
latency guarantee.

The backend implementation evidence includes these actual failing regressions,
followed by passing integration runs on the verified local database:

- Missing deadline capture and scheduler tables after public powerup activation.
- Provider delivery preceding snapshot publication; lost/failed publication
  lacking a durable repair receipt; missing or only queued newer generations
  incorrectly erasing the previous publication obligation.
- Undispatched deadlines with a locked job losing viewer scope; failed jobs
  stranding deferred viewers after the source deadline was removed.
- An already-running worker adopting an effect boundary while legacy post-task
  configuration was off, without a durable publication handoff.
- The original recovery sweep advancing healthy queued/running generations;
  twenty invalid-gate viewer reads advancing generation 2 to 22.
- Creator timezone fallback being replaced with UTC; a viewerless busy repair
  being acknowledged without a durable job; a deadline lookup failure turning
  a best-effort progress read into HTTP 500.

Acceptance coverage also executes extended-effect old deliveries through worker
and HTTP, real Redis concurrent full-snapshot writes rejecting an older
publication, full/compact/paged/team responses, notification non-replay,
index validity, bounded recovery fairness and the interrupted repair-ack path.
Representative timed scoring paths activate Runner's High, Compression Socks
and Leg Cramp over HTTP, upload real step samples, execute scheduler/worker/
publication, assert exact public totals, then upload post-expiry samples and
assert those new steps receive no expired modifier. No scoring constants changed.

Final backend-focused verification: 32 feature integration cases passed together,
then the same cases plus five retained post-task storage cases passed together
(37/37). A subsequent additional cleanup mismatch/repair-retention integration
passed (1/1). Thirteen post-task model/migration/handoff unit checks passed after
the cleanup correction. The correction uses a data-modifying CTE's `RETURNING`
rows alongside stored receipts, preserving all exact receipt mismatch checks
while allowing bounded cleanup to see receipts inserted in the same statement.
Full-repository and final load acceptance remain recorded in the parent release
report; these targeted counts do not replace those checks.
