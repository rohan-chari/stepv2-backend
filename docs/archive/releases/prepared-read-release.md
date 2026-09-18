# Prepared read reuse release — 2026-09-07

Permanent protocol-level prepared-query reuse for the six SQL shapes measured in
the local benchmark: race/roster (with and without presentation), input versions,
scoring effects, global-event fingerprint, and bounded sample ranges. SQL text
has an explicit annotation; parameters, results, APIs, queue capacity, and older
iOS/Android client contracts are unchanged. Unmarked queries stay unchanged.

The application admits at most 128 distinct SQL texts per process pool and uses
stable hash names. Overflow runs unnamed. No eviction, automatic error replay,
runtime flag, dependency update, or schema migration is introduced.

## Validation

- Four protocol-plumbing tests were written first; all pass.
- New HTTP intake → actual worker → old-client progress test fails its naming
  assertion with the hook disabled and passes with the hook active. It checks
  returned step totals for distinct users/parameters and actual driver names.
- Production hook passes real Prisma transaction error/rollback, backend
  reconnect, additive column add/drop, and committed-value visibility through
  local PostgreSQL18 / PgBouncer1.25.2 transaction pooling.
- Three existing integration suites through that same pool: 39/41 passed.
  Two existing failures reproduced with the hook disabled and identical values:
  race-queue-v2-closure-scaling.test.js:576 counts483 race powerups vs1908;
  stepSyncV2.test.js:290 counts2 recovered emissions vs1. Neither assertion was
  weakened or skipped. The full integration suite is not claimed green.
- No Flutter changes; no new app build is required.

## Deployment dependency and recovery

Before deploying the application, enable the managed cluster's
pgbouncer.max_prepared_statements=128 and verify the value via GET configuration.
Probe protocol-level reuse on the actual transaction pool using separate clients
and repeated read-only transactions before reloading production. The setting is
required infrastructure compatibility, not a release flag. DigitalOcean exposes
it through its database configuration API.

Deploy only the reviewed application files and tests, using the safe PM2 reload
wrapper and exactly two HTTP workers. Preserve unrelated production lockfile
changes and keep staging stopped. No migration or seed is needed for this change.
Verify health, worker topology, pool budget, query errors, actual named-execution
metrics, and database CPU after deployment.

If regression requires recovery, revert this application commit and use the same
safe reload. Leave PgBouncer prepared support enabled until every client using
names has disconnected; turning it off first can break active prepared clients.
No data rollback is required.

References: [PgBouncer prepared support](https://www.pgbouncer.org/features.html),
[DigitalOcean configuration API](https://docs.digitalocean.com/products/databases/postgresql/how-to/reconfigure/).

## Production verification

Deployed application commit441f307 on 2026-09-07 EDT. Safe reload completed with
exactly two HTTP workers, one cron, one resolution worker, aggregate pool ceiling32,
and staging stopped. Health returned status/Redis ok. The unrelated production
package-lock checksum remained b84adca720b235c1b7e07f54f36df369a47e53ce28ecbcaf1b80eb659d4f60ac.
Referral catch-up dry-run reported zero raceActivities and reviewOwnership.

The runbook migration checker expected a stale PROD_DATABASE_URL variable;
direct read-only inspection using the deployed DATABASE_URL confirmed no missing
or failed migrations. No migrations were applied. An independent final-mode
pool-guard call lacked the required baseline file; the safe wrapper's own final
validation succeeded at32. Subsequent normal topology guard passed.

DigitalOcean's partial nested PATCH reset omitted PgBouncer timeouts to defaults.
Before application reload, a second PATCH restored the full prior object while
setting only max_prepared_statements=128. GET verified all prior values, including
server_idle_timeout=0 and autodb_idle_timeout=0. Future edits must preserve the
full nested object. Twelve named read-only transactions over three clients used
five backend PIDs successfully before application reload. A later backend census
showed annotated application statements and actual generic/custom plan counts.

Eleven CPU samples over five minutes averaged12.42% idle (range2.41–21.88%),
versus8.86% idle in the pre-deploy two-minute window. This is a modest observed
change, not a controlled causal estimate; the70%-idle target remains unmet.
PgBouncer counters increased by1513 named binds,48 client parses and117 server
parses. These confirm reuse, not total planning savings. PostgreSQL may still
choose custom plans. No process PID/restart changes or new stderr bytes were
observed in the post-reload error-log observation window.

The303.19-second SQL-statistics interval recorded111140 calls and226.77s summed
execution time (includes waits, not CPU attribution). Largest elapsed statements:

| Statement | Calls | Total execution seconds |
|---|---:|---:|
| Select unprepared durable capture roots |5467|11.74|
| Bounded sample ranges |212|10.39|
| Delivery-intent failure/pending counts |867|7.19|
| Notification release-lane row lock |138|6.70|
| Race job insertion |805|6.41|
| Notification schedule candidate repair |1|5.95|
| Global-event fingerprint |398|5.83|
| Post-task candidates |1445|5.63|

Last sampled queue:6 queued, oldest request28s, no running expired leases.
The finite monitors completed and disconnected; owned local test services stopped.
Evidence: /tmp/prepared-prod-before-cpu.jsonl,
/tmp/prepared-prod-after-metrics.jsonl, /tmp/prepared-prod-after-stats.jsonl,
/tmp/prepared-prod-after-analysis.json, /tmp/prepared-prod-deploy.log,
/tmp/prepared-prod-errors-final.jsonl. Follow-up must address the broader workload;
this narrow plan-reuse release does not explain or eliminate most production load.
