# Race-resolution queue rework requirements

Status: Approved — implementation and verification in progress

## Summary & user story

When a user opens the app, home-screen step sync should make each of that
user's active races eligible for prompt, incremental recalculation without
creating duplicate work. Multiple syncs for the same race should merge into one
durable race-keyed job. A race should have at most one active resolver at a
time, while different races may resolve concurrently.

Live step updates should update only affected participants and any proven
dependencies. Full-race work is reserved for settlement, recovery, and
explicit integrity repair. The existing scoring formulas and settlement
semantics must remain unchanged.

## Current implementation findings

The backend already has durable resolution infrastructure, but it is not yet
the target model:

- `prisma/schema.prisma` contains `RaceResolutionJobV2`, post-task, delivery
  intent, and scoring-input-version records.
- `src/modules/races/jobs/raceResolutionQueueV2.js` claims race-keyed jobs and
  supports generation/versioned processing, leases, dirty reasons, and
  dependency-closure planning.
- `src/modules/races/services/raceResolutionReasonRegistry.js` classifies
  dirty reasons and powerup scopes.
- `src/modules/races/services/raceResolutionStepSyncScope.js` admits only
  narrow step-sync reason sets and currently rejects active-effect races.
- `src/modules/races/jobs/raceExpiry.js` owns final settlement and must remain
  authoritative for payouts and completion.
- Existing tests cover queue claiming, single-writer behavior, closure parity,
  settlement parity, step-sync behavior, and calculation semantics.

The current design therefore provides useful compatibility and calculation
coverage, but the implementation must be changed carefully rather than
replacing the existing resolver wholesale.

## Scope

- Introduce or adapt a durable queue whose primary unit is one race.
- Coalesce pending user/participant changes into that race row.
- Preserve generation-based requeue behavior when a sync arrives during
  processing.
- Enforce one active resolver per race and allow concurrency across races.
- Make incremental live resolution the normal path for step sync and safely
  classified live mutations.
- Keep full settlement, recovery, and integrity-repair paths.
- Separate HTTP request work from resolution/cron execution so resolution CPU
  cannot monopolize API workers.
- Add queue backpressure, priority, and operational metrics.

## Non-goals

- Changing scoring formulas, rankings, payout formulas, effect odds, or economy
  values.
- Removing the canonical full resolver.
- Changing the public mobile API shape solely to implement this backend queue.
- Starting staging during development or rollout.
- Adding a release flag or temporary runtime toggle. Permanent behavior and
  additive compatibility are required unless the user explicitly approves an
  exceptional control.

## Proposed behavior

The implementation adapts the existing `RaceResolutionJobV2` and
`enqueueRaceResolution*` paths; it does not introduce a parallel queue. Queue
truth, generations, dirty sets, leases, retries, settlement state, and coin
mutations remain in Postgres. Redis is not a queue, correctness lock, or
settlement source of truth.

### Step-sync enqueue

After a successful step-input transaction, collect the user's eligible active
race IDs. Enqueue/coalesce one durable record per race using stable `userId`
and participant IDs, never mutable usernames.

The enqueue path must be bounded and must not make the home sync request wait
for full scoring. It should use one batched transaction/outbox operation where
possible. Canonically unchanged input must not create new scoring work.

### Race queue record

The design extends `RaceResolutionJobV2` and the durable record must represent:

- race ID
- pending dirty participant IDs
- triggering user IDs for audit/nudge attribution, not scoring scope
- dirty reasons and effect types
- monotonically increasing generation
- processing generation
- priority
- retry/next-attempt time
- lease token and expiry
- last successful generation and failure metadata

The schema must enforce one logical pending record per race.

### Processing and requeue

The first implementation uses one generation per lease. It does not process
multiple generations while retaining a lease.

1. `FOR UPDATE SKIP LOCKED` atomically claims one race, transfers pending dirty
   sets into processing fields, records the processing generation, and issues a
   fresh lease token.
2. New syncs merge into pending fields and advance the pending generation; they
   never create a second active worker for that race.
3. The worker processes exactly the claimed generation.
4. If newer work exists, it atomically requeues the same row, clears its lease,
   and preserves all pending dirty state.
5. Fence-first writes validate the lease token and generation, use ascending
   user-ID ordering, and roll back on mismatch.
