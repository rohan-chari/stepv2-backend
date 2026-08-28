# Race-resolution placement notification requirements

## Summary & user story

Move score-driven individual placement transitions and team lead transitions
from the five-minute `placementRecompute` sweep into the durable, race-keyed v2
resolution pipeline. A race generation that commits new standings must
atomically commit one constant-size placement handoff; a retryable placement
worker then atomically commits the corresponding baselines and generic domain
events.

As a participant in a large race, when my sync changes the standings, everyone
whose live rank changes should receive the same placement behavior they receive
today without waiting for an unrelated full-race timer. As an operator, a
process crash, retry, concurrent sync, or rolling deploy must never advance a
placement baseline without its durable event, lose a current transition, or
send the same logical transition twice.

The target path is:

```text
one or more users sync
  -> one race-keyed resolution generation merges their dirty participant IDs
  -> dependency closure expands the scoring set or safely selects FULL
  -> the worker computes a full accepted-roster result
  -> the fenced score write also upserts one durable placement job
  -> the placement worker bulk-commits baselines + domain events
  -> the existing domain-event projector materializes/retries notifications
```

Reading/ranking a complete 200+ member roster is acceptable. The defect is the
current timer-driven write path: it scans every active race, then performs
per-participant baseline and event calls sequentially inside one five-second
transaction.

## Current behavior and confirmed failure

- `enqueueRaceResolutionForUser` maps a syncing user to every active race they
  belong to and records that user's accepted participant ID in the race's dirty
  envelope (`src/modules/races/services/enqueueRaceResolution.js`).
- `RaceResolutionJobV2.enqueueMany` owns one row per race. Enqueues that arrive
  before claim merge distinct users/participants. An enqueue that arrives while
  the row is running advances the generation; `recordSuccess` requeues the
  follow-up instead of discarding it
  (`src/modules/races/models/raceResolutionJobV2.js`).
- The permanent dependency-closure planner recomputes the dirty participants
  and any transitive score dependencies. It safely chooses `FULL` for race-wide,
  unknown, or otherwise unprovable cases
  (`src/modules/races/services/raceScoringDependencyClosure.js`).
- The uploader's immediate reconciliation intentionally does not own placement
  events (`src/modules/races/services/reconcileUploaderRaces.js`).
- `placementRecompute` still loads every accepted participant in every active
  race, ranks each race, updates `lastNotifiedPlacement`, and appends
  `PLACEMENT_CHANGED_V1` events every five minutes
  (`src/modules/races/jobs/placementRecompute.js`).
- The production Daily Challenge
  `3fe85a66-2043-4db6-8066-b17eb2958f62` had 97 accepted participants and 83
  changed placement baselines. The cron attempted hundreds of sequential
  statements inside its default five-second interactive transaction and
  expired repeatedly in outbox/audience/readback calls.

## Scope

1. Make the v2 race-resolution pipeline and its guarded placement worker the
   primary owner of score-driven:
   - individual `lastNotifiedPlacement` changes;
   - `PLACEMENT_CHANGED_V1` domain events;
   - team live-rank baselines; and
   - `TEAM_LEAD_CHANGED_V1` domain events.
2. Preserve the existing ranking comparator, paid-place calculation,
   first-observation behavior, mute behavior, finished-row behavior, team
   behavior, notification payloads, cooldown classification, Inbox behavior,
   silent-refresh behavior, and APNs/FCM delivery path.
3. In the queue's existing fenced score transaction, persist only a constant-
   size durable placement handoff. A retryable placement worker then persists
   baselines and generic domain events through a bounded, set-based transaction.
4. Stop the production five-minute scheduler from being the primary producer
   of score-driven placement/team-lead transitions.
5. Retain clock-driven reminders, step-sync pulls, due-effect recovery, and
   stale/missing resolution-job recovery without wrapping a complete large race
   placement fan-out in one transaction.
6. Preserve a bounded recovery entry point capable of repairing placement
   transitions for specifically selected stale/recovery races.
7. Add detailed real-Postgres integration coverage, including simultaneous
   users, superseded generations, transaction failure, projector delivery, and
   a large-race simulation. Do not add or run a capacity/load benchmark for
   this change.

## Non-goals

- No scoring formula, tie-order, power-up, payout, odds, coin, race-size, or
  settlement change.
