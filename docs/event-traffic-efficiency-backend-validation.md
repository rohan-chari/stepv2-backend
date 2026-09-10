# Event traffic efficiency — backend validation

Implementation matches the approved three-workstream scope. API contract locked before frontend work; no migration, new setting, runtime flag or production operation.

## Locked HTTP contract

`GET /home/race-card?view=sync-refresh-v1&homeActiveRaces=1&localDate=YYYY-MM-DD`

```json
{
  "contract": "home-sync-refresh-v1",
  "home": { "state": "EMPTY", "data": {}, "characterPowersEnabled": false },
  "retainedSections": ["presentation", "friends"]
}
```

`home` contains all current core fields, including capability-gated optional fields when applicable, and excludes only full-shell `contract`, `resolved`, `presentation`, `friends`. Same authentication and fatal-error responses. The new representation selects the shared assembler independently of the existing parallel-assembly setting and never invokes either presentation service. Existing representations are unchanged.

The Home core itself may legitimately query equipment or friend IDs for race discovery. Tests compare those SQL statements to the equivalent legacy core and verify the extra full-shell presentation statements disappear; they do not incorrectly claim the entire Home request contains no reference to those tables.

## Intake audit and implementation

Repository-wide source-table/model references were audited before removing the unconditional UPDATE. Consumers in `raceResolutionInputFingerprint`, `globalEventSummaryCapture`, `raceResolutionQueueV2`, `raceScoringPrefetch`, `hitchhikeAttributionCapture`, and load-test accounting read generations/watermarks, not source-version `updated_at` as a heartbeat. Model/script writers advance generations. Migration history defines no user trigger on `user_scoring_input_versions`; a live catalog assertion on the disposable migrated database confirms no non-internal trigger. The orchestrator also verified the production catalog at 2026-09-10T02:56:25.948Z using `BEGIN READ ONLY` and a two-second statement timeout: `userTriggers: []`. Successful intake retains `users.last_step_sync_at` separately.

The already-locked row is compared with generation change, watermark, null-safe boundary and queue ownership. Creation, boundary crossing and repair continue writing. No source-version tuple or timestamp changes for a fully unchanged upload.

The daily CTE returns either its changed row or a snapshot-visible unchanged row with the requested step value. The second SELECT is retained for concurrent visibility gaps. Legacy `Steps.create`/`Steps.update` can write before their generation bump, so removing that fallback is unjustified. Real HTTP tests block the UPSERT after its snapshot, then perform a committed independent insert or update. Both must return the newly committed row and compatibility stepGoal. The update case initially found a stale-value regression (122 returned instead of requested123); the unchanged CTE branch now requires an equal step value before using the snapshot row.

## Source sharing and ownership

Pending keys include sample/daily model identity, memory-observer identity, user, source generation, exact sample/daily bounds and user/row/memory budgets. Completed cache keys use the same source/budget namespace. Per-attempt planning generation adapters are deliberately not identities; their generation values are the fence, while the underlying sample/daily models identify the datasource.

Only the worker's explicit outside-transaction source phase admits process caching. Leaders retain bounded bulk loading. Waiters share finalized in-memory sample timelines, including empty coverage. Race effects, calculations, fingerprints and transaction ownership are independent. Daily rows still use the existing bounded bulk read per cold prefetch; completed cache hits reuse them. This implementation claims the measured sample SELECT reduction, not elimination of every cold daily read.

Paged leaders never publish a cursor or spool. Waiters receive a private-reload signal. Pending entries are bounded by the cache user budget and removed on success/failure. Failure propagates once without immediate per-waiter retry. Releasing a waiting caller does not cancel the leader; late completion does not resurrect the released caller's maps/spools. Parallel failure waits for outstanding owners before disposing scratch storage.

## Tests and measurement

New tests were written red first: the Home representation was absent; unchanged intake created a new MVCC tuple; three overlapping source calls issued three reads. Then runtime implementation landed. Additional visibility and cancellation/cleanup regression cases pin discovered edge behavior.

New files:

- `test/integration/home-sync-refresh-contract.test.js`: real authenticated HTTP, populated/frozen/modern contract parity, parallel-setting independence, SQL attribution, optional/fatal failures and authentication.
- `test/integration/event-action-efficiency.test.js`: unchanged physical tuple/SQL checks, trigger catalog audit, replay/conflict/date rollover/concurrent writers, and real PostgreSQL snapshot visibility barriers.
- `test/integration/race-source-singleflight.test.js` plus `fixtures/event-efficiency/observe-source-loads.cjs`: actual `src/index.js` child worker, real HTTP upload/progress, driver latency to guarantee overlap, three durable race outcomes and both fingerprints per race. Both nonempty and empty sources measured **3 SELECTs baseline → 1 candidate**; three committed races and six fingerprints in each case.
- `test/services/raceScoringSingleflight.test.js`: deterministic process scheduler properties (incompatible generations/ranges/models/budgets/transactions, rejected leader, bounded overflow, paged ownership, caller release, cleanup). These identity/ownership barriers are structurally impractical to force through HTTP; primary correctness and actual SELECT savings are also exercised through the child worker.

