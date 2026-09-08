# Production database CPU diagnosis — September 7–8, 2026

Read-only investigation of deployed backend `adbae07`, approximately 23:49–23:54 EDT September 7 (03:49–03:54 UTC September 8). No deployment, restart, configuration change, cancellation, or application/database mutation was performed. Diagnostic files were temporary. Staging remained stopped; two HTTP workers plus existing dedicated cron/resolution processes were observed.

## Confirmed defect: pending races continuously repair impossible snapshots

Three pending races repeatedly cycle through full resolution and failed snapshot publication:

| Race ID | Actual members | Repair records at 03:51 UTC | Generation at 03:51 UTC |
| --- | ---: | ---: | ---: |
| 00e29cee-ba79-4698-a08b-b69046f3569e | 10 | 39,020 | 71,354 |
| 1f3b489d-2968-425d-9f87-27c13a7caa55 | 6 | 31,082 | 62,153 |
| 7f668f32-4542-4a3b-9b5f-1e915c29e663 | 26 | 12,545 | 25,089 |

All three have status `pending`, null `started_at`, and null `ends_at`. They have members, but their resolution attempts process zero participants because the races are not active.

Resolution logs from 03:47:12.658–03:50:46.682 UTC contain 661 completed attempts. Of those, 552 (83.5%) have only `DISPLAY_REFRESH`, zero processed participants, and zero changed rows. Claims map these attempts to the three races (the first partial log entry has no retained claim). Each race ran approximately 184 times in 214 seconds, or about 155 combined empty resolutions per minute. Another 40 attempts also changed no rows; those are not automatically classified as defects.

The live code and database establish this cycle:

1. `getRaceProgress.computePersistedSnapshot` returns null for any race whose status is not `ACTIVE` (`src/modules/races/queries/getRaceProgress.js`, deployed line 2598).
2. `publishSnapshot` converts that null to failed publication (`src/modules/races/services/raceProgressSideEffects.js`).
3. The post-task runner records `failed_no_retry` / `SNAPSHOT_NOT_PUBLISHED` (`src/modules/races/jobs/raceResolutionPostTaskRunner.js`). Latest tasks for all three races have exactly this state and error.
4. The live PostgreSQL function `maintain_race_snapshot_repair` inserts a new repair intent for every failed or ambiguous task. Its actual definition was read from `pg_proc`.
5. `drainSnapshotRepairs` suppresses repair only for `completed` and `cancelled` races. A pending race passes through, receives a higher generation, and is enqueued as `DISPLAY_REFRESH` (`src/modules/races/models/raceSnapshotRepairIntent.js`, deployed lines 66–112).
6. The new attempt commits another empty resolution and creates another impossible snapshot task. Its failure produces a fresh repair identity, so terminalizing the previous intent does not stop the cycle.

Repeated observations show generation increasing by 58 for each race in roughly 39 seconds and repair rows continuing to accumulate. `race_progress_refresh_intents` was empty. The queue usually held only 1–5 jobs with low age: low backlog masks rapid useless throughput.

## Why the recent changes did not stop this

- The terminal-race repair fix handles completed/cancelled races but leaves pending races eligible for repair, despite publication requiring active status.
- `adbae07` stops HTTP progress reads from creating refresh work. This loop is fed by background snapshot failures and a database trigger; it does not require additional HTTP reads.
- `0e02fd1` reduces empty post-task handoff work, but does not remove the self-replenishing repair chain.
- Prepared-plan and sample-cache optimizations reduce selected query costs; they do not eliminate this source of jobs.

These changes may have provided savings, but their local query-count improvements cannot establish production-wide CPU improvement.

## Managed database CPU and fresh statement deltas

Direct authenticated DigitalOcean managed-database metrics confirmed `stock-sentiment`, `db-s-1vcpu-2gb`, PostgreSQL 18.6. Five samples, 30 seconds apart, from approximately 03:50–03:52 UTC:

| Metric | Average | Range |
| --- | ---: | ---: |
| Non-idle CPU (100 − idle) | 89.08% | 83.63–93.77% |
| User CPU | 54.62% | 46.58–59.68% |
| System CPU | 21.86% | 19.07–23.38% |
| IRQ + soft IRQ | 5.31% | — |
| I/O wait | 0.51% | 0.17–0.93% |
| CPU steal | 6.80% | 2.95–12.36% |
| PgBouncer process CPU | 7.46% | 6.59–7.83% |

PgBouncer is already included in host CPU; do not add it again. Steal is unavailable VM CPU time, not application execution. It is a material additional capacity issue, not an explanation for all the load. The observed window is not dominated by disk wait.

Unfiltered `pg_stat_statements` deltas from 03:49:59.208 to 03:51:02.502 UTC (63.294 seconds) captured 18,895 statement calls, approximately 299/s, and 31.53 seconds of cumulative execution time. No statistics reset or statement deallocation occurred across this interval.

Text-based workload groups (useful categorization, not per-process or per-query CPU attribution):

| Group | Calls | Execution time |
| --- | ---: | ---: |
| Durable step-capture queries | 8,045 | 4.78 s |
| Resolution/post-task/repair/placement queries | 4,926 | 9.29 s |
| Queries containing pg_stat_ (including this investigation) | 15 | 0.97 s |

