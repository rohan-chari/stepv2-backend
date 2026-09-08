# Notification parent completion performance

## Problem and correction

`completeNoDevicePlacementProjectionsBatch` finishes silent placement refreshes
for recipients without eligible device tokens. After completing at most 100
projections it checks whether their parent events have unfinished children.
With stale statistics estimating one active row, PostgreSQL could reorder that
check into repeated scans of unrelated active parents and materialized child
rows. A growing backlog therefore made each fixed-size batch progressively
slower. Production capture on September 7, 2026 recorded eight completed calls
averaging 67.5 seconds in the final ten windows (40% of tracked execution time).
Execution time includes waits and is not a measurement of per-query CPU.

The correction materializes finishable parents using a correlated LATERAL
lookup with OFFSET 0. This prevents flattening the lookup across all active
parents. The final UPDATE retains its expanded/nonterminal guards. Projection
claiming, SKIP LOCKED, batch limits, expiry rules, failed-sibling handling and
the exclusion of projections completed by the same statement are preserved.
No indexes, migrations, runtime controls, API fields or client changes are
required. Existing iOS and Android clients use the same behavior.

## Integration reproduction

All writes and EXPLAIN ANALYZE updates ran on an isolated localhost PostgreSQL
18.4 test database, matching production's major version (18). No production
integration tests were run. Seed 20,000 terminal events and projections,
ANALYZE them, then add pending work without refreshing statistics. Autovacuum
is disabled only on these three local fixture tables during the experiment
and restored in finally. Each measured full UPDATE runs inside a transaction
that is rolled back. Baseline queries have an eight-second SET LOCAL timeout.

Final local run, fixed batch size 100:

| Pending backlog | Old full UPDATE | Candidate full UPDATE |
|---:|---:|---:|
| 100 | 40.9 ms | 5.7 ms |
| 500 | 965.4 ms | 8.4 ms |
| 1,500 | exceeded 8,000 ms | 19.2 ms |
| 3,000 | exceeded 8,000 ms | 30.6 ms |

Separately, start the real cron entrypoint, observe its SQL and verify that it
drains actual persisted projections and parents. Replaying that observed full
UPDATE against the 1,500-row fixture took **68.9 ms**; the old query again
exceeded 8,000 ms. Candidate selection still grows with pending work; this is
not a claim of constant total execution time or a production throughput ceiling.
These measurements are local execution times, not production CPU forecasts.

The tests existed before the implementation. The candidate experiment passed
while the real-cron test failed because the old worker did not bound parent
completion. The source was then changed. Four final regression tests pass:

- Growing-backlog full-UPDATE comparisons and persisted outcome parity.
- Real cron execution, draining, and observed-SQL performance replay.
- Exact per-record parity for failed/pending/leased siblings, event and audience
  expiry, deleted recipients, active and legacy device tokens, malformed expiry,
  terminal parents, incomplete expansion, missing audience, expired lease and retry.
- A separate transaction locks a projection; the worker query skips it and
  completes only the available parent.

Review corrected the performance assertion to measure execution time, because
rescanning materialized rows can consume CPU without proportional buffer reads.
The real-worker observation is independently available to each test, so running
an individual behavior case still exercises production SQL.

## Validation limits

The broader notification-domain-isolation suite has four failures in this
checkout: support staff-message authorization (403 vs 201), placement producer
emission, daily-mover producer emission, and a retention response assertion.
All four were reproduced with identical configuration on unchanged deployed
commit 1483b89 in a separate checkout. Existing assertions were untouched.
The combined earlier run was 20 passed / 4 failed; after test consolidation,
the final dedicated regression run was 4 passed / 0 failed / 0 skipped.
Code review found no remaining blockers, issues or nits.

Evidence logs: `/tmp/notification-parent-red.log`,
`/tmp/notification-parent-edges-before.log`, `/tmp/notification-parent-final.log`,
`/tmp/notification-parent-validation.log`, and
`/tmp/notification-parent-baseline-failures.log`.

Production deployment requires fresh explicit authorization. After deployment,
verify service health and compare interval deltas for the notification completion
query, notification backlog and database CPU; latency improvement alone does not
prove that total CPU has fallen.