6. Lease expiry makes the processing generation recoverable without dropping
   dirty state; retry and terminal-failure metadata remain durable.

### Incremental resolution

Normal live processing must never recalculate the entire race. It updates the
participants whose stored score can change, plus the directly dependent
participants, and maintains shared projections incrementally:

- participant effective score
- team aggregate
- ranking/index position
- effect state and boundary state
- projection generation

Team races update the syncing participant and adjust the team aggregate. A
Rally Flag, Uprising, or Rainstorm updates the owner/victims whose effective
score changes; its presence does not require recalculating unrelated people.
Leech and Hitchhike update their linked participants and dependency chain.
Race/team aggregates, placements, snapshots, and notifications must use
versioned/idempotent projection writes so an older result cannot overwrite a
newer generation.

The first release must explicitly classify each supported effect. Rainstorm
and Rally Flag are proposed as incremental: their affected participant/team
state is updated when applied, and later step syncs update only the triggering
participant plus proven dependents. Each classification must document its read
set, dependent write set, boundary behavior, cap, and fallback-to-FULL rules.
Unknown effects, unsupported mixed reasons, membership changes, stale
fingerprints, and failed dependency proofs deterministically use the canonical
full resolver.

### Full work

Full-race recomputation is not a normal live or settlement operation. It is a
repair mechanism used only when:

- a projection is missing or inconsistent
- queue processing or a worker outage leaves work incomplete
- a migration/version mismatch is detected
- an explicit administrative integrity repair is requested

Settlement/expiry remains owned by `src/modules/races/jobs/raceExpiry.js` in
this rollout rather than being claimed by the live resolution worker. It
acquires exclusive race ownership through the same Postgres race write fence,
locks/validates membership before participant writes, and retries deadlocks.
Its work is therefore not represented by the queue's `queue_priority` counters;
the separate settlement fence is the ordering boundary until expiry is moved
into a durable settlement job in a later, explicitly reviewed change. If
settlement detects that projections fail validation, it must repair or retry
before paying; it must not silently settle from incomplete state.

### Concurrency

Workers may process different races concurrently. A race must never have two
simultaneous live resolvers. Enforce this with an atomic database claim/lease
and, where required by existing write-fence semantics, the existing race-level
write fence/advisory lock. A stale lease must be safely recoverable.

### Priority and backpressure

Use explicit priority classes:

1. settlement/expiry
2. recovery and integrity repair
3. user-visible live updates
4. low-priority post-tasks and maintenance

Bound global concurrency, per-race work, database pool wait, and retry rate.
When capacity is saturated, coalesce/defer lower-priority live work rather than
allowing unbounded transaction queues.

## Process topology

Production will run exactly two `steps-tracker` HTTP workers, one
`steps-tracker-resolution` worker for the race queue/post-tasks, and one
`steps-tracker-cron` worker for `raceExpiry` and scheduled jobs. HTTP workers
must not schedule duplicate resolution or cron work. Each process must stop
new claims and shut down gracefully; an active lease must finish or expire
safely. Staging remains stopped by default.

## API and compatibility

No new mobile API endpoint is required. Existing clients continue to submit
step syncs and receive the existing response shape. Older clients must remain
compatible with the backend because the backend serves frozen app versions.

The backend must preserve additive/default-safe behavior, existing response
fields, idempotency, and settlement semantics. Queue metadata is internal and
must not be exposed as a required client field.

## Data migration and rollout

- Use an explicit expand → quiet-period/drain → cutover → contract rollout.
- Add nullable/defaulted fields to `RaceResolutionJobV2`; do not remove or
  repurpose existing fields during expand.
- Drain old claims, verify no old leases remain, and recover abandoned jobs
  before cutover; old and new workers must not bulk-write the same race.
- Rollback uses `raceQueueV2ClaimingDisabled` and restores the prior topology
  without abandoning pending work.
- Keep compatibility fields and migration paths for at least one week after
  cutover, then remove them only after explicit verification.
- Deploy schema/code compatibility before changing process topology.
- Never run migrations or integration tests against production data.

## Queue state transition table