The largest individual execution-time entry was post-task finish/receipt creation: 184 calls, 1.50 seconds. No single completed SQL statement dominates the interval. Application DB counters rose by 1,859 inserted tuples and 4,223 updated tuples; this is a workload with substantial bookkeeping, including the defective loop. Approximately 525k block accesses were over 99% buffer hits. Other application databases showed little activity in this sample.

Adjacent HTTP telemetry for 03:49 UTC recorded 218 total requests across both HTTP workers, including 20 step-sync requests. That is approximately 3.6 HTTP requests/s, alongside hundreds of SQL statements/s; the amplification includes background work and must not be described as every request individually issuing that many queries.

Activity samples showed no persistent long-running application SQL or repeated lock-wait pileup. Brief autovacuum activity was observed; the sampling does not quantify all maintenance CPU. The only long-lived session returned by the later probe was the normal pghoard WAL sender waiting on `WalSenderMain`.

## Attribution limits

The repair loop is proven unnecessary work and dominates resolution attempt count. Its exact fraction of database CPU has not been measured. PostgreSQL execution time includes elapsed execution, and planning is a separate measurement; it is not per-query CPU. Production `pg_stat_statements.track_planning` and `track_io_timing` are off. See [PostgreSQL pg_stat_statements documentation](https://www.postgresql.org/docs/17/pgstatstatements.html).

The first statement snapshot itself contributed about 0.89 seconds to the interval. Later diagnostic aggregate reads took additional time outside that interval; one recent-task read hit its five-second read-only statement timeout and was replaced with indexed per-race generation lookups. Do not include later diagnostic load in the original interval or call monitoring entirely free.

## Recommended repair and verification

1. Make snapshot publication distinguish a race for which a live snapshot is inapplicable from a retryable publication failure. Align repair eligibility with the publisher's active-race requirement, including existing pending-race repair intents. Preserve correct behavior when a pending race subsequently starts and when status changes concurrently.
2. Write an integration regression using the real resolution worker, post-task runner, PostgreSQL trigger, and repair drain. Run several cycles for a pending race and assert no unbounded generation/repair growth. Also cover race start, active-race genuine publication failure, and completed/cancelled races. No scoring-rule or client API change is needed.
3. After an authorized fix deployment, confirm these three race generations stop growing while pending, repair creation stops, and empty `DISPLAY_REFRESH` attempts disappear. Compare direct managed CPU, statement rates, legitimate step intake, and useful scoring throughput over comparable 5–10 minute windows. Do not claim the 70% idle target from an attempt-count reduction.
4. Re-profile the residual workload. Durable capture already represents roughly 43% of observed statement calls; target redundant per-page/per-method bookkeeping only with real input and recovery semantics preserved. Continue measuring planning/protocol overhead rather than relying solely on execution-time ranking.
5. If CPU steal remains elevated, investigate the managed host with DigitalOcean. Resizing may provide headroom but does not correct the repair loop.

Investigation only: no production fix or test run is claimed by this report.

## Authorized hotfix deployed on main

User explicitly authorized hotfix and production deployment. Commit `86d239c`
was pushed to origin/main and deployed using the production safe-reload wrapper.
Only repair eligibility changed: non-active races now retire historical repair
intents, preserving failure records and normal race-start admission. No migration,
dependency, runtime flag, scoring, or mobile API change was required.

New real-worker/trigger regression failed before the fix (generation 7 versus 1
across three cycles), then passed including HTTP start and successful active-race
snapshot publication. All 27 relevant integration tests passed on a fresh local
`*_test` database. Flutter analysis was clean. Required code review approved.
The full backend suite was not run for this narrow hotfix.

The runbook's migration-check helper could not run because it expects an absent
PROD_DATABASE_URL alias. An explicit read-only query using the configured app
connection confirmed every deployed migration applied and no unfinished migration.
The existing production package-lock metadata edit was preserved. No install or
migration was needed. The reload wrapper completed successfully with two HTTP
workers, one resolution worker, one cron worker, and aggregate pool ceiling 32.
Staging remained stopped. Referral-ledger read-only audit found zero missing rows.

Post-deploy observations, 04:01:27–04:07:37 UTC:

- All three incident generations stayed fixed at 72124, 62925, and 25819.
- Zero outstanding repair intents for those races throughout; no new task
  generations. Final confirmation covered more than six minutes.
- The observed queue peaked at 96 queued jobs during a global-event boundary
  burst and subsequently drained to zero. A transient expired lease and post-task
  transaction timeout occurred during that burst; later samples cleared.
- Retained worker logs from 04:02:21–04:05:33 contained 270 commits and no pure
  DISPLAY_REFRESH attempts. Work included STEP_INPUT_CHANGED, GLOBAL_EVENT_BOUNDARY,
  and RACE_START, so this was not a matched-traffic comparison with the baseline.
- Eleven direct CPU samples over five minutes averaged 82.99% busy; the latest
  sample was 43.38% busy. Average steal remained 9.41%. The 70% idle target is not
  established by this window or by one lower final sample.
- A 306.675-second statement delta contained 68,337 calls (~223/s versus ~299/s
  in the earlier diagnostic window). Remaining work included step sample reads,
  global-event summary work, event impacts and notifications. Execution-time
  rankings still do not establish per-query CPU attribution.
- Final public health: API and Redis OK; production HEAD remained `86d239c`.

The hotfix is deployed and the targeted infinite loop is verified stopped.
Sustained overall CPU remains a separate follow-up, especially under event bursts.
