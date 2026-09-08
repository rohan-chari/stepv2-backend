# Enrollment query production deployment — 2026-09-08

Deployed `7e4132cc7002b013ffbdf54d0db9a9bbb9605145` after explicit user
approval, on isolated production base `030aebdfa9d5843794ad0a09549a855c238ed67a`.
Only the reviewed candidate SELECT changed in application code. The release
also carries its integration tests, performance harness and evidence. Unrelated
local billing and research work was excluded.

The eight new integration tests passed again on this exact release using
isolated local PostgreSQL 18.4, then that local database was stopped. Existing
broader baseline failures remain documented in the [local results](global-event-enrollment-query-performance.md);
this is not a full-suite-green claim. The earlier architect and code reviews
apply to the identical source hash, retained in the evidence.

## Live measurements

Read-only production `pg_stat_statements` snapshots, activity and queue samples
were collected alongside 11 direct DigitalOcean managed-database CPU samples
per window. No statistics were reset. Both windows retained the same statistics
reset timestamp and eviction count (59), and statement deltas matched unchanged
database/user/query/toplevel/stats_since keys. There were no synthetic
production writes, integration tests, or EXPLAIN ANALYZE mutations.

| Measure | Before | After |
| --- | ---: | ---: |
| UTC window | 18:07:19–18:12:23 | 18:14:18–18:19:23 |
| Empty enrollment SELECT calls | 25 | 22 |
| Candidate rows returned | 0 | 0 |
| Aggregate enrollment execution | 8,094.3 ms | 1,971.6 ms |
| Mean execution per call | 323.8 ms | 89.6 ms |
| Aggregate shared buffers (hits + reads) | 358,362 | 50,939 |
| Mean shared buffers per call | 14,334.5 | 2,315.4 |
| Enrollment temp blocks written | 0 | 0 |
| Managed database CPU idle | 29.97% | 37.49% |
| Managed CPU user / system | 40.60% / 20.02% | 33.52% / 19.09% |
| Managed CPU I/O wait / steal | 1.08% / 4.27% | 0.65% / 5.55% |
| Matched cluster statement calls | 46,560 | 40,095 |
| Matched cluster execution time | 116.94 s | 136.83 s |
| App database committed transactions | 49,803 | 41,798 |

The selected empty query used **83.8% fewer buffers per call** and **72.3% less
execution time per call**. These are observed sequential live measurements,
not a controlled experiment. Statement volume fell roughly 14%, transaction
volume fell 16%, and other database work changed. CPU improvement therefore
cannot be attributed to this SELECT alone, and the 70% idle target is not met.
Cluster totals include matched monitoring statements and are lower bounds
rather than complete HTTP request counts. Query execution time includes waits.

The after window included post-reload queue recovery: sampled queued jobs
peaked at 34 and oldest queued age at 67.7 seconds, then reached zero by
18:16:20 UTC. No expired running leases were sampled. Database-wide temporary
bytes rose by 16,997,544 and rollbacks were 104 versus 44 before; these are not
attributed to the selected query, whose own temporary writes stayed zero.
Neither interval recorded a database deadlock. A read-only referral ledger
audit also ran during the after interval and reported zero missing rows.

## Release verification and limits

The serialized `pm2-safe-prod-reload.sh` finished successfully and saved only
after its final checks. Exactly two HTTP workers, one cron and one resolution
process were online, with the existing aggregate pool ceiling of 32. Staging
remained stopped. Local and public API health returned `status: ok` and
`redis: ok`. Subsequent PID/restart checks showed stable processes.

The existing production package-lock modification was preserved byte-for-byte.
No migrations, dependencies, configuration, capacity, API shape, or mobile
binaries changed. All 238 migration names were already applied. Two old failed
attempts each had a rolled-back record plus a successful application, with
zero unresolved attempts; the legacy checker misleadingly labeled these as
missing migrations. Its expected PROD_DATABASE_URL was absent on the server,
so the read-only check used the existing DATABASE_URL without printing it.

Fresh log inspection used saved byte offsets and bounded reads, retaining only
aggregate event/error counts in evidence. No matching unhandled exception,
connection exhaustion, Prisma query error, or immutable-fact conflict appeared.
No old enrollment query was active after reload. These checks supplement
integration coverage; they do not prove every live request succeeded.

The four latest future event parents retained their existing entitlements and
had zero failed starts. No new entitlements were created after reload during
observation. **Natural nonempty-cohort production verification remains pending**;
no production data was manufactured to force it. The previously documented
10,000-active-user dense-page timing tradeoff remains applicable.

The prior runtime artifact is `030aebdfa9d5843794ad0a09549a855c238ed67a`.
A rollback would restore that application revision through the same guarded
reload procedure, preserving the existing lockfile modification; no schema or
data rollback is required. No rollback was performed.

[Sanitized counters, CPU samples, queue samples and log verification](evidence/global-event-enrollment-query-production.json)
retain the underlying measurements.
