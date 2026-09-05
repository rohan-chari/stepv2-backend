# Large-race enqueue batching

Validated locally on 2026-09-05 against baseline `84e54ca`.

## Behavior

Changed step intake still records one durable trigger per affected large race
inside the source-input transaction. The queue now inserts triggers, reads active
jobs, and activates absent/terminal jobs in batches of at most 250 races. Active
jobs retain their generation, lease, priority, and debounce without a conflicting
write. Missing and terminal jobs are handled by one ascending-order upsert; a
concurrent activation winner is reread after the conflict wait.

The single-race enqueue API delegates to the same implementation. Ordinary-race
envelopes and trigger promotion are unchanged. No migration, new runtime control,
API contract change, or frontend release is required. Frozen iOS and Android
clients retain the same HTTP 202 response and first-race polling receipt.

Work remains O(R) rows for R affected races. Round trips are bounded per 250-race
batch: two for already-active jobs, three when this transaction activates jobs,
and at most four if another transaction wins an activation race. This reduces
intake overhead; it does not establish a production CPU or scoring-speed gain.

## TDD and verification

The new integration tests drive real `POST /steps/sync-v2` requests and observe
real PostgreSQL transactions and Prisma query events. Before implementation,
three query-count assertions failed for the intended reason: ten new jobs took
30 queue statements, ten active jobs took 20, and mixed terminal/active jobs
exceeded the four-statement budget. The five initial behavior tests passed.

After implementation, all 12 new integration tests passed, covering:

- New, queued, running, succeeded, and failed jobs.
- Bounded and unbounded large races mixed with ordinary races.
- Uploader/participant scope, first-race receipt, generation, and debounce.
- Idempotent replay and scoring-no-op suppression.
- Concurrent overlapping uploaders without lost durable triggers.
- Upload completion while a worker holds active job locks.
- Atomic rollback of steps, triggers, and jobs after an injected queue failure.
- 251 races crossing the batch boundary, including a second changed upload.
- Direct low/high terminal-row lock-order probes.
- Deterministic concurrent activation preserving the winning running claim.

All tests used a newly created local `steps-fanout_test` database. All 222
existing migrations applied successfully. No production or staging access.

Commands used the following environment (a focused selection of the normal
Node integration harness, not the entire repository suite):

```sh
export DATABASE_URL=postgresql://rohan@localhost:5432/steps-fanout_test
export REFERRAL_IP_HMAC_ACTIVE_VERSION=1
export REFERRAL_IP_HMAC_SECRET_V1=integration-test-only-referral-hmac-secret-material
node --test --test-concurrency=1 --test-force-exit \
  test/integration/step-sync-large-race-batch.test.js \
  test/integration/stepSyncV2.test.js \
  test/integration/step-intake-legacy-contract.test.js \
  test/integration/race-queue-v2-enqueue-lock-order.test.js \
  test/integration/race-queue-v2-enqueue-scope-guard.test.js \
  test/integration/race-queue-v2-closure-scaling.test.js
node --test --test-concurrency=1 --test-force-exit \
  test/integration/global-event-summary-expiry-v2.test.js \
  test/integration/durable-queue-wake-classification.test.js \
  test/integration/durable-global-event-capture.test.js
node --test --test-concurrency=1 --test-force-exit \
  test/services/largeRaceStepInputScope.test.js \
  test/jobs/raceResolutionQueueV2ClaimingFlagCache.test.js
```

Results: first group 63/64 passed; second group 53/53 passed; focused existing
unit tests 28/28 passed. Existing mock expectations were mechanically updated
for JSON batch parameters and array reads; their assertions were preserved.
Syntax and `git diff --check` passed. Independent code review found no remaining
blockers after those mock updates.

## Existing failure, reproduced on baseline

`race-queue-v2-closure-scaling.test.js:576` expects 1,908 rows but receives 483 in
the 477-player FULL recovery test. The same assertion fails with exactly the
same values in an isolated, unchanged checkout of `84e54ca`, against the same
local test database. No assertion was changed or skipped. This is an existing
scoring-test failure, not a batching regression; the full suite is not claimed
green. The test's timing thresholds passed on both checkouts.

## Deployment

Backend code-only deployment, pending explicit production authorization. Observe
`durable_enqueue` time, upload latency, transaction failures, and queue lag after
deployment. Production speedup and CPU reduction have not been measured.
