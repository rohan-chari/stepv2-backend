# Shared powerup race guard experiment

2026-09-08. Implemented on top of participant-lock commit `9b2cfb8`; production
comparison is `3b241ffbb3bfcbaeea5153d18f1efd6e69a293a4`. Not deployed.

## Behavior

Independent same-race powerup transactions can now overlap for nine audited
handlers: Protein Shake, Trail Mix, Runner's High, Stealth Mode, Compression
Socks, Mirror, Decoy, Shortcut and Detour Sign. All other powerups retain
exclusive race coordination. No queue, migration, release flag, client field,
response contract or Flutter/platform changes were introduced.

The local path takes shared locks on the existing resolution-job and race rows,
then locks the item and affected participants exclusively. Targeted commands
plan Mirror/Decoy/Socks dependencies, lock participants in user-ID order and
consumable effects in effect-ID order, and revalidate the plan. They execute all
normal validations only after acquiring those locks. Item and race context are
reused with refreshed locked participant rows; there is no second roster load.

Changed plans roll back before retrying, retaining the Decoy random quantile.
Repeated changes fall back to exclusive coordination. An absent resolution row
also falls back in a fresh transaction, while preserving targeted participant
locking. No shared-to-exclusive upgrade happens inside a transaction.

Outage, broad/rank-dependent powerups, lifecycle writers and scoring commits
retain exclusive exclusion. Enqueue remains after commit: an HTTP response can
still wait for queue work even after its gameplay transaction has committed.
This is why the concurrency tests observe committed item state on a separate
connection, not just HTTP completion.

## TDD evidence and coverage

The first five real HTTP tests were written before changing business logic.
On the participant-only baseline, and again on the production release, the
three independent-use cases failed because the second command waited. The
single-shield and shared-Decoy-landing conflict cases passed. The new protocol
passes both independence and conflict assertions.

The expanded shared-guard suite has 18 cases covering:

- Independent Shortcut, Protein/Trail Mix, Socks/Mirror, Runner's High and
  Detour pairs.
- One shield versus two attacks; Decoy redirect into another attack's target.
- Socks, Stealth, Mirror and Decoy insertion winning the lock before an attack.
- Both orderings between Shortcut and exclusive Outage.
- Runner's High and Detour duplicate-activation rejection.
- Missing coordination row fallback and an old-client request without new headers.
- Concurrent real step-sync enqueue followed by a separately spawned real worker;
  public race progress preserves the Shortcut transfer after worker processing.
- Team forfeit waiting for an in-flight shared command.

Test barriers use a test-database-only trigger and advisory lock to pause a real
HTTP transaction before item consumption. No artificial lock hold is included
in performance measurements. Existing suites additionally cover duplicate use,
defense expiry, race deadline crossing, jam rejection, reflection and shield
precedence, Trail Mix history, large-race step fan-out and 2,000-recipient Outage.

Code review found no remaining blockers. The focused acceptance run passed
94/94 integration tests across 14 suites. After strengthening worker completion
assertions, the affected 18-test suite passed again: it verifies SUCCEEDED state,
committed generation, advancing completion/scoring timestamps and public totals.
The full unit run was 3,356 passed / 5 failed;
all five failures were independently reproduced on unchanged `9b2cfb8`:

- `globalEventReliabilityProfiles.test.js`: missing local
  `.env.capacity-prod-flags` fixture.
- `localGlobalEventEntitlement.test.js`: three cases whose mocks lack
  `$queryRawUnsafe` used by the existing implementation.
- `raceWriteFenceInventory.test.js`: existing AST inventory misses a raw
  participant update in the scoring worker.

Those existing assertions were not changed, skipped or weakened. The full unit
suite is not green. Flutter checks were not run for this backend-only change;
iOS and Android keep the same HTTP contract.

## Unpaused HTTP benchmark

Local PostgreSQL 16.14, Node 24.16.0, one HTTP process, 20-connection compatibility
pool. Each burst is four disjoint Shortcuts, two Protein Shakes and two Trail
Mixes. The sync variant additionally submits one real `/steps/sync-v2` upload.
There are three separate process runs per arm, rotating arm order. Each run has
two warmup and five measured bursts per size/sync combination: 120 measured
powerup responses per cell. Fixture setup and assertion queries are outside
measured windows. All recorded requests and authoritative score/item assertions
passed. This is a short local comparison, not a production capacity estimate.

Powerup HTTP p95, milliseconds (lower is better):

| Race size | Concurrent step sync | Production | Participant-only | Shared guards |
| --- | --- | ---: | ---: | ---: |
| 16 | No | 75.4 | 76.8 | 57.2 |
| 2,000 | No | 176.6 | 206.0 | 97.9 |
| 16 | Yes | 66.1 | 68.3 | 41.0 |
| 2,000 | Yes | 178.4 | 214.3 | 91.3 |

At 2,000 players, shared guards reduced measured p95 by about 45% without sync
and 49% with sync versus production. Mean eight-powerup burst completion fell
from 164.6 to 90.4 ms without sync, and from 164.4 to 89.3 ms with sync.

There is a cost: the no-sync 2,000-player burst averages 282 SQL statements on
production, 314 on participant-only and 322.2 on shared guards. Statements
classified as INSERT/UPDATE/DELETE fell from 60 to 52; this classification
includes attempted statements such as guard-row INSERT ON CONFLICT DO NOTHING,
so it is not a measurement of physical rows written or WAL saved. The latency
improvement comes with more concurrent SQL, not proof of lower DB CPU.

Raw rounds: [benchmark results](powerup-shared-guard-benchmark-results.json).
Executable comparisons: `test/integration/powerup-shared-guard-cost.test.js`.
Only point these destructive fixture tests at an isolated localhost `*_test`
database with migrations applied. Run the identical test file at each revision.

## Limits and next release evidence

The separate correctness test processes a real queued job, but benchmark
workers are not running concurrently; the benchmark measures HTTP use plus
intake/enqueue, not sustained scoring throughput or full worker drain time.
Production has two PM2 workers and different database latency/resources.
Database CPU, starvation under sustained shared traffic, and production-sized
mixed-worker load remain unmeasured. Do not extrapolate these bursts to a
production throughput ceiling or claim lower database load.

Remaining 17 enabled types have not gained shared guards. Their broader
rank, inventory, linked-effect or race-wide dependencies require their own
TDD audit before expansion. This experiment is a concrete improvement to the
original independence problem, not proof that every powerup can run in parallel.
