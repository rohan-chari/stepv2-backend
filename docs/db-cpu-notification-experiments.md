# Notification recovery experiments — CPU remediation D

**Disposition: retain the existing notification recovery SQL.** Neither tested rewrite passes the specification's total-work gate. Faster individual executions in some distributions came with significantly more buffer work, or regressed other distributions. No production notification code or migration was changed.

## Reproduction and fixture

Scripts and immutable baseline SQL: `test/integration/fixtures/cpu-remediation-notification/`. Each script asserts the exact owned target `postgresql://rohan@127.0.0.1:55439/cpu_remediation_notification_test` before connecting. The database was created empty and migrated on local PostgreSQL 18. No staging/production connections or real-user data were used.

`experiment.cjs` compares the existing materialization-gap and target-snapshot queries with materialized candidate sets and indexed lateral probes. It seeds 2,000 relevant global-event schedules and grows total history from 4,000 to 40,000 rows. Distributions are healthy (zero gaps), sparse (two gaps), and alternating gaps (1,000 gaps; normal update limit 500). It checks exact SELECT IDs and complete UPDATE-returned IDs for equivalence, captures `EXPLAIN (ANALYZE, BUFFERS, WAL, TIMING OFF, FORMAT JSON)` for both candidate SELECT and complete UPDATE, warms both shapes, and performs three matched repetitions. Updates are rolled back in this disposable database. The preserved query has not been changed between baseline and candidate fixture runs.

`cursor-experiment.cjs` measures an alternative bounded keyset page plus lateral probes over a full sweep. Cursor state exists only inside the experiment; no persistent schema or production cursor was installed. Gaps near the end of relevant history are visited after several healthy pages. Full-cycle cost includes all page queries and planning, not just the first bounded page. For gap-heavy populations the diagnostic baseline uses one query with a 50,000-row output limit to inspect all gaps, so that row is an optimistic lower bound, not the actual 500-row production cadence; healthy/sparse comparisons inspect identical complete populations and supply the decisive rejection evidence.

`admission-contention.cjs` acquires the existing `visible:GLOBAL_EVENT_STARTED` lane row, verifies a second connection is actually waiting on a PostgreSQL lock, then times the full 500-row UPDATE and the waiting connection's release. It runs three repetitions on the same 40,000-row alternating-gap fixture. Both transactions are rolled back. The first baseline was cold; it is retained rather than silently discarded.

Reproduce in order using the explicit URL above and `node` on `experiment.cjs`, `cursor-experiment.cjs`, then rerun `experiment.cjs` before `admission-contention.cjs` to restore its matching fixture. These are diagnostic scripts, not application integration-test replacements. Do not run them on another database.

## Complete UPDATE results

Medians of three repetitions; elapsed executor milliseconds and total shared-buffer hits at the plan root. Full plans, planning time, reads, dirtied buffers, WAL and all repetitions are retained in `docs/evidence/cpu-remediation-notification/experiment.json`.

| History / distribution | Query | Existing → candidate ms | Existing → candidate shared hits |
| --- | --- | --- | --- |
| 4,000 healthy | Materialization | 1.067 → 2.239 | 220 → 10,117 |
| 4,000 sparse | Materialization | 1.094 → 2.491 | 268 → 10,240 |
| 4,000 gaps | Materialization | 5.339 → 5.339 | 11,786 → 15,011 |
| 40,000 healthy | Materialization | 12.176 → 5.666 | 2,187 → 15,100 |
| 40,000 sparse | Materialization | 9.215 → 7.027 | 2,234 → 15,985 |
| 40,000 gaps | Materialization | 14.352 → 8.510 | 16,428 → 18,693 |
| 4,000 healthy | Missing snapshot | 0.667 → 0.648 | 104 → 104 |
| 4,000 sparse | Missing snapshot | 0.679 → 0.702 | 160 → 160 |
| 4,000 gaps | Missing snapshot | 3.888 → 4.720 | 9,706 → 15,444 |
| 40,000 healthy | Missing snapshot | 6.578 → 6.662 | 1,060 → 1,060 |
| 40,000 sparse | Missing snapshot | 6.519 → 6.578 | 1,118 → 1,118 |
| 40,000 gaps | Missing snapshot | 10.058 → 13.863 | 20,857 → 19,759 |

