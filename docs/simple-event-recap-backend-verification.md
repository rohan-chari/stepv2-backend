# Simple event recap backend implementation and verification

Implementation baseline: production-confirmed `9b08e5f9b50250cae431177e67e73e24dd6b2b34`.
Isolated branch `feat/simple-event-recap`; no production writes, deployment, staging startup or runtime flag.
API locked first in commit `2f8503d`, [exact contract](simple-event-recap-api-contract.md).
Contract remains unchanged. New client capability is an interaction declaration, not a release control.

## Runtime removal / preservation manifest

- Removed all 14 specified summary/capture engine files and both startup scheduler registrations. No source-file SQL references to `global_event_summary*` or `durable_capture*` remain.
- `recordStepSyncV2`: removed capture closure lock/retry, journal/capture acquisition, recap receipts and wakeups. Normal source serialization, immutable idempotency response, resolution enqueue and transaction isolation remain.
- `raceResolutionQueueV2`: removed recap readiness, captured scoring and recap wakeups. Ordinary race C0 fences, fingerprints, active-effect impact publication, post tasks and scoring queues remain.
- `raceExpiry`: removed recap settlement/replay, captured vector repair/readiness and dead recap-cache invalidation loop. `raceSettlementAttribution` still includes global-event counterfactual terms in shared integer-allocation math: removing those terms could change powerup rounding. They are not persisted recap work or a summary engine.
- Event activation stamps a bounded historical start-cohort scalar once; later membership updates never restamp it. Event start/end scoring jobs, membership and notifications remain. Delayed cancellation/missing completion evidence and over-limit history omit an unprovable stamp.
- Home reads only the replacement saved record and latest completed entitlement. No samples on saved reads; POST only caller metadata, multiplication and one conflict-safe insert. Recap input never changes actual steps, scoring or coins.
- The thin old-client sample adapter runs only after a successful accepted sample path, uses one bounded overlap read, rejects gaps/overlaps/open buckets/over-limit input and invokes the same save-once calculator. Capable clients never take this adapter. Replayed historical sync JSON is not rewritten; old receipt IDs terminate through the constant no-query shim.
- Both Home builders, batching, expiry metadata and acknowledgment use replacement storage. Cache namespace bumped; PostgreSQL fallback, generation invalidation and invalidation-failure bypass remain.
- Retention no longer waits for obsolete work state. Migrated copies survive until the immutable final-drop completion milestone; after that ordinary 30-day retention applies to them too. This is a schema-completion fact, not a runtime toggle. Account deletion and retained-storage privacy cascades remain effective throughout cutover.
- Prisma removes the three retired models and old impact/event attribution metadata; membership IDs/event/race/user/timestamps remain. Migration A is additive and old-server compatible. Detached old tables exist only during the mandatory separated audit interval.
- Removed old capture audit, capacity fixture/analysis/SQL map, capture-root sweep and event-end/action benchmark programs. Removed recap metrics, telemetry phases and polling from live capacity tools; retained report compatibility fields are constant zero. Shared scoring/notification capacity gates remain; no obsolete recap-scan/recovery gate remains.
- Historical migrations and documents retained, obsolete summary operations labeled superseded. [Test disposition](simple-event-recap-test-disposition.md) maps intentional feature retirement. All 24 archived original files (including root-owned mixed originals) were byte-compared against the baseline: zero mismatches. No existing assertion was skipped to obtain green.

SQL cutover/drop, exact objects, passive cascades and separate authorization boundary are in the [SQL retirement runbook](simple-event-recap-sql-retirement.md). Final drop is **not** an automatic Prisma migration and cannot run within one week of backend cutover.

## Reproducible local commands

`npm run test:integration` now uses a test-only initializer. It rejects remote/non-`_test` URLs before creating a connection, creates a missing local test database, applies the full migration chain and identity indexes, closes its connections, and applies guarded cutover before starting tests. It never terminates someone else's connection. A live connection makes cutover fail safely. No production migration command calls this initializer.

Use a dedicated loopback `_test` database and a test-only session secret. Example:

```sh
DATABASE_URL=postgresql://localhost/steps-tracker-recap-contract_test \
  ADMIN_EMAILS=admin@test.com npm run test:integration -- \
  test/integration/simple-event-recap.test.js \
  test/integration/event-recap-start-cohort.test.js \
  test/integration/event-recap-settlement-compat.test.js \
  test/integration/active-impact-home-summary-cache.test.js \
  test/integration/event-recap-retained-schema-account-deletion.test.js
```

The retained-schema account-deletion test deliberately populates old storage and is **A/cutover-only**. Run it before B. Post-B, run the other four files explicitly, plus preserved scoring/notification suites. This is a separately selected migration-stage suite, not a conditional skip. Core account-deletion assertions remain in `simple-event-recap` and run after B.

```sh
DATABASE_URL=postgresql://localhost/steps-tracker-recap-contract_test \
  SESSION_TOKEN_SECRET=integration-test-only-session-secret npm run test:unit
```

For legacy shared cache integration cases, set `LOCAL_REDIS_TEST_URL` to a dedicated local Redis DB15. Do not use an external Redis service.

## Results

- Full fresh 260-migration chain (259 baseline + additive A), identity indexes, stopped-client cutover, then dedicated replacement suites: **27/27 pass**, zero skips. Covers real HTTP auth/input/expiry/ownership/first-writer races/old Home caps/ack/shim, old sample gaps and bounds, start-cohort history, zero/unknown, retention through B, actual scores/coins, Redis cold/warm/outage/DEL failure and populated account deletion.
- Full unit suite after final review: **3,361/3,361 pass**, zero skips (test-only `SESSION_TOKEN_SECRET` required). Includes a recursive production-source guard over all retired table/function families, which caught and now prevents the observability-count regression.
- Preserved broad integrations: **122/125 pass**. All three failures reproduce on unchanged production baseline: local event dependency-closure expected FULL vs DEPENDENCY_CLOSURE; local display artifact boundary worker returns no claim; Drill Sergeant rollback retry missing final impact. Existing assertions remain untouched.
- Broad files: `local-global-step-event-entitlements`, `resolved-impact-events-v2`, `feature-batch-2026-08-17-contracts`, `cron-work-bounds`, `race-resolution-planning-input-reuse`, `seeded-signup-recovery`, `postgresql-coordinated-optimization-public-pipeline`, `redis-cache-efficiency-writers`, `home-open-capacity-session`, `buff-stacking-event-scoring`, `home-sync-refresh-contract`.
- Root-owned mixed end/recovery tests: **26/26 pass on PG16**; post-B PG18 has one independently reproduced baseline SQLSTATE assertion (23001 vs hardcoded23503). See [mixed disposition](simple-event-recap-mixed-test-disposition.md).
- Additional `query-efficiency-enrollment` performance probe transfers500 vs5990rows and enrolls600 users, but its timezone expectation fails (NewYork expected, UTC after reconciliation). The identical failure was independently reproduced on unchanged production baseline PG18. Assertion not changed.
- `git diff --check` clean. Source-removal structural guards pass. Prisma validated with isolated generated client. Matched full HTTP/worker performance and populated SQL rehearsals are maintained by the root reviewer alongside these results.

No claim of an entirely green repository or a guaranteed production CPU percentage is made. Existing red baseline tests are disclosed; deployment and final SQL retirement still require separate authorization and runbook execution.