- No HTTP endpoint, request, response, Flutter, iOS, or Android change.
- No visible notification copy, eligibility, cooldown, or navigation change.
- No promise that APNs/FCM physically displays a push exactly once. The backend
  guarantees durable, idempotent notification intent creation and retry;
  provider delivery remains at-least-once.
- No Redis leaderboard or external broker.
- No database-capacity benchmark and no race-cap increase in this change.
- No production connection-pool sizing change. Pool budgeting remains a
  separate operational improvement because integration tests cannot validate
  production connection capacity.
- No release flag, rollout percentage, kill switch, or temporary environment
  toggle.
- No production deployment as part of implementation. Deployment requires a
  separate, in-the-moment approval after all verification is green.

## Functional requirements

### 1. Queue merge and generation semantics

The existing semantics are retained and locked down with integration tests:

1. If Alice and Bob sync into Race X before its job is claimed, one race job
   accumulates both accepted participant IDs and both triggering user IDs.
2. The worker computes and persists both current scores in that generation,
   plus any participants admitted by dependency closure.
3. If Bob syncs after Alice's generation is claimed, the row remains running,
   its generation advances, and Bob is retained for a follow-up generation.
4. A current generation may produce placement transitions for every displaced
   accepted participant, not just dirty participants. A score change is local;
   rank changes are relative.
5. A superseded generation may commit its canonical score writes under the
   existing fence rules, but it must not advance placement baselines or append
   score-driven placement/team-lead events. The follow-up current generation
   owns the observable standings transition.
6. Existing dependency-closure safety remains authoritative. This feature must
   not introduce a second dependency graph or bypass a `FULL` fallback.

### 2. Canonical placement transition planning

Create one backend service, proposed path:

`src/modules/races/services/racePlacementTransitions.js`

It exports only the pure planner:

```js
planRacePlacementTransitions({
  race,
  participants,
  sourceGeneration,
  occurredAt,
})
```

Planner rules:

- Rank the full accepted roster with
  `compareParticipantsForPlacement`; no local comparator copy is allowed.
- Use the same funded and legacy paid-place helpers and inputs as the current
  scheduler.
- Exclude finished participants from live baseline changes and events.
- An absent baseline is seeded silently.
- A muted participant's changed baseline advances silently.
- An unchanged baseline produces no write/event.
- An ordinary individual transition creates the same immutable payload facts
  consumed by today's `PLACEMENT_CHANGED_V1` projector: race ID/name, recipient,
  previous/new placement, paid places, and race end. `totalParticipants` stays
  out of the durable payload because today's projector does not consume it; the
  in-memory planner may retain it only for diagnostics/parity.
- Individual transition identity is deterministic and generation-stamped:
  `placement:<participantId>:resolution:<sourceGeneration>:<old>-><new>`.
- Team races do not emit individual placement events. Preserve the existing
  team ranking and lead/tie rules. Persist the team live-rank baseline for the
  same accepted team-member population used today (do not silently add a new
  finished/forfeited filter) and append one deterministic
  `TEAM_LEAD_CHANGED_V1` event only for a real, armed lead transition. Reuse
  the existing `JobRun` transition claim (`team-lead:<raceId>` with
  `<old>-><new>`) so reverse/repeat flips remain valid and a rolling old cron
  and new worker cannot both publish the same flip. The team `transitionId` is
  generation-stamped:
  `team-lead:<raceId>:resolution:<sourceGeneration>:<old>-><new>`. The event key
  is `TEAM_LEAD_CHANGED_V1:<transitionId>`, so a valid later A→B after B→A is
  never mistaken for the earlier A→B.
- The planner accepts only already-computed domain facts. It must not import
  notification delivery, notification tables, Redis, APNs, FCM, or device
  tokens.

The placement worker loads the full canonical accepted roster from committed
rows after score resolution. Before planning, verify that participant IDs are
unique, every row is accepted/in-scope, and the roster matches the claimed
generation's accepted-membership/scoring fingerprint. If it cannot prove a
complete stable roster, it writes nothing and leaves the job recoverable rather
than ranking a subset.

### 3. Durable score-to-placement handoff

Do not make a race score commit depend on a large notification-derived fan-out.
Add an additive `RacePlacementTransitionJob` model/table with one coalescing row
per race:

