# Database CPU remediation — validation and deployment preparation

**Ready for production deployment after fresh authorization.** Production has not been changed. The supplemental superseded-pinned fixture exposed and reproduced two scan defects; the final migration fixes pin-first eligibility and uses indexed earliest-head deadlines. The final migration passed fresh application, targeted correctness checks, repeated workload comparisons and final code/architect review.

## Baseline and isolation

The observed production hour remains [the September 10 investigation](db-cpu-hour-2026-09-10.md). Implementation comparisons use unchanged backend source `de7e8955708b0256ea67beb14d1fa2855a064a43` in a separate checkout and dedicated local PostgreSQL 18 test databases. The baseline differs from the observed production commit only in two documentation files; application code and migrations match. No test has used production/staging data or services.

The full unit baseline passed all 3,391 pre-existing tests after supplying the required test-only session secret and existing local capacity overlay. That recorded run also includes six new telemetry regression tests: five intentionally fail on the baseline and one passes. It therefore reports 3,392 pass/five fail; those five are the new defect reproductions, not waived existing failures. The final candidate passes all 3,397 tests with no skipped tests. Unit fixtures run with Redis disabled, matching baseline isolation; supplying a live Redis initially caused three existing injected-fixture assertions to read cached values. The three pass in isolation with Redis disabled, and the entire suite then passed. No assertion or application source was changed for that configuration correction.

Several pre-existing integration fixtures needed correction to test their intended behavior: an expired notification date, authoritative timezone, large-team capability header, cached test-setting defaults, explicit background user population for a planner fixture, and seeded-eligibility timestamp. [Fixture corrections and unchanged-assertion evidence](db-cpu-fixture-corrections.md) record baseline and candidate verification. These are fixture repairs, not weakened acceptance thresholds.

## Counter and telemetry evidence

The new HTTP late-enrollment regression measured two counter writes on baseline and one with batching, retaining exact entitlementsCreated/lateEntitlementsCreated values. Concurrent HTTP enrollments retain all increments. A test-only database trigger rejects a counter write and proves the HTTP transaction rolls back membership, entitlement and every counter. Duplicate enrollment keeps its legacy 400 response and does not increment creation counters. The candidate passes all three tests.

Counter batching preserves producer order during mixed-binary deployment; alphabetical ordering would reverse the existing scoringQueries/scoringLatencyMs lock order. It reduces round trips, not the number of affected metric rows. There is no claim that this alone removes vacuum churn or materially lowers whole-host CPU.

Telemetry regressions cover early/exact/delayed timers, actual partial interval bounds, manual flush, requests during asynchronous publication, publication failure, stop and a real HTTP response counted once. Baseline emits two flushes around an early boundary; candidate emits one. All eight old/new telemetry tests pass. This is an accounting correctness improvement, not a database CPU-saving claim.

## Whole-path accounting protocol

`test/integration/db-cpu-work-accounting.test.js` creates synthetic users and races, starts two real HTTP processes and a real resolution process through `src/index.js`, and sends synchronized canonical step uploads. The observer records SQL shapes/counts, sample-range reuse and process CPU without changing business behavior. It runs through an owned transaction-mode PgBouncer with prepared-statement support. Child processes start in an empty runtime directory with a test-only environment so they cannot load developer provider credentials.

The 1,000-user case uses 50 races and resolution concurrency 2, then repeats the same source uploads with new request idempotency keys. All resulting totals must be 100 and duplicates must not create new generations. Before measuring the duplicate phase, the harness asserts that scoring, committed generations, post-publication tasks and placement jobs all drained. A deadline cannot silently produce a partial successful result.

The existing bounded step-admission response is 500. The burst harness retries that existing response with the same idempotency key and separately reconciles **every** 500 with an observed admission rejection; it fails if any 500 was an unaccounted application failure. It records all-attempt p95, accepted-attempt p95 and end-to-end upload p95 including retry delay. It does not claim this cohort is a zero-error production capacity certification, nor change the legacy response contract.

Before/after results require three matched repetitions with the same population, topology, source behavior, pool, observation and workload. App-process CPU is explicitly different from managed PostgreSQL host CPU. Worker counts include background probes, so attribution is by complete controlled cohort and phase rather than invented production SQL-per-user averages.

