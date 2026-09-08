# Local prepared-plan experiment — 2026-09-07

This is a diagnostic benchmark, not a production change or a full race-worker
load test. No API, app behavior, production configuration, or production rows
were changed. Frozen iOS/Android clients are unaffected.

## Method

PostgreSQL 18 with pg_stat_statements.track_planning enabled; PgBouncer 1.25.2
in transaction mode with three server connections and up to six adapter client
connections. Both poolers target the same dedicated local test database.
Baseline uses unnamed Prisma adapter queries and max_prepared_statements=0.
Candidate attaches deterministic statement names to the same query configs and
uses max_prepared_statements=128. Six SQL shapes were observed. The experiment
wrapper is not a production-ready statement-cache implementation.

Fixtures: 1,000 synthetic users, 800,000 step samples, 105 legacy global events,
and races with 1, 25, 100, and 500 participants. Every size exercises both
presentation and scoring-only fingerprint paths. Each unit calls the actual
buildRaceResolutionInputFingerprint and findRowsForUserRangesOn model helpers
through PrismaPg. Parameters vary across 40 combinations. Complete returned
fingerprints and samples must match, not just row counts.

Each window warms 40 units and measures 3,000 units / 15,000 SQL calls.
At concurrency 1 and 3, run order is baseline, candidate, candidate, baseline.
Planning/execution totals are pg_stat_statements deltas. CPU sums PostgreSQL
parent and surviving direct-child process CPU counters from ps, with 10ms
resolution per process. It excludes PgBouncer and Node CPU, includes PostgreSQL
background activity, and is not production host CPU utilization. Backend
processes remain alive during measured windows; reconnect testing follows them.

The initial subsecond pilot was rejected for quantitative CPU conclusions.

## Compatibility checks

After timing, reuse the existing adapter clients after PgBouncer RECONNECT;
verify all 40 parameter combinations. Add and drop an unused races column and
verify the same combinations on both sides of the schema change. Finally commit
a display-name change and verify both modes see the new name.

These checks cover backend replacement and additive DDL for these selected
queries. They do not prove compatibility for all application transactions,
parameter type changes, destructive migrations, or every production query shape.

## Reproduction

Use an isolated local PostgreSQL 18 instance, with this branch's schema migrated
into steps_query_efficiency_test. Start PostgreSQL with
shared_preload_libraries=pg_stat_statements and
pg_stat_statements.track_planning=on. Listen only on 127.0.0.1:55438.
The script rejects any other host/port or a database name without _test suffix.

Start two local PgBouncer instances on 56438 and 56439. Both database entries map
steps_query_efficiency_test to 127.0.0.1:55438/steps_query_efficiency_test.
Use transaction pooling, default_pool_size=3, max_client_conn=50,
ignore_startup_parameters=extra_float_digits,options, and the local database user
as admin_users. Set max_prepared_statements to 0 and 128, respectively. Use
separate local pid/log/socket paths. Authentication must be confined to localhost.

Run from the backend checkout (replace the datadir with your owned local path):

```sh
DATABASE_URL=postgresql://rohan@127.0.0.1:55438/steps_query_efficiency_test \
BENCHMARK_PG_DATA_DIR=/path/to/owned/local/pgdata \
NODE_ENV=test node scripts/diagnostics/prepared-plan-local-benchmark.js
```

The script deletes its fixture rows in finally. Stop the two owned poolers and
the owned PostgreSQL instance after the experiment. Do not target production or
reuse a test database while another suite is running.

## Results

All eight windows and all compatibility/parity checks passed. Values below pool
two 3,000-unit windows per mode and concurrency.

| Concurrency | Mode | CPU ms/unit | Units/s | Planning ms/15k calls | Execution ms/15k calls |
|---|---|---:|---:|---:|---:|
| 1 | unnamed | 3.213 | 157.1 | 2463.51 | 4871.73 |
| 1 | named | 1.928 | 178.7 | 5.98 | 4831.70 |
| 3 | unnamed | 3.240 | 206.5 | 2592.99 | 4987.53 |
| 3 | named | 1.923 | 210.5 | 0.00 | 5005.18 |

PostgreSQL CPU per unit decreased **40.0% at concurrency 1** and **40.6% at
concurrency 3**. Throughput increased about **13.8%** and **1.9%**, respectively.
Baseline planned every call (60,000 plans); the candidate recorded 83 plans
across 60,000 measured calls after warmup. Execution time was essentially
unchanged. The event-fingerprint shape contributed roughly 53% of baseline
planning time in this selected workload.

This is strong local evidence that avoiding repeated planning saves CPU for
these queries. It is not evidence that production CPU will fall by 40%, nor a
promise of 70% idle. The fixture omits writes, queue triggers, full worker and
HTTP paths, production contention/data skew, and managed-host overhead. The
small throughput gain at concurrency 3 also limits any scaling claim.

Next: implement a bounded, reviewed adapter-level prepared-query strategy and
verify real HTTP/worker transactions, error/retry paths, and a wider query-shape
set against the local pool. A production trial then needs both the application
change and compatible managed PgBouncer configuration, followed by measured
CPU/query-volume comparison at comparable completed work. Production approval
is required separately. Do not simply raise queue concurrency.

Measured JSON is in prepared-plan-local-results.json. The original stdout also
contains a dotenv banner; the committed artifact contains only JSON records.
The final script replaces the run's machine-specific datadir literal with the
required BENCHMARK_PG_DATA_DIR environment variable; measurement logic is identical.

Validation: node --check and git diff --check passed. Required code-reviewer
review passed with no blockers after the measurement improvements. This local
diagnostic does not replace the HTTP/integration suite for a future application
change; no app code changed in this experiment.