```text
id                       text/uuid primary key
race_id                  text unique, FK races(id) on delete cascade
requested_generation     integer not null
processing_generation    integer null
completed_generation     integer null
state                     queued|running|retry|succeeded (database enum)
requested_at              timestamp not null
observed_at               timestamp not null
processing_observed_at    timestamp null
not_before_at             timestamp not null
attempts                  integer not null default 0
retry_at                  timestamp null
started_at                timestamp null
completed_at              timestamp null
last_completed_at         timestamp null
lease_token               text null
lease_expires_at          timestamp null
last_error_code           text null
created_at/updated_at      timestamp not null
```

Add database constraints requiring all requested/processing/completed
generations to be positive when present,
`completed_generation <= requested_generation`, and
`processing_generation <= requested_generation`. Add a stable claim index on
`(state, not_before_at, retry_at, requested_at, race_id)` and an expired-lease
index in addition to the unique race index.

The race-resolution fenced transaction upserts this row only after
`recordSuccess` proves the processing generation is current. The upsert keeps
the greatest requested generation. It replaces `observed_at` only when the
incoming generation strictly advances; a replay of the same generation
preserves the original observation time. It queues follow-up work without
allowing a running older generation to erase a newer request. This one-row
handoff is domain infrastructure: it contains no notification copy, device,
Inbox, cooldown, or provider data.

State machine (all ownership changes compare-and-set the lease token and
processing generation):

1. **Enqueue absent:** insert `queued`, requested generation `G`, null
   processing/completed generation, `requested_at=observed_at=now`, and
   `not_before_at=now+1s`.
2. **Enqueue same/older generation:** no generation, time, or state change. In
   particular, do not extend `observed_at` or the debounce floor.
3. **Enqueue newer while queued/retry:** set requested generation to `G`, state
   `queued`, clear retry/error, preserve the oldest unserved `requested_at`,
   replace `observed_at`, and set `not_before_at=now+1s`. From `succeeded`, the
   same transition starts a new request with `requested_at=now`.
4. **Enqueue newer while running:** update requested generation/observation and
   set `requested_at=now` plus the follow-up debounce, but retain running state,
   processing generation, processing observation, lease, and attempt owner.
   Completion sees the newer request and requeues it.
5. **Claim:** eligible `queued`/`retry` rows require debounce and retry times <=
   now and requested generation greater than
   `COALESCE(completed_generation, 0)`. A null `retry_at` is immediately
   retry-eligible once the debounce floor passes. Claim in
   stable oldest-first order with `FOR UPDATE SKIP LOCKED`; set `running`, copy
   requested generation/observation to the processing fields, stamp
   `started_at`, issue a 30-second lease, and increment attempts.
6. **Lease reclaim:** an expired `running` row may be claimed with a new token;
   it processes the latest requested generation, never an abandoned older one.
7. **Current success:** if requested equals processing, set `succeeded`, set
   completed to processing, clear processing/lease/retry/error, and record
   `completed_at`/`last_completed_at`.
8. **Superseded success/fence rejection:** if requested is newer than
   processing, write no baselines/events for the old plan; set/retain `queued`,
   clear the old processing lease, reset attempts for the newer request, and
   honor its existing debounce floor.
9. **Failure:** roll back placement facts, CAS the owned row to `retry`, clear
   its lease, retain requested generation, and use backoff of 1s, 5s, 30s, then
   a capped five minutes. Attempts never discard a logical request; attempts
   beyond the third emit an operator alarm while durable retry continues.
10. **Same-generation replay after completion:** preserve completed generation
    and observation time and return an idempotent no-op.

The score transaction therefore remains independent of placement event fan-out:
if placement planning or domain-event expansion fails, committed scoring stays
committed and the durable placement job retries.

### 4. Placement claim/fence and set-based persistence

Add a placement worker under the existing resolution-process topology; do not
add another PM2 process. It claims rows in stable order using a short lease and
`FOR UPDATE SKIP LOCKED`, computes outside a transaction, then fences and
persists in a short transaction.

Claim/planning rules:

1. A placement job is eligible only when the corresponding resolution job is
   `succeeded`, has no newer queued/running generation, and its completed/current
   generation equals the placement job's processing generation.
2. Load the canonical accepted roster and race facts after the score commit,
   then build the placement plan.
3. Before the first placement write, lock/re-read both queue rows and the
   accepted-membership/scoring fingerprint. If generation, membership, or
   scoring input changed, write nothing and leave/merge the newer request for a
   fresh computation.
