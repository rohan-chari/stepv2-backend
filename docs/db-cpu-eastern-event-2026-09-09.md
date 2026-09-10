# Database CPU during Eastern daily event — 2026-09-09

Read-only production investigation, approximately 19:09–19:14 UTC (15:09–15:14 EDT). Runtime commit `3292872a31fb270773ab729ee00aeedfeb1e5875`. Two HTTP workers, one cron and one resolution worker; staging stopped. No deployment, application data mutation, configuration change, statistics reset, or application query cancellation.

## Findings

DigitalOcean direct managed PostgreSQL metrics confirm `db-s-1vcpu-2gb`, PostgreSQL 18.6. Eleven scrapes over approximately 2.5 minutes averaged **75.24% non-idle CPU**, range **69.44–85.17%**. Exporter values repeat between refreshes; these are scrape-sample summaries, not eleven independent measurements. Average user CPU 39.41%, system 23.68%, IRQ/soft IRQ 4.52%, I/O wait 0.91%, steal 6.73%. PgBouncer averaged 4.97%, already included in host CPU. Low disk wait makes this predominantly execution/overhead and shared-CPU contention rather than a disk-wait incident.

The workload is distributed. No individual query accounts for most recorded query CPU. In nine completed pg_stat_monitor buckets, 19:01–19:10 UTC, 146,044 calls were recorded (270.45/s, including SET/transaction bookkeeping). Recorded query CPU was 51.42 seconds; planning elapsed time was 417.26 seconds and execution elapsed time 821.90 seconds. These metrics have different scopes and must not be added or represented as host CPU percentages.

| Application role | Calls | Recorded query CPU | Share of recorded query CPU | Planning elapsed |
| --- | ---: | ---: | ---: | ---: |
| Resolution worker | 62,808 | 23.88 s | 46.4% | 105.13 s |
| Both HTTP workers | 60,884 | 19.79 s | 38.5% | 257.08 s |
| Cron worker | 22,168 | 7.58 s | 14.7% | 54.93 s |

The extension's query CPU accounts for only part of managed host CPU. Planning time is elapsed time, subject to scheduling/contention; it is not a measurement of planner CPU. In particular, 19:05 alone recorded 210.97 seconds of planning and 357.66 seconds of execution elapsed across concurrent sessions, but only 6.12 seconds of recorded query CPU. Do not interpret that as a single CPU executing 568 seconds of work in a minute. No direct historical CPU series was retrieved for 19:05.

## Concrete hotspots and source paths

- **Race scoring/event fingerprint:** query ID `-5241993135095131194`, 1,003 calls, 2.70 seconds recorded CPU, 21.26 seconds execution elapsed, 628,672 buffer hits. Largest single recorded query-CPU entry, but only 5.3% of that total. `src/modules/races/services/raceResolutionInputFingerprint.js:121` loads event eligibility/impacts for protected scoring attempts. The surrounding fingerprint reads also load participants, effects and scoring input versions. Repeated validation protects concurrency; removing it blindly is unsafe.
- **Step-sample range reads:** query ID `8055839263049160421`, 488 calls, 1.37 seconds recorded CPU, 23.71 seconds execution elapsed, 4,132 disk block reads. `src/modules/steps/models/stepSample.js:142`. This is already bounded/batched; further reduction should target repeated ranges and actual input changes.
- **Notification completeness scans:** two query families, each called twice, together consumed 2.23 seconds recorded CPU and 5.09 seconds execution elapsed, accessing 355,829 cached blocks and reading 8,554 disk blocks. `src/modules/notifications/jobs/notificationCompletenessReconciler.js:140` and `:212`. Output LIMIT does not bound the search through already-complete historical schedules/outboxes. Runs every five minutes and immediately again if a full page is repaired. A measurable optimization candidate, not the sole cause of sustained CPU.
- **Post-task finish/receipt creation:** query ID `-1687289925696922947`, 561 calls, 16.17 seconds planning elapsed versus 13.52 seconds execution elapsed. `src/modules/races/models/raceResolutionPostTask.js:600` performs finish plus immutable receipt verification. Unlike selected named worker claims, this query is unannotated. Evaluate safe plan reuse and reducing task creation before changing receipt guarantees.
- **Viewer active-event lookup:** query ID `4282444812282879035`, 462 calls, 14.90 seconds planning elapsed versus 7.55 seconds execution elapsed. `src/modules/steps/services/viewerActiveEventReadBatch.js:12`. Already named/prepared; naming alone does not guarantee generic-plan reuse. Compare query simplification or scope-specific shapes against current custom plans in local tests.
- **Step-input version lock:** query ID `-9182621874641820375`, 392 calls, 76.85 seconds execution elapsed but just 0.18 seconds recorded CPU. Brief transaction-ID lock waits were observed live. It is the largest elapsed-time entry, not the largest CPU consumer.

