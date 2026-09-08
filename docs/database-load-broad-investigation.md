# Database load investigation — 2026-09-07 EDT

Read-only production investigation after the scoring-lock release. No application
or production configuration change. All finite monitors completed and stopped.

## Findings

Five CPU samples over roughly two minutes averaged 12.82% idle, 54.11% user,
19.92% system, 7.46% steal, and 0.57% IO wait. PgBouncer's separately exposed
process CPU averaged 6.17%; that is already included in host CPU, not additive.
The node remains heavily loaded; sustained disk waiting is not indicated.

Database statistics show the application DB dominates transactions and data
changes. Other databases had little activity beyond managed-service monitoring.
The application DB recorded 35,526 commits, 9,165 tuple updates, and 2,349 tuple
inserts in the broad interval. Largest update counts: race jobs 1,808, post-tasks
1,704, durable capture roots 1,024, placement jobs 743, capture heads 602, snapshot
repair intents 577. These counters are work-volume evidence, not CPU attribution.

Autovacuum completed-time increase was 1.336 seconds and autoanalyze 6.763 seconds
over the interval. These are elapsed maintenance times, not CPU. There was no
new checkpoint completion; an ongoing checkpoint wrote 555 buffers. WAL grew
33.57 MB with zero wal_buffers_full increments. No evidence here that maintenance
alone explains sustained saturation. An old aborted idle session had no xmin or
active transaction; it was not executing or holding a vacuum horizon and was
left untouched.

## Corrected monitoring blind spot

Previous collection excluded all SQL containing pg_stat_, which also excluded
provider/diagnostic monitoring statements. The follow-up unfiltered 62.39-second
window tracked 14,390 calls (230.65/s) and 70.71 seconds aggregate execution.
The formerly excluded statements contributed only 24 calls / 0.411 seconds in
this interval. Thus that exclusion was a reporting weakness, not evidence of a
currently dominant hidden monitor. Future collectors must retain these statements
and categorize them instead. All statement tracking is top-level, avoiding nested
execution double counting; planning tracking remains off.

## New lead: repeated query planning

Non-executing EXPLAIN (SUMMARY TRUE, FORMAT JSON) probes used actual query text
and synthetic parameters from the existing local worker fixture. Five repeated
planning-only probes on production gave:

| Query shape | Planning time range (ms) |
|---|---:|
| Event fingerprint | 11.22–37.32 |
| Queue insertion | 0.84–4.74 |
| Race claim | 0.34–3.69 |
| Sample ranges | 0.51–6.87 |

An initial event-fingerprint probe took 78.65 ms. These timings include contention
and use fixture parameters; they cannot establish application-wide planning CPU
or a percentage saving. They demonstrate that planning is not uniformly free.

Installed @prisma/adapter-pg performIO passes text, values, rowMode, and types
to node-postgres without a statement name. The DigitalOcean configuration GET
confirmed pgbouncer.max_prepared_statements=0. Named prepared-plan reuse is
therefore not configured on this path. PgBouncer's named-parse counters were
zero in its current rate metrics; those counters do not measure unnamed parsing.

The application DB role cannot SET pg_stat_statements.track_planning. The returned
managed configuration and documented API do not expose that setting. Do not
promise an application-wide planning measurement by simply issuing SET.

## Next controlled experiment

Reproduce the real Prisma + transaction-pool path against local test Postgres
and PgBouncer. Compare unchanged queries with bounded named-statement reuse on
representative data, including varying parameters, custom/generic plans, connection
reassignment, and schema invalidation. Measure planning and execution separately,
CPU, throughput, and query-result parity. In parallel, attribute frequent job
generations to trigger sources before removing any necessary work. Do not deploy
another isolated SQL tweak on the assumption it explains most CPU.

Prepared reuse is a measured lead, not a confirmed root cause or a promise of
70% idle. Production pool changes and application releases require fresh approval.

References: [PostgreSQL statement statistics](https://www.postgresql.org/docs/18/pgstatstatements.html),
[node-postgres prepared queries](https://node-postgres.com/features/queries),
[PgBouncer statistic definitions](https://github.com/pgbouncer/pgbouncer/blob/master/doc/usage.md),
[DigitalOcean PostgreSQL API](https://docs.digitalocean.com/products/databases/postgresql/reference/api/).

Evidence: /tmp/db-broad-2min.jsonl, /tmp/db-broad-cpu.jsonl,
/tmp/db-unfiltered-1min.jsonl, /tmp/db-unfiltered-5min-analysis.json,
/tmp/db-plan-probes-result.jsonl, /tmp/db-plan-probes-repeated.jsonl,
/tmp/db-pool-metrics.jsonl. The local analysis filename includes 5min for
historical script compatibility; the unfiltered interval is 62.39 seconds.