4. A lease loss writes nothing. Expired leases are reclaimable. Retry backoff
   and a repeated-failure operator alarm follow existing queue conventions;
   no logical placement request becomes terminally discarded.
5. A newer race-resolution generation arriving after placement claim but before
   the placement fence invalidates the old plan. The old plan writes nothing;
   the placement row retains or receives the newer requested generation.

Placement persistence must:

1. Validate and normalize all planned domain-event payloads before the first
   write.
2. Compare-and-set baselines against the planner's observed old value. It must
   never overwrite `total_steps`, `raw_steps`, finish state, forfeiture state,
   or a concurrently changed baseline.
3. Perform baseline changes in one set-based statement for the generation, not
   one Prisma call per participant.
4. Bulk-insert matching `domain_event_outbox` rows and
   `domain_event_audiences` rows for CAS winners only.
5. Keep baseline changes and event/audience inserts in the same placement
   transaction. A failure in any statement rolls back all placement baselines,
   child events/audiences, and placement-job completion, while the already
   committed race score remains intact and the job retries.
6. Use deterministic unique event keys. On a replay or ambiguous commit,
   verify an existing key's immutable event and audience facts; never treat a
   mismatched collision as success.
7. Return aggregate counts only: proposed, baseline winners, silent baseline
   winners, event inserts, idempotent replays, and CAS losses. Do not log user
   IDs or step totals.
8. Use a bounded payload size and preserve the domain-event invariant checks.
   Use a checked-in page size of 250 planned baseline rows. Large-race
   persistence may use multiple pages, but all pages remain inside one
   placement transaction so baselines and child events cannot diverge. Query
   shape is bounded by fixed fence/completion statements plus a fixed number of
   baseline/event/audience statements per page.
9. Derive one stable `occurredAt` for the claimed generation and reuse it for
   every event in that plan. Payout-window classification must observe the
   standings-observation time, not projector drain time.
10. For team lead changes, the transition-valued `JobRun` claim, team baseline
    CAS writes, event/audience insert, and placement-job completion share this
    transaction. Failure after the claim rolls the claim back, so retry cannot
    lose the flip.

Layering and dependency injection are mandatory:

- `racePlacementTransitions` is the pure race-domain planner only.
- Placement-job claim/lease/retry SQL and participant baseline SQL live in race
  model modules.
- Normalized bulk event/audience insertion and immutable collision verification
  live behind the domain-events command/model API and reuse
  `normalizeDomainEvent` and the existing immutable-fact comparison semantics.
  A race service must not become a parallel repository for domain-event tables.
- An injected orchestration service composes those dependencies. Every failure
  seam used by integration tests is injected; production defaults resolve the
  real models and commands.

Raising Prisma's timeout is not the solution. This work must eliminate
per-recipient round trips so the placement transaction duration grows with bulk
rows rather than network calls.

### 5. Resolution-worker integration

Modify `src/modules/races/jobs/raceResolutionQueueV2.js` in this order:

1. Compute scores outside the transaction exactly as today.
2. Enter the existing fenced write transaction and revalidate all existing
   membership/input/generation fences.
3. Persist score/effect writes.
4. Call `recordSuccess` in the same transaction to learn whether the generation
   is current or superseded.
5. Only when `recordSuccess.applied === true` and
   `recordSuccess.superseded === false`, upsert the race's placement job for the
   committed source generation in that same transaction.
6. A handoff-upsert failure rolls back score writes and `recordSuccess`, closing
   the score-commit/process-crash gap with constant work.
7. Publish no process-local placement event after commit. The placement job's
   committed generic child events are the sole notification source.

If a score generation's input/membership fence rejects, no placement handoff is
created. If a placement generation's fence rejects, its precomputed placement
plan is discarded and recomputed; it must never be reused against refreshed
inputs.

### 6. Scheduler decomposition and recovery

Refactor `src/modules/races/jobs/placementRecompute.js` without deleting its
clock-driven behavior:

- Ordinary individual placement and team-lead production no longer runs for
  every active race in the normal five-minute path.
- `RACE_ENDING_SOON`, team final-stretch reminders, team slacker reminders,
  due-effect enqueueing, missing/stale resolution-job recovery, and throttled
  step-sync pulls retain their current timing and recipient semantics.