## Matched cohort results

All six final-migration runs passed: three unchanged baseline and three frozen candidate, alternating order. The initial six runs remain under `preliminary-migration-cohort/`; final results below supersede their latency numbers. Each accepted all 2,000 synthetic uploads (1,000 changed plus 1,000 duplicate) after bounded admission retries, drained downstream work and verified public totals. [Raw runs and calculated summary](evidence/db-cpu-remediation-20260910/cohort-summary.json).

| Metric: median of three run values | Baseline | Candidate | Interpretation |
| --- | ---: | ---: | --- |
| Upload p95 including retries | 1,749.0 ms | 1,715.5 ms | 1.9% lower; small local difference |
| All HTTP attempt p95 | 442.8 ms | 446.1 ms | Essentially unchanged; 0.7% higher |
| Accepted HTTP attempt p95 | 651.8 ms | 622.8 ms | 4.5% lower |
| Complete measured duration | 8.714 s | 8.173 s | 6.2% shorter |
| Admission rejections/retries | 5,565 | 5,381 | 3.3% fewer; not zero-error capacity proof |
| Changed-phase SQL commands, all roles | 22,300 | 22,247 | Essentially unchanged; includes background probes |
| Duplicate-phase SQL commands, all roles | 12,007 | 12,007 | Unchanged |
| Changed-phase application CPU | 5,692 ms | 5,699 ms | Essentially unchanged; 0.1% higher |
| Unique source ranges, changed / duplicate | 1,000 / 0 | 1,000 / 0 | Existing reuse retained |

These are medians of per-run p95 values, not a pooled request percentile. Three local runs establish regression/work accounting, not statistical proof of a production capacity gain. The cohort does not contain the large retained-root population used in the independent maintenance gate, so it must not be used to estimate that optimization's production effect. SQL elapsed time also includes waiting and is not CPU time.

## Dispositions and remaining host limits

[A/B/C implementation and benchmark results](db-cpu-backend-implementation.md) document selected query preparation, the typed-array viewer bind and read-only retained-root sweep. The single-traversal boundary rewrite was rejected for a dense-history regression. Already-prepared active-event SQL and generated ORM membership reads retain their current behavior. G batches counter statements inside the existing transaction; H fixes interval ownership. Final superseded-pinned maintenance uses 16.59 ms versus 171.90 ms per 6,763-root sweep and 221.69 ms versus 4,881.83 ms at 67,630 roots. Charging six/two candidate sweeps still reduces execution, buffers and WAL. Individual lock p95 and upload p95 improve in that fixture, but total charged exclusive-lock wall time rises from 193 to 342 ms and 1,114 to 1,170 ms. That increased cumulative occupancy is a real limitation, not a CPU-saving measurement.

Notification query rewrites were rejected on actual work rather than shipped because they sometimes ran faster: [SELECT/full UPDATE/cursor/admission experiments](db-cpu-notification-experiments.md). Existing bulk delivery, receipts and recovery remain intact.

Existing source-range reuse and independent fingerprint fences remain required. Both versions read exactly 1,000 unique source ranges for 1,000 changed uploads, then zero new ranges for the duplicate cohort; duplicates preserve input generations. The public/worker regression matrix exercises independent fences, shared input reuse, changed inputs and legacy intake. No additional same-snapshot duplicate was demonstrated, so E/F closes as investigated with no new algorithmic change. This does not claim the complete production traffic mix is free of duplicate work or that necessary revalidation can be removed.

CPU steal and active compressed swap are unchanged infrastructure observations from the original hour. These local experiments cannot establish a post-deployment managed-host CPU percentage. After a separately authorized deployment, compare another matched hour using the existing DigitalOcean/PostgreSQL monitoring protocol. The 70% idle objective remains an operational target, not a promised outcome.

## Final checks