| State | Meaning | Allowed next states |
| --- | --- | --- |
| QUEUED | Durable pending generation | RUNNING, FAILED |
| RUNNING | One worker owns a lease/token | QUEUED, SUCCEEDED, FAILED |
| SUCCEEDED | Processed generation is current | QUEUED when newer work arrives |
| FAILED | Retryable failure is recorded | QUEUED after retry deadline |

Every transition is atomic and token-checked. Dirty state is never dropped on
failure, lease expiry, stale-writer rejection, or saturation.

## Test plan — tests first

Before implementation code changes, establish a baseline by running the
existing calculation and queue suites without adding or weakening tests. The
baseline must include:

- `test/integration/race-queue-v2-closure-parity.test.js`
- `test/integration/race-queue-v2-settlement-parity.test.js`
- `test/integration/race-queue-v2-single-writer.test.js`
- `test/integration/stepSyncV2.test.js`
- `test/integration/step-sync-performance-service.test.js`
- `test/services/raceResolutionReasonRegistry.test.js`
- `test/services/raceResolutionStepSyncScope.test.js`
- `test/services/raceStateResolution.test.js`
- `test/jobs/raceResolutionQueueV2.test.js`

Then add failing integration tests before implementation for:

- one race row created for many syncs
- user IDs coalesced into the existing race row
- input-equivalent syncs not creating scoring generations
- a sync arriving during processing advancing the generation
- same race rejected for a second concurrent claim
- different races processed concurrently
- lease expiry/recovery
- bounded repeated processing of a continuously busy race
- incremental Rainstorm/Rally Flag updates without full recalculation
- settlement fencing live work and preserving payout parity
- queue priority and backpressure
- separate resolution process not blocking HTTP workers
- old clients retaining the existing step-sync response contract

All integration tests must use the dedicated local/test Postgres database.

## Acceptance criteria

- Existing calculation and settlement parity tests remain green.
- A burst of syncs for one race produces one coalesced durable race job.
- No race has two active live resolvers, including after worker crashes.
- New syncs during processing are never lost and are processed in a later
  generation.
- Normal live syncs do not require full-race recomputation merely because an
  area-of-effect effect exists.
- Settlement and recovery remain authoritative and idempotent.
- Resolution work cannot monopolize HTTP workers.
- Queue priority is persisted, higher-priority work cannot be starved, and
  deferred lower-priority work remains durable.
- Queue depth, age, coalescing, escalation, retries, transaction waits, and
  settlement delay are observable.
- `npm run test:unit` and `npm run test:integration` pass against test DB;
  `npm test` is not used.
- Production deployment is backend-first, with staging stopped unless
  explicitly authorized.

## Open questions for product/architecture interview

1. Should the queue store dirty participant IDs only, or both participant IDs
   and user IDs for recovery/audit semantics?
2. What maximum per-race processing time/pass count should cause a busy race to
   yield and requeue?
3. What exact per-race projection validation should settlement perform before
   paying out?

## Revision log

- Draft created after repository exploration. Captured existing generation,
  lease, dirty-reason, dependency-closure, settlement-fence, and parity-test
  infrastructure.
- Gap pass 1: clarified that a sync arriving during processing advances the
  same race row's generation rather than creating a duplicate row; added a
  bounded-yield rule for continuously busy races; required user IDs rather
  than mutable usernames; separated live incremental work from settlement.
- Gap pass 2: added the outbox/batched-enqueue constraint, explicit stale-result
  protection, per-race serialization under increased global concurrency,
  area-of-effect incremental semantics, process-topology requirements, and
  the prohibition on client-visible queue contract changes.
- Baseline run: existing unit suites were run with a name filter covering
  resolution, queue, step-sync, and calculation tests. The run exposed
  pre-existing local test-database schema failures (`column (not available)
  does not exist`); no tests or assertions were changed. A clean baseline
  requires repairing/migrating the local test database before implementation.
- Architect review: REQUIRED changes incorporated—Postgres-only queue truth,
  one-generation-per-lease protocol, migration drain/cutover/rollback, exact
  process topology, incremental-effect classification, settlement fencing,
  persisted priority/backpressure, and a green post-migration baseline gate.
- Product clarification: full-race recomputation is repair-only. Normal live
  updates and settlement consume incrementally maintained participant/team
  projections; Rally Flag, Uprising, Rainstorm, and team races do not by
  themselves trigger full work.