- Remove the single per-race transaction that currently surrounds all
  reminder, baseline, and event work. Every reminder that consumes a `JobRun`
  or notification delivery claim must claim and append its generic event in one
  short transaction. A failure between claim and append rolls back the claim;
  failure for one recipient/race must not roll back unrelated reminders.
- The existing recovery selector remains bounded. A selected missing, failed,
  or stale race is enqueued into the resolution queue. A succeeded resolution
  generation lacking a current placement job is repaired by upserting that
  generation's placement job; the cron never performs the placement fan-out.
- Keep an explicitly callable recovery seam for integration tests and incident
  repair. It may only upsert placement jobs for caller-selected race IDs and
  current succeeded generations; it must not directly mutate baselines or
  restore the production all-active-races write sweep.
- Retain distributed scheduler ownership/overlap protection for the remaining
  clock work.
- Register the placement claimer only inside the existing resolution-owner
  branch of guarded `startCrons()` in `src/index.js` (or drain it from the
  already guarded resolution scheduler). It inherits the
  `NODE_APP_INSTANCE === "0"` ownership gate and never starts from HTTP or cron
  roles. A startup/structural test locks down that topology.

### 7. Existing notification pipeline

Do not change the public event or notification contract:

- `PLACEMENT_CHANGED_V1` and `TEAM_LEAD_CHANGED_V1` remain the domain-event
  types.
- `producerMatrix`, `notificationProjector`, `projectionClassification`, and
  `domainEventV1Projection` continue to own visible-vs-silent classification,
  payout-drop cooldowns, copy, Inbox materialization, and delivery.
- Existing delivery keys remain recipient-scoped and idempotent.
- The feature may add the queue worker as an allowed producer in the producer
  matrix/structural guard, then remove `placementRecompute` as the primary
  score-driven producer. It must not broaden allowed notification imports into
  race domain code.

## API contract

No endpoint, request, response, status code, authentication rule, or error body
changes. Existing clients continue to sync steps and read races through the
same APIs.

The only observable differences are intended operational improvements:

- placement notification intent creation follows the committed race generation
  instead of waiting up to five minutes for the next sweep;
- obsolete superseded generations do not notify; and
- large-race placement processing no longer fails because one giant cron
  transaction expires.

## Data model and migrations

Add one backward-compatible migration for
`race_placement_transition_jobs`, using the fields and indexes in Functional
Requirement 3. Old processes ignore the new table. New code must tolerate an
empty table and creates rows only for successfully committed generations.

Also reuse:

- `race_resolution_jobs_v2` generation and dirty-envelope columns;
- `race_participants.last_notified_placement` and
  `placement_alerts_muted`;
- `domain_event_outbox`; and
- `domain_event_audiences`.

No bulk baseline backfill is required. Existing baselines remain valid. During
deploy, run an idempotent, resumable catch-up in stable race-ID pages of at most
100 that creates placement jobs for
currently succeeded, real race-resolution generations of active races; it must
not update participant or notification data itself. Eligibility requires
`generation > 0`, non-null `processing_generation`,
`processing_generation = generation`, `state = succeeded`, and non-null
`last_completed_at`. The inert generation-zero row created solely by
`acquireForWrite` is never a standings source; recovery encountering it must
enqueue a real resolution generation instead. The normal recovery scheduler
then maintains this invariant. The migration is additive and safe while old
and new PM2 processes overlap. Because there is at most one placement row per
race and race deletion cascades, no separate retention job is needed.

## Frontend plan

No Flutter code, assets, screens, widgets, API parsing, iOS behavior, or Android
behavior changes. Both platforms continue receiving the same notification and
race payloads. No UI-placement checklist is required.

## Backward compatibility and rollout

- This is backend-internal and additive to existing domain-event production.
  Frozen app versions receive the same payloads and routes.
- No new client capability or required request field exists.
- No feature flag is introduced. Permanent behavior becomes active with the
  backend deploy.
- Rolling-process compatibility is mandatory. During reload, an old cron and
  new resolution worker may race on the same participant. Individual placement
  uses baseline CAS, so exactly one writer wins and a loser appends no event.
  Team lead uses the existing transition-valued `JobRun` claim in both paths,
  so only one producer may append a given flip while reverse/repeat flips stay
  valid.