The existing cache test receives only the new explicit outside-transaction eligibility parameter; existing assertions are unchanged.

Comparable 24-sample upload fixture, one uploader in three races during a local event:

| Action | Baseline SQL events | Candidate SQL events |
| --- | ---: | ---: |
| Initial upload | 27 | 27 |
| Same data, fresh idempotency key | 15 | 13 |
| Changed final sample | 16 | 16 |
| Same-key replay | 4 | 4 |

Baseline unchanged upload changes both source-version `ctid` and `updated_at`; candidate preserves both. These are observed Prisma SQL events, not universal physical-round-trip or CPU claims. Fixture initial27 differs from the earlier investigation's28; the directly matched unchanged15→13 comparison is measured, not subtraction.

Final full unit run: **3,383 passed, zero failed/skipped**, including the scratch-cleanup case. Focused backend integration run: **75 passed, zero failed/skipped** across eleven suites/files; the final targeted Home/source rerun passed **6/6**, including the additional fatal-core assertion. Source scheduler/ownership tests passed **29/29** with the existing prefetch suite. `git diff --check` is clean. Initial unrelated banner unit failures were reproduced as shared Redis contamination; clean Redis-disabled unit execution passed without assertion changes. An initial integration batch had twelve zero-job failures after the benchmark left burst-coalescing overrides enabled. Removing those overrides from the disposable DB restored all17 affected cases unchanged. Keep benchmark configuration isolated from default direct-tick tests.

## Original implementation-checkout handoff

The original handoff required production-derived transfer and revalidation. Those checks are recorded below. The current cross-repository readiness status is maintained in event-traffic-efficiency-validation.md; this backend-only document does not independently authorize deployment.

## Production-derived release validation

The release checkout is based on deployed `2f021c2`; feature runtime is committed as `f264099`. Tests run only against the dedicated local `bara_event_release_20260910_test` database and Redis on port6398. Latest Home contract tests and this audit document were transferred explicitly from the implementation checkout.

Repeated the unchanged-upload probe against the actual production baseline and release code: **15→13 observed SQL events**; baseline changes source-version `ctid`/`updated_at`, release preserves both. Changed upload16 and replay4 remain equal. Initial cold upload counted28 baseline and27 release; do not attribute that startup difference to the two-statement unchanged-upload saving. Actual production-baseline child-worker tests again show three reads for both empty/nonempty source fixtures with correct final race totals and six fingerprints; release child-worker fixtures show one.

One pre-existing reliability assertion expected an IMMEDIATE merged job from two COALESCE producers. The same assertion fails on unmodified deployed code: event-start microbatches deliberately request COALESCE. The approved test-fixture repair retains the IMMEDIATE assertion with an explicitly urgent concurrent STEP_SYNC producer, and adds the two-COALESCE case to pin the deployed behavior. No runtime scheduling or priority behavior changed.

The first release unit run passed3382/3383; the remaining failure was the absent gitignored capacity parity fixture in the new checkout. Copied the existing local fixture, preserving its exact values; the focused capacity-profile suite passes without test changes. Final release unit suite: **3,383 passed, zero failed/skipped**. Expanded release integration suite: **170 passed, zero failed/skipped** across seventeen files (including Redis failure/recovery, event ends, summary expiry, stale-fingerprint rejection, snapshot visibility and old-client intake). Source production-baseline comparison: **2/2 passed**, each requiring three SELECTs; release comparison within the170 passing tests requires one. `git diff --check` passes. No additional runtime fix was required on the production-derived base.

## Cross-action accounting

The fixed 36-run raw data is accompanied by `evidence/event-traffic-efficiency/sql-job-accounting.json`. It separates statement counts, elapsed query time and SELECT/INSERT/UPDATE/DELETE operation presence by phase and process, including operations inside CTEs. Presence categories overlap: a CTE and an UPSERT can contain several verbs, and a suppressed UPDATE changes no tuple. These are neither independent physical round trips nor changed-row counts. Focused intake evidence supplies the actual avoided source-version tuple.

All 648 observed membership jobs have committed their required generation and all 216 accepted session receipts are covered. Final rows do not reveal every enqueue/coalescing attempt; the raw query/worker records retain those attempts where observable. Worker startup, idle, event start, user sessions and event end remain separate. The three shared-five-race repetitions have identical poll counts and core claims/commits, while additional fingerprint rejections account for real extra worker SQL. This is reported rather than attributed to harmless noise.

Query-level planning/execution evidence is retained in `explain-baseline.json`, `explain-candidate.json` and `explain-home.json`. Each EXPLAIN uses bounded local test data and statement timeouts; any DML is rolled back. It does not establish full-workload planner/CPU savings, and it must not be extrapolated to managed-database CPU.