The materialization lateral probes avoid scanning unrelated joined history, but replace sequential/hash work with many index probes. They regress the smaller history and increase buffer accesses at both sizes. The snapshot candidate is effectively neutral for healthy/sparse cases and regresses the complete gap-heavy mutation. Output equivalence alone therefore does not justify either rewrite.

## Cursor and admission results

Full-cycle medians at 40,000 rows, from `cursor-experiment.json`:

| Distribution / query | Existing → candidate cycle ms | Existing → candidate shared hits |
| --- | --- | --- |
| Healthy materialization | 9.803 → 5.086 | 2,198 → 15,078 |
| Sparse materialization | 9.713 → 9.742 | 2,245 → 16,816 |
| Healthy missing snapshot | 7.123 → 24.694 | 1,100 → 81,250 |
| Sparse missing snapshot | 7.229 → 27.999 | 1,158 → 82,526 |

The materialization cursor examines the relevant schedules over five page calls including the closing page. The snapshot cursor takes roughly 80 pages. A bounded page is cheaper than a whole sweep; total sweep work is substantially higher. Persisting that cursor would also add state writes and coordination absent from this test, so the measured candidate already fails before charging those costs. No recovery-latency/schema revision is proposed for a rejected option.

With a competing admission-lane waiter, the baseline full UPDATE took 71.1 ms cold, then 16.6/16.5 ms; the lateral candidate took 16.3/8.3/8.4 ms. The waiter became available approximately 0.2–0.35 ms after each UPDATE and rollback. This confirms lane-hold reduction is plausible for this specific fixture. It does not outweigh buffer amplification and the small-history regression. No p95 or provider throughput claim follows from three samples.

## Application correctness checks

**Final targeted run: 14 tests passed, zero failures/skips across four suites (3.109 seconds).** See `contract-tests-final.log`.

The initial targeted real-database run selected 14 existing tests: 13 passed and one failed. Passing checks included actual Inbox HTTP unread counts, list/read ownership, absent `inbox_v1`/authentication errors, completeness repair of all four gap types, admission-lane serialization, provider deduplication, scheduled release and transient/permanent dispositions. Complete notification code remained unchanged by this task.

The existing `centralized-notification-delivery.test.js` test `local provisioning stays notification-free and boundary activation projects durably` failed at line 294 (`boundary.starts`: 0 rather than 1). The identical failure was reproduced on the unmodified `de7e895` baseline checkout. Its August 2026 fixture calls `ensureEntitlementForUser`, which now uses `max(supplied now, Date.now())` for persisted users and rereads authoritative `user.timezone`; the fixture supplies only `globalEventTimezone`. On September 10 its event is already expired. After surfacing this finding, the orchestrator authorized a fixture-only correction: move that event window/day from August 2026 to August 2098, set both authoritative `timezone` and `globalEventTimezone` to America/New_York, and inject the same boundary clock into the real notification-intent service passed to the projector. Without the final clock injection, the real intent service correctly treats the future notification as scheduled, rather than immediately visible. Every original assertion is unchanged. The corrected fixture passes against unchanged baseline application source and candidate source. No notification behavior was bypassed or mocked.

The first candidate-suite attempt also encountered the concurrent root-sweep migration missing from this agent's database after shared `setup.js` was updated. The new additive migration was applied to the owned test database, and the targeted tests were rerun; the initial 13/14 result above is the post-migration result, not the earlier setup failure. The original failure and corrected baseline/candidate test logs are retained separately.

## Limits and next action

This fixture tests one recipient with many source keys and a tenfold unrelated-history increase, not every possible production distribution. PostgreSQL executor/planning elapsed, buffers and WAL are measured; backend CPU seconds, managed-host CPU, provider contention and PgBouncer behavior were not measured in these SQL experiments. No CPU percentage reduction is claimed. Rolled-back updates still create temporary MVCC/WAL work; fixture vacuum/warmup and repetition order are retained in the scripts.

D is investigated with measured rejection of these concrete rewrites. Keep existing durable recovery, delivery keys, source revisions, admission ordering and five-minute fallback. Revisit only with new evidence supporting an index/retention/source-backed gap ledger or different query shape that reduces total work across the matrix. The parent should use the proven changes in other remediation items for the current candidate and preserve D as an explicit no-change result.