- New generation-stamped event keys are internal. Existing projection delivery
  keys and event schemas remain supported.
- Deploy order is migration, resolution process (which begins durable handoff),
  bounded catch-up run to exhaustion in stable pages of at most 100 races, then
  cron process (which retires primary placement production), followed by the
  two HTTP workers. The guarded deploy must verify
  the placement worker is claiming before the old cron producer is retired.
  Rolling back code leaves the additive table inert and the old cron resumes
  ownership. Implementation completion does not authorize production
  deployment. Before deployment, provide the exact commit,
  migration name, restart scope/order, catch-up command, verification commands,
  and rollback commit/tag, then request fresh approval.

## Detailed tests-first integration plan

All integration tests use only the dedicated local
`steps-tracker-integration_test` database. Confirm the URL before every run.
Tests enter through real HTTP sync routes or the public queue/scheduler worker
seams and assert real Postgres rows. They must not import an internal utility
as a substitute for the public behavior being proved.

Write the following tests before business logic and demonstrate that the new
ones fail for the expected reason.

### A. Queue accumulation and generation ordering

1. **Two syncs before claim:** create one active race, POST real sync samples
   for Alice and Bob, assert one race job contains both triggering users and
   dirty participant IDs, process it, and assert both totals and the resulting
   displaced-user baselines/events.
2. **Sync during processing:** pause a claimed generation at the existing
   compute/fence seam, POST Bob's sync, release Alice's generation, assert it is
   superseded and emits no placement event, then process the follow-up and
   assert the final standings transitions exactly once.
3. **Repeated same-user burst:** submit multiple Alice syncs before claim,
   assert participant dedupe, latest score, one current placement transition,
   and no duplicate outbox/audience rows.
4. **Dependency expansion:** use a real supported cross-participant power-up so
   a sync expands the closure; assert every changed score and every displaced
   placement from the full roster matches the canonical full result.
5. **FULL fallback:** use a race-wide/unsupported condition and assert full
   scoring plus the same placement results, proving the placement planner does
   not bypass closure safety.

### B. Atomicity, concurrency, and retry

6. **Durable handoff failure:** fail the placement-job upsert inside the score
   fence. Assert score writes and `recordSuccess` roll back so a score commit can
   never escape without its constant-size placement handoff.
7. **Outbox failure isolation:** inject failure at the child domain-event bulk
   insert. Assert the already committed score remains, while baseline writes,
   event rows, audience rows, and placement-job completion roll back; retry
   succeeds.
8. **Audience failure rollback:** fail after outbox insertion but before
   audience completion and assert the same all-or-nothing result.
9. **Baseline CAS race:** concurrently change one baseline after computation
   but before persistence. Assert that participant is a CAS loser, its newer
   baseline survives, and no event is appended for it; unaffected winners
   commit.
10. **Concurrent old/new producers:** run the legacy cron producer and the new
   placement worker concurrently against the same old baseline. Assert one
   baseline winner and one logical transition, with no duplicate visible or
   silent delivery.
11. **Ambiguous/replayed generation:** execute the same deterministic plan
    twice and assert immutable event-key verification, one event, one audience,
    one visible projection, and one silent projection where applicable.
12. **Worker crash after score commit:** commit a score plus placement-job row,
    stop before placement claim, restart/drain the placement worker, and assert
    the intended baselines/events materialize exactly once.
13. **Projector crash after placement commit:** commit placement domain events without
    running the projector, restart/drain the real projector, and assert the
    intended notification materializes exactly once.
13a. **New score generation during placement computation:** claim placement
    generation G and pause before its fence, POST a newer real sync that advances
    the score queue to G+1, then release G. Assert G writes no baseline/event,
    the newer requested placement generation survives, and the follow-up emits
    only the final transition once.
13b. **Team claim crash gap:** win the real transition-valued `JobRun` claim,
    fail before the team event insert, and assert the transaction rolls the
    claim/baselines back. Retry must produce the flip once. Then execute
    A→B, B→A, A→B and assert three distinct generation-stamped events.

### C. Placement semantic parity

14. **Tie ordering:** equal steps rank by joined time and then user ID exactly
    as every read surface does.
15. **First observation:** null baseline advances silently.
16. **Muted participant:** changed baseline advances with no visible or silent
    placement event.