- Full unit suite: **3,397/3,397 pass**, zero skips.
- Final integration coverage: **209 distinct tests across 33 files pass with their required Redis configuration**, zero unresolved failures/skips. The combined run recorded 203 pass, three failures and three cancellations: publication fixtures require live Redis for their proof creation, while 10v10 discovery explicitly requires logical database 15. Rerunning those two files with `REDIS_URL` and `REDIS_TEST_URL` set to the owned `redis://127.0.0.1:16450/15` passed all eight tests (including two previously passing tests). No assertion/source correction was needed. The remaining suites run with `REDIS_URL` empty and `REDIS_TEST_URL` available for fixtures that opt into it. This is not a claim that one uniform-environment invocation passed all 209.
- Six complete matched cohort runs pass, including durable drain, totals and duplicate-generation checks.
- Prepared compatibility: transaction error propagation/rollback, backend reconnect, additive DDL and updated values pass through the actual adapter and transaction pool.
- Fresh PostgreSQL 18 migration application and required identity indexes pass. Recorded migration checksum equals the final file: `38f8cdf49a2c5d626ae5483095121c88cbea56c9096060a8ae73b4bb325f34ba`.
- Frontend `flutter analyze` passed. No Flutter/native changes from this task; neither platform needs a new build.
- Frozen production sources passed code review without blockers. The later B regressions first reproduced 129 head reads for 128 pinned roots, then 81,156 head reads over 12 warmed scheduled calls. The final migration preserves zero pin-only head reads and bounds the scheduled probes to two earliest-head reads per call, including test-local generic planning. No production plan-cache setting changes. The final architect re-review approves it, fresh application/checksum and repeated cohorts pass; all 82 targeted checks across ten affected files pass on the freshly migrated database, including both added regressions. Application JavaScript stayed unchanged from the full 3,397-unit/209-integration validation. Final code review: **SHIP**, no blockers. The focused architect review approves the final migration. The optional externally locked-root observation remains documented.

[Validation metadata and exact integration file list](evidence/db-cpu-remediation-20260910/final-validation.json), [all production source hashes](evidence/db-cpu-remediation-20260910/final-source-manifest.json), and compressed logs are retained with the measurements. The initial configuration failures are retained and explained, not presented as successful runs.

## Deployment handoff — execute only after fresh authorization

1. Confirm the approved candidate commit from `codex/db-cpu-remediation-20260910` has been incorporated into the release branch, clean release tree, production migration state and exactly two online `steps-tracker` HTTP workers. Staging remains stopped. Follow [the deployment runbook](../DEPLOY_RUNBOOK.md) and its current serialized wrapper prerequisites.
2. Apply additive migration `20260910010000_capture_root_readonly_sweep` before loading new application code. It creates the singleton sweep state and compatible function wrappers, uses a five-second lock timeout and performs no root backfill. If the timeout fires, stop and inspect migration state before retrying; never bypass locks or mark an unapplied migration successful.
3. Generate the Prisma client and use `./scripts/pm2-safe-prod-reload.sh` through the standard runbook. Preserve existing role topology, pool sizes, prepared-name budget and client contracts. This release adds no runtime flags or infrastructure setting changes. No Flutter release is required for either platform.
4. Verify migration checksum, health, both HTTP workers and the existing worker roles; exercise legacy/current read contracts and confirm queue progress and absence of prepared-statement protocol errors. Retained roots should no longer receive maintenance-only timestamp updates; legitimate root writes must be distinguished by workload.
5. Run the existing DigitalOcean plus PostgreSQL delta collector for another hour after steady state, using matching windows and recording traffic, accepted syncs, resolutions, planning/execution, root mutations, sweep activity, locks, vacuum, swap and steal. Attribute collector queries separately; do not reset production statistics. Compare against the retained September 10 hour and report traffic differences and missing/evicted statements. Actual managed CPU savings remain unmeasured until this authorized follow-up.

Application rollback can leave this additive migration installed because old SQL entrypoints remain compatible. If function rollback is necessary, prepare a separately reviewed forward migration restoring the captured prior definitions; do not drop capture roots or sweep state as an improvised rollback. The optional code-review observation about an externally locked eligible root remains documented; ordinary pinning excludes that overlap and no normal-path deadlock was established.

Local cleanup: all task-owned HTTP/worker processes, Redis services and PgBouncer pools were stopped after verification. The existing shared PostgreSQL 18 server and synthetic test databases remain available; no staging or production service was started/reloaded. The release is prepared on `codex/db-cpu-remediation-20260910`; source/migration hashes identify the exact reviewed implementation.
