# CPU remediation baseline fixture corrections

These corrections repair existing test setup without changing application behavior or any original assertion. The orchestrator reviewed each cause and authorized the fixture corrections. Both files were tested against the unchanged `de7e895` application source in the baseline checkout and the current implementation candidate, using the same corrected tests and owned local PostgreSQL 18 database `cpu_remediation_notification_test` on port 55439. `REDIS_URL` was explicitly empty for these runs.

## Large-race fan-out configuration

`test/integration/step-sync-large-race-batch.test.js` requires production's queued-generation merge and burst-coalescing behavior to test scoped FULL trigger fan-out, bounded statements, live-claim preservation and queue lock ordering. Its old setup wrote setting rows after importing `setup`, which constructs the application. The application's settings cache could already contain historical Node-test defaults (`false`); permanent production settings use `true`. The observed baseline consequently took a different queue path, produced zero expected scoped triggers and waited on active job locks.

The fixture now uses the existing Node-test-only `appSettings.setFlag` seam for those two settings, preserving and restoring their prior resolved values. This does not introduce a flag or modify production settings. Real HTTP intake and real database/queue assertions remain intact. All 12 tests pass against baseline and candidate, including the simultaneous overlapping upload, nonblocking active-job append, 251-race page boundary, rollback, terminal lock order and concurrent activation winner cases.

## Worker/progress capability and benchmark population

`test/integration/query-efficiency-resolution.test.js` creates `teamSize:50`, then previously requested `/progress` without the capability for a larger team board. The established old-client route guard correctly returned HTTP 400 `UPDATE_REQUIRED`; this was not a scoring failure. Only the team fixture now sends `team_races,team_races_10v10_v1`. The individual-race fixture still sends no feature header. The HTTP 200, participant total/name, generation, no duplicated source-range reads and fence checks are unchanged.

After reaching the previously masked benchmark, the team case exposed another fixture assumption: its entire users table contained only the 100 race members. PostgreSQL could scan/hash that tiny relation cheaply (17 versus 12 shared-buffer hits), while an earlier case with leftover relation bloat happened to meet the old less-than-half buffer guard. Such incidental physical state was not a stable performance baseline.

The fixture now seeds exactly 10,000 additional unrelated users in bounded batches, then runs local `VACUUM (ANALYZE)` on users, races and race_participants before observing the worker. This defines a 100-member race inside a 10,100-user population. It retains the original less-than-half buffer assertion and all other assertions. Both cases pass against unchanged baseline application source and candidate. The team benchmark observed 439→10 shared hits on baseline and 440→10 on candidate for the existing user-join projection comparison. These numbers describe this explicit fixture and an already-existing optimization; they are not new CPU-remediation savings or a whole-host CPU claim.

## Evidence

`docs/evidence/cpu-remediation-fixtures/` contains baseline/candidate logs and `unchanged-assertions.json`. Assertion call text was compared mechanically with repository HEAD and is unchanged; corrected baseline/candidate test files are identical. No existing test was skipped, deleted, or weakened. No production application module was changed for these corrections.

## Interrupted seeded automatic scan

`test/integration/seeded-early-preparation.test.js` creates 501 users intended to have been eligible before the captured September 10 midnight. It set `createdAt` to September 1 but omitted `seededAutomaticEligibleAt`. The additive `users_seeded_automatic_eligibility` trigger correctly stamps omitted eligibility timestamps with the current database clock; the scheduler therefore excluded these newly eligible rows from the older captured boundary and the cursor stayed null. The failure was reproduced on unchanged baseline source before editing the fixture.

The fixture now explicitly sets `seededAutomaticEligibleAt` to the same September 1 timestamp. This uses the trigger's documented trusted-import/fixture support and models the intended pre-boundary population; it does not alter application eligibility rules or the separate post-boundary exclusion case. All original assertions, including the first 500-user cursor, resumed 501st membership and boundary creation timestamp, remain unchanged. Full-suite baseline/candidate logs are retained alongside the pre-correction failure.