17. **Finished participant:** baseline remains frozen and no live event emits.
18. **Forfeited participant:** preserve current accepted-roster/ranking
    behavior exactly; lock it with a parity assertion rather than redefining it.
19. **Unchanged participant:** no baseline write and no event.
20. **Lead transition:** becoming/losing first place produces the same visible
    classification and payload as today.
21. **Payout drop:** crossing out of paid places inside/outside the configured
    end window preserves current visible/cooldown behavior.
22. **Ordinary movement:** preserves current silent-refresh projection and
    does not create an unintended visible alert.
23. **Team lead:** preserve lead, reverse lead, repeated lead, tie, team
    baseline, and event dedupe behavior.
24. **Seeded and user-created races:** both use their canonical timezone and
    current funded/legacy paid-place calculation.

### D. Large-race integration simulation (not a capacity test)

25. Create a 250-participant individual race in real Postgres. Submit multiple
    real user syncs that reorder at least 200 participants. Drain the actual
    resolution worker and domain-event projector. Assert:
    - one race-keyed queue lineage;
    - correct canonical ranking for all 250 rows;
    - no transaction timeout;
    - every ordinary event-required baseline winner has one matching event and
      audience, while first-observation/muted winners remain intentionally
      silent;
    - silent/visible projection counts match classification;
    - rerun is idempotent; and
    - participant totals were not modified by baseline persistence; and
    - baseline/event persistence uses a fixed bounded number of SQL statements
      or configured pages, never one statement sequence per recipient.
26. Repeat the persistence/semantic matrix with 750 participants using direct
    fixture creation plus the real worker seam. This is a deterministic
    integration correctness simulation, not a throughput, latency, connection,
    or capacity gate. Assert the same bounded statement/page-count invariant.

### E. Scheduler and regression behavior

27. Assert the normal five-minute tick does not produce ordinary individual
    placement or team-lead events for every active race.
28. Assert a bounded stale/missing score job is re-enqueued and its subsequent queue
   generation repairs placement state.
29. Assert a succeeded score generation with a missing/stale placement handoff
    is repaired by the bounded recovery path and drains exactly once.
29a. Assert an active race with only an inert succeeded generation-zero lock row
    receives no placement handoff; recovery enqueues and completes a real
    generation before placement processing begins.
30. For every `JobRun`/notification-claim reminder family, inject failure after
    the real claim but before event append. Assert claim rollback and one
    successful event on retry.
31. Assert race-ending-soon, team final-stretch, slacker reminders,
    due-effect/recovery enqueues, and throttled step-sync pulls retain their
    current timing and dedupe behavior.
32. Preserve structural notification-domain isolation: the score transaction
    may write only the generic placement-job handoff; the placement
    planner/persister may append generic domain events but may not import
    notification projection/delivery code.
33. Assert startup schedules placement claims only for the guarded resolution
    owner (`NODE_APP_INSTANCE` owner instance), never HTTP or cron roles.
34. Update existing placement scheduler tests mechanically to enter through
    the queue or explicit recovery seam while retaining—not weakening—their
    semantic assertions.

### F. Verification commands

1. Confirm the integration database target is local and ends in `_test`.
2. Run focused new/modified integration files individually while developing.
3. Run `npm run test:unit`.
4. Run `npm run test:integration` once after focused suites are green.
5. Run repository structural/generated checks relevant to touched runtime
   controls and producer matrices.
6. Never run bare `npm test` and never point integration tests at production.

## Observability

Add constant-handoff fields to the existing `race_resolution_v2` log:

- placementHandoffGeneration
- placementHandoffOutcome (`queued`, `merged`, `superseded_skip`,
  `not_applicable`)

Add aggregate fields to a separate `race_placement_transition` worker log:

- placementProposed
- placementBaselineWinners
- placementSilentWinners
- placementEventInserts
- placementEventReplays
- placementCasLosses
- placementPersistMs
- placementOutcome (`committed`, `superseded_skip`, `incomplete_roster_skip`,
  `not_applicable`)

The remaining scheduler logs separate reminder/recovery outcomes from score-
driven placement. No user IDs, participant IDs, device tokens, or step totals
are logged.

## Acceptance criteria / definition of done

- A current race-resolution generation atomically commits canonical score
  writes and one durable placement handoff; a retryable fenced placement worker
  atomically commits baselines and durable placement/team-lead domain events.
