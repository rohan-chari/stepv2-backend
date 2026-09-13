# Admin page memory validation

The approved frontend documents `docs/admin-page-memory-requirements.md` and
`docs/admin-page-memory-field-map.md` define the contract. All nine permanent
`view` values return projected section maps; requests without `view` retain the
full legacy shape. Purchases and their username/provenance contract are unchanged.
No migration or production mutation has been performed for this revision.

## Test-first evidence

`test/integration/admin-page-memory.test.js` initially failed through real HTTP
(`unknown` view incorrectly returned200) before the page implementation was added.
The red run is `/tmp/admin-page-memory-red.log`. Tests use the dedicated local
`admin_snapshot_query_fix_test` database and an isolated ephemeral Redis instance.

The unpublished `admin-dau-compact-query.test.js` experiment originally asserted
that the DAU aggregate materialized at most three user/day/action rows, then added
an index-only plan expectation that was red. The user clarified that page work
must instead stream narrow sources and calculate in memory. Its unpublished SQL
plan/index expectations are explicitly superseded: the test retains exact public
DAU users/event/average assertions and now intercepts real PostgreSQL execution
to require FETCH2000 and forbid the old DAU aggregate. No released assertion was
removed or weakened and the experimental index was never created.

## Recorded targeted runs

- Six primary page contracts, invalid view, and210000 repeated action events:
  8/8 passed; `/tmp/admin-page-memory-first.log`.
- Streamed legacy DAU plus all six released DAU cases:7/7 passed;
  `/tmp/admin-memory-legacy.log`.
- Retention exact pooled returns/history, cross-worker deduplication, Redis
  warm/cold behavior, worker crash cleanup and real45-second missing-ACK deadline:
  5/5 passed; `/tmp/admin-page-faults.log`.
- Lease theft: no snapshot publication or deletion of another owner's lease;
  1/1 passed; `/tmp/admin-page-lease.log`.

Full final page/compatibility runs and representative benchmarks are recorded
below when complete. Early targeted runs are implementation evidence, not a
claim that the final change has completed review.

## Instrumentation and bounds

The planner declares static narrow SELECT sources per page before opening its
read-only repeatable-read transaction. A source has one NO SCROLL transaction
cursor; each FETCH2000 is acknowledged by the DB-free worker before another
FETCH. No raw event rows go into Redis. PostgreSQL connections come from the
existing pool, and legacy/view work shares the exact existing global lease.

The observer exposes source count, actual cursor query count, first/non-first
FETCH latency, transferred rows/serialized bytes, database wait time, worker
processing and lifecycle wall time, worker CPU time, sampled worker heap/external
high-water marks, and explicitly charged compact state. Sampled memory is not
represented as a continuous exact peak. Routine production logging emits summary
completion/failure events, not every batch. Warm HTTP tests intercept real pg
DECLARE/FETCH execution and require positive cold execution followed by zero
warm source statements.

Enforced limits are2million rows/256MiB cumulative input,2000 rows per batch,
64MiB conservatively charged retained worker state,256MiB worker old-generation
heap,16MiB output,5seconds perSQL statement,45seconds build/ACK deadline, and
10seconds total cold HTTP waiting. Exceeding a bound fails without truncating or
publishing partial counts. Tests exercise worker crash, missing ACK, rollback,
connection release, stale retention, disabled-data eviction and lease theft.

## Final verification

- Final page/DAU/transaction suite:37/37 passed in72.7seconds,
  `/tmp/admin-page-memory-verified.log`. This includes28 page cases, seven
  existing/streamed DAU cases, the complete frozen61-day response, and the
  cancellation-at-BEGIN-acknowledgement regression.
- The frozen response at `test/fixtures/admin-page-memory/legacy-dau-61d.json`
  was generated through real HTTP against exact released commit87b41b1 in a
  temporary baseline checkout using the same dedicated local DB and deterministic
  fixture. Current output deep-equals the entire stats payload, including all
  nine actions,61 daily rows, comparisons, coverage, sources and snapshot metadata.
- BEGIN cancellation was reproduced red with the execution sequence
  `BEGIN ACK, RELEASE` and no rollback. The fix takes transaction ownership
  before awaiting BEGIN; the green test requires rollback before exactly one
  owner release and a subsequent read-committed pooled connection.
- Prototype query names reject with400. RealRedis commands delayed1.2seconds
  each while another owner holds the shared lease still return the pending
  response within the10-second cold budget. Legacy/view simultaneous builds
  never overlap, and changing only the active HMAC version invalidates Invites.
- Parent final released snapshot/purchase/isolation and dashboard compatibility
  run:60/60 passed, `/tmp/admin-page-compatibility-verified.log`. Combined backend
  result is97 distinct passing tests. No unrelated known-baseline assertions
  were changed.
- A diagnostic-only correction uses `process.threadCpuUsage` when available,
  otherwise null, for worker CPU attribution. The210000-event test was rerun
  after that correction:1/1 passed, `/tmp/admin-page-worker-diagnostic.log`.
  This repeated case is not added to the distinct count. Diff checks pass.

## Measured performance and limits

The parent saved full measurements under
`docs/evidence/admin-page-memory-20260913/`. In the populated synthetic30-day
fixture, Overview returned362237 narrow rows in2.307seconds cold and3ms warm;
Activity367753 rows in1.015seconds cold and3ms warm; Retention37412 rows in307ms
cold and3ms warm; Races39169 rows in1.520seconds cold and4ms warm. Charged state
was about3.1MB/0.96MB/6.4MB/6.6MB respectively. All nine pages returned200 and
warm requests performed zero analytics reads. Ads/Shop/Invites/Onboarding had
no matching benchmark rows, so their timing is not a populated-load claim;
nonempty realHTTP parity fixtures separately verify their metric meanings.
The captured benchmark CPU field is labeled `processCpuMs` because that run
predated the per-thread diagnostic correction. Do not interpret it as worker CPU.

A sequential SELECT-only production cursor probe of the formerly timed-out
61-day leaderboard source completed222686 rows in113 FETCHes under the unchanged
5-second statement limit: DECLARE88ms, firstFETCH198ms, maximumFETCH1445ms.
Total16.934seconds includes113 laptop-to-database round trips and is not a
whole-page or app-server-local latency measurement. No index or production
mutation was needed. Production cold-page verification remains a deployment
step requiring the applicable fresh authorization; it has not been claimed here.