HTTP telemetry for the same nine-minute window recorded 5,155 requests, including 423 step-intake requests; two 5xx in the other category and none in step intake. Worker logs show 563 resolution attempts: 471 included STEP_INPUT_CHANGED, 53 DISPLAY_REFRESH, 42 POWERUP_MUTATION, 50 FULL and 8 EFFECT_BOUNDARY (reasons overlap). There were 423 dependency-closure and 140 full plans; 126 attempts changed zero rows. Zero changed rows alone does not prove unnecessary work. These counts establish downstream amplification but cannot be divided into a causal SQL-per-request figure.

## Fresh pg_stat_statements cross-check

19:09:08.652–19:11:42.087 UTC (153.435 seconds): 26,940 calls, **175.58 calls/s**, 104.15 seconds execution elapsed. No statistics reset or new deallocation. Application database counters increased by 1,773 inserted, 6,332 updated and 232 deleted tuples; zero new deadlocks. Buffer hit ratio was approximately 99.35%.

The top three execution-time entries were step-input locking (5.70 s/121 calls), sample range reads (5.37 s/138 calls), and event fingerprint reads (4.44 s/295 calls). Diagnostic statement reads themselves contributed 2.26 seconds and temporary writes; monitoring was retained in totals.

## Eastern event boundary

The cohort's actual UTC timestamps were read as SQL text to avoid Node's local parsing of PostgreSQL timestamp-without-time-zone values. The event ran **18:42–19:12 UTC / 14:42–15:12 EDT**. 476 entitlements; 373 activated. All 476 were marked end-processed by 19:12:19 UTC. This does not mean every downstream summary/notification had completed.

Resolution queue samples:

| UTC | Queued | Running | Oldest queued request |
| --- | ---: | ---: | ---: |
| 19:11:45 | 1 | 1 | 0.4 s |
| 19:12:15 | 105 | 3 | 12.1 s |
| 19:12:45 | 23 | 3 | 36.3 s |
| 19:13:16 | 1 | 1 | 0.7 s |

No expired resolution leases in these samples. CPU was already 85.2% immediately before the boundary and reached 92.6% afterward. The subsequent 97.8% sample is confounded: a second pg_stat_monitor aggregate read at approximately 19:13 timed out at its five-second limit and was observed writing temporary buffers. Its diagnostic Node process was stopped; no application process was touched. Do not attribute the full later peak to the event.

## Recommended next work

1. Reduce repeated scoring/event input work per step-driven resolution while preserving input fences and event eligibility. Measure query counts per useful committed result, including placement and post-task work.
2. Test post-task finish plan reuse and simplify the already-prepared viewer-event lookup. HTTP accounts for 61.6% of recorded planning elapsed in this window, so worker-only tuning will leave substantial request-path work.
3. Replace the expensive historical notification-completeness search with durable gap tracking or indexed bounded candidates, preserving repair coverage.
4. Investigate shared-vCPU steal separately: its observed contribution removes meaningful capacity, but does not explain all application work.

No code fix or capacity change was performed. Any implementation needs tests-first integration coverage and review; deployment needs fresh approval. Existing clients and schemas are unchanged.

Metric semantics: https://docs.percona.com/pg-stat-monitor/reference.html (query CPU in milliseconds, separate planning/execution elapsed fields).

## Final observation

Samplers completed and closed by 19:14:18 UTC. The 19:11:14–19:14:18 interval recorded 37,584 statement calls and 156.21 seconds execution elapsed, with zero additional deadlocks. Sample range reads led execution elapsed (240 calls, 11.92 s), followed by input locking (146 calls, 9.14 s), event fingerprint reads (313 calls, 6.35 s), and durable capture compaction (18 calls, 4.49 s). No single completed SQL dominated. The last managed metric at 19:14:16 was still **95.81% non-idle**; queue drainage did not establish CPU recovery. The timed-out monitor query had already been terminated approximately a minute earlier. The 70% idle target is not met.