- Multiple syncing users in one race are accumulated or followed up according
  to existing generation semantics; none is replaced or lost.
- Superseded generations do not emit obsolete placement notifications.
- The normal five-minute scheduler is no longer the primary score-driven
  placement producer.
- Clock-driven reminders and recovery behavior retain semantic parity.
- Placement fan-out failure cannot roll back committed scoring and cannot be
  lost; its durable job retries.
- Generation-zero lock rows never produce placement; newer score generations
  fence out older claimed placement plans.
- Every claim-consuming reminder and team transition keeps claim+event
  atomicity across injected failure and retry.
- A 250-participant real-HTTP/real-worker integration simulation and a
  750-participant real-worker correctness simulation pass without an
  interactive-transaction timeout and prove a bounded, non-per-recipient SQL
  statement/page shape.
- All notification semantic, retry, crash, concurrency, and idempotency cases
  above pass against real Postgres.
- No existing assertion is weakened, skipped, or deleted. Necessary routing
  updates retain the original behavior assertion at the new public seam.
- `npm run test:unit` and `npm run test:integration` are green.
- No frontend change is required; iOS and Android contracts remain unchanged.
- Version-skew and rolling-process safety are explicitly verified.
- Architect review required changes are incorporated.
- Post-implementation code review reports no unresolved blocking issue.
- Work is committed and pushed, then reported as ready for production. No
  production deploy occurs without a new explicit approval.

## Implementation order

1. Write the new queue/atomicity/semantic integration tests and show they fail
   for the expected missing queue-placement behavior.
2. Add the backward-compatible placement-job migration/model and its claim,
   lease, merge, retry, completion, and bounded recovery operations.
3. Extract canonical placement planning from `placementRecompute` into
   `racePlacementTransitions` without changing behavior.
4. Implement set-based baseline/outbox/audience persistence with deterministic
   generation identities.
5. Integrate the constant-size current-generation handoff into the fenced v2
   score transaction and schedule placement claims in the existing resolution
   process.
6. Route normal score-driven production away from the five-minute scheduler;
   retain clock and bounded recovery responsibilities.
7. Update producer-matrix/structural guards and existing integration routing
   without weakening assertions.
8. Run focused suites, unit suite, full integration suite, and generated/
   structural checks.
9. Run the required code-reviewer pass and resolve every blocking finding.
10. Commit/push and hand off the exact production deployment scope for separate
   approval.

## Revision log

- Initial draft: mapped the current race-keyed merge/generation behavior,
  placement cron failure, queue-owned target path, set-based atomic persistence,
  scheduler decomposition, backward compatibility, and detailed integration
  matrix.
- Gap pass 1: corrected team baseline population to exact current semantics;
  added the existing team transition claim to rolling-deploy dedupe; required a
  canonical full-roster/fingerprint proof; pinned a stable generation
  occurrence time; and corrected the large-race assertion so intentionally
  silent baseline winners are not required to have events.
- Gap pass 2: removed placement fan-out from the core score transaction to
  preserve notification-domain isolation; added an additive coalescing
  placement-job table, constant-size atomic handoff, independent claim/fence/
  retry lifecycle, generation-stability checks, recovery/catch-up behavior,
  deploy ordering, and crash tests for both handoff boundaries.
- Architect review: fully specified enqueue/claim/reclaim/retry/success state
  transitions and constraints; excluded inert generation-zero rows; pinned
  generation-stamped team identity and transactional `JobRun` claims; separated
  planner, race models, domain-event bulk command, and injected orchestration;
  required claim+event atomicity for clock reminders; fixed guarded resolution-
  owner registration; and added newer-generation fencing plus bounded SQL-shape
  integration proofs. Also corrected durable payload parity for
  `totalParticipants`.
- Post-review gap pass 3: added stable processing observation timestamps,
  corrected requested-at behavior for succeeded/running rows, made the planner
  purely race-domain, and reconciled the summary/roster language with the
  independent durable placement worker.
- Post-review gap pass 4: fixed bounded page/query-shape requirements, made the
  catch-up resumable and explicitly bounded, documented one-row lifecycle and
  rollback behavior, and separated score-handoff versus placement-worker
  observability.
- Architect approval follow-up: no required issues remained; clarified null
  completion/retry claim semantics and required catch-up to exhaust all bounded
  pages before retiring the old cron producer.
