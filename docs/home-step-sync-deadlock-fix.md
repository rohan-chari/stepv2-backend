# Home step-sync lock-order fix

## Reproduction and change

Concurrent ordinary and Home-pull POST /steps/sync-v2 requests for the same user
could acquire the scoring-input and user rows in opposite orders. The new real
HTTP/PostgreSQL regression reproduced SQLSTATE 40P01 twice before the change:
ordinary returned 202 and Home returned 500, instead of the expected 202/202.
This proves the code-path defect, not the exact counterpart of the historical
production deadlock (the complete production deadlock report was unavailable).

Home cooldown admission now runs immediately after intake acquires the scoring
row and before daily/sample source writes. The reservation remains the first
transactional write. Existing summary-capture fence ordering is preserved.
The cooldown SQL, rollback, idempotent response replay and API shapes are unchanged.
No migration, runtime flag, or app update is required for either mobile platform.

Successful requests add no queries, writes or queue jobs. Rejected Home requests
now reach summary dependency lookup/fencing and scoring-row acquisition before
rejection; all transactional changes roll back. This fixes the reproduced cycle
without relying on deadlock retries and does not claim to eliminate every possible
deadlock elsewhere in the system.

## Validation

Dedicated local PostgreSQL 18.4, worker_planning_test, direct port 55438. No
production data was used. The test itself refuses non-local/non-test DB targets.
Run the following with DATABASE_URL explicitly set to a dedicated local test DB
and the usual integration-test environment:

```sh
node --test --test-concurrency=1 --test-force-exit \
  test/integration/home-step-sync-deadlock.test.js \
  test/integration/home-step-sync-cooldown.test.js \
  test/integration/stepSyncV2.test.js \
  test/integration/step-intake-legacy-contract.test.js \
  test/commands/recordStepSyncV2ConcurrencyContract.test.js \
  test/services/stepInputIntakeSource.test.js \
  test/http/stepSyncV2.test.js
```

Final result: 54 passed, 0 failed, 0 skipped. The concurrent regression returned
202/202 with no 40P01. The first broader run had one event-replay assertion failure
(two observed events instead of one); the isolated suite and final combined run
passed. Existing assertions were not altered. That intermittent failure was not
established to reproduce on baseline and remains a test concern.

Flutter analyze passed. Required code review approved with no findings.
Production deployment is pending separate authorization.
