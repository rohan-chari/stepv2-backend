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
