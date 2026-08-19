# Race-resolution queue resource optimization requirements

Status: Draft for approval
Date: 2026-08-19

## Summary

Reduce CPU time, database round trips, and queue delay in the v2 race-resolution
pipeline without changing scoring, delivery, box, effect, payout, or client API
behavior. The work addresses four measured costs: repeated overtake-nudge roster
reads, full-field scoring for step syncs with active effects, durable post-task
handoff round trips, and queue generations created from unchanged scoring input.

This is an optimization of existing behavior, not a new product feature. It is
backend-only, independently reversible, and must continue to serve every shipped
app version without an app release.

## Production evidence

The decision baseline is the 88-minute production observation from
2026-08-19T04:30:49Z through 05:59:00Z after commit `0db673a` was loaded. It
contains the deliberate 60-second restart quiet period and catch-up burst. A
second slice starts after the backlog first drained at approximately 04:38Z.

- 1,523 generations completed: 1,483 ordinary commits, 40 superseded commits,
  zero failed/fence-lost resolutions. Plans were 877 FULL, 623
  STEP_SYNC_COMMITTED, and 23 ARTIFACT_REUSE.
- 1,218/1,523 (80.0%) changed no participant row. All 623
  STEP_SYNC_COMMITTED jobs and 578/877 (65.9%) FULL jobs were zero-write. In the
  post-drain slice, 1,028/1,270 (80.9%) were zero-write.
- Active effects rejected the cheap STEP_SYNC scope 698 times—79.6% of all FULL
  jobs. Their active-effect count was p50 3, p95 16, max 18.
- FULL compute totaled 172.5 seconds. Scoring prefetch consumed 90.7 seconds
  (52.6%), participant scoring 35.4 seconds (20.5%), race loading 24.1 seconds
  (14.0%), and active-effect processing 11.5 seconds (6.7%). Leech, Hitchhike,
  and Trail Mine arithmetic together consumed under 0.34 seconds.
- The 147 FULL jobs with 101+ participants were only 16.8% of FULL volume but
  consumed 92.4/172.5 seconds (53.6%) of all FULL compute; their compute p50 was
  587 ms and p95 1,015 ms.
- Overtake nudges consumed 33.85 seconds. The accepted-participant read consumed
  33.51 seconds (99.0%); ranking consumed 0.25 seconds and intent handoff 0.005
  seconds. Only 131/1,523 jobs had multiple triggering users, so projection reuse
  is the larger win than batching alone.
- Durable handoff consumed 54.2 seconds: 36.9 seconds in its task transaction
  and 17.2 seconds in runner readiness. Every job executed `taskUpdate`, while
  only 19/1,523 (1.25%) inserted any delivery intent.
- The 88 one-minute queue probes had p50 15.4 seconds, p95 28.9 seconds, max
  97.9 seconds, and four alarms above 30 seconds. The terminal state had three
  queued rows, all still deliberately debounced, zero claimable rows, and zero
  FAILED rows. This confirms the current age metric is not a claimable-backlog
  metric.
- Public app/Redis health stayed green and both production PIDs stayed online.
  There was one recoverable post-task runner `P2028` transaction-start timeout;
  the durable queue subsequently drained it and no task/job remained failed.

The last point is not permission to skip worker behavior based on `changedRows`.
Snapshots, effect expiry, delivery decisions, boxes, and boundary work may still
be required. No-op suppression must happen only where unchanged canonical input
is proven before enqueue, or where an existing hydrated value can be safely
reused.

## User story

As a participant, my step sync and race screen should converge quickly even when
large races are active. Scores, effects, boxes, notifications, and payouts must
remain exactly as they are today.

As an operator, I want the queue to spend resources only on distinct required
work, expose claimable backlog separately from intentional debounce time, and
retain one-switch rollback for each optimization.

## Scope

### 1. Batch overtake-nudge evaluation

- Replace the worker's per-trigger-user call pattern with one race-level nudge
  evaluation for all distinct triggering users in the claimed generation.
- Add `lastNotifiedPlacement` to the internal lean resolution participant
  projection. The hydrated roster is pre-compute, so build committed nudge
  standings by filtering it to ACCEPTED participants and replaying the
  generation's captured `participantTotal` and `participantBonus` writes in
  their committed order. Preserve stable `joinedAt` ordering and current tie
  behavior before ranking. This adds no public response field.
- If an older display artifact or any projection lacks a required scalar, or a
  captured write cannot be applied unambiguously, perform one
  `findAcceptedByRace` fallback read for the generation.
- Sort once, index current and prior placement once, and derive the union of
  overtaken recipients for all trigger users.
- Preserve all current exclusions, one-hour recipient throttling, deterministic
  ordering, and durable STEP_SYNC intent claim semantics.
- A missing field or inconsistent projection must fall back to the current
  single roster read, never to a guessed recipient list.

### 2. Stop unrelated active effects from forcing full scoring

- Continue the existing `raceScoringDependencyClosure` implementation; do not
  introduce a second dependency graph or scoring implementation.
- Scope `prefetchRaceScoringModels` to the proven closure, not the full roster.
  Prefetch inputs are the closure participants plus any unavailable/frozen or
  cross-effect source inputs the planner marks as required. Keep the full lean
  roster only for snapshot, alert, standings, and nudge semantics. Missing
  planner input metadata falls back to FULL.
- Close the documented Phase 4 expiry gap without a timing heuristic: include
  the target of every active `SNAPSHOT_AT_EXPIRY_TYPES` or `DRILL_SERGEANT`
  effect in the closure regardless of its current expiry distance. If that
  expansion exceeds the closure cap or cannot be classified, select FULL before
  writes. Post-commit expiry then always has the computed target value it may
  consume; the 30-second slack is not a correctness proof.
- Global events use generation-as-of semantics. The fence re-reads the global
  event fingerprint using database time immediately before writes. An active
  event, a crossed `validUntil`, a missing durable boundary schedule, or any
  mismatch selects FULL before subset writes. A future boundary retains its
  existing durable `GLOBAL_EVENT_BOUNDARY` FULL generation; post-task
  supersession must prevent an older closure snapshot from publishing after the
  newer generation is visible.
- First enable the existing shadow planner only and measure closure selection,
  fallback reasons, closure size, Trail Mine escalation, planner time, and fence
  rejection on production-shaped traffic.
- Enable `raceResolutionDependencyClosureV1Enabled` only through a bounded,
  independently reversible rollout after shadow evidence passes. Every unknown,
  incoherent, oversized, team-race, race-wide, boundary-sensitive, or failed
  planner case remains `FULL`.
- Keep the canonical full resolver as the fallback. No scoring formula, effect
  classification, rank tie rule, or post-commit consequence may change.

Why full scoring happens today: `STEP_SYNC_COMMITTED` is accepted only when the
claimed uploader snapshot is coherent and there are zero active effects. Any
active effect rejects that shortcut because Leech, Hitchhike, Trail Mines,
expiries, and race/global modifiers can make one participant's input affect
other participants. The full resolver is the correctness fallback; the existing
dependency-closure path is the safe way to prove which smaller set is sufficient.

### 3. Reduce durable post-task handoff round trips

- Preserve the durable owner insert before any cooldown/cap claim. Generation
  dedupe and at-most-once/ambiguous delivery semantics are non-negotiable.
- Always put the final snapshot command and its accurate snapshot payload bytes
  in the ownership insert. Resolve any cooldown/cap claims only after that
  insert wins. If they resolve to zero intents, omit the now-redundant task
  update; do not infer that a non-empty unresolved claim list will resolve empty
  before the durable owner exists.
- For tasks with one or more resolved intents, retain the winning owner insert,
  then combine the task finalization and bulk intent insertion into one database
  round trip where the transaction and ownership rules allow it.
- Cache positive runner readiness for at most one second in the shared runner
  instance used by handoff, `tick()`, and `processTaskId()`. A failed scheduler
  claim/tick invalidates that same cache. A negative or failed readiness check
  is never cached and still takes the existing inline-claim safety path.
- Keep duplicate-generation probing and ambiguous-commit handling unchanged.

### 4. Suppress proven no-op scoring input generations

- Make daily-step and sample persistence report whether canonical scoring input
  actually changed. Canonically equivalent re-uploads still update
  `lastStepSyncAt`/home-pull bookkeeping, emit the existing command event,
  perform existing cache invalidation, and return the same API response, but do
  not advance the scoring-input generation.
- Normalize samples first and compare the canonical reconciled set, not raw
  payload byte order. Track storage changes separately from scoring changes:
  metadata-only differences are still persisted, but only a difference in the
  scoring-consumed tuple (period start, period end, and step count) advances the
  scoring-input generation. Do not enqueue STEP_SYNC when both the daily total
  and canonical scoring sample set are unchanged.
- Tuple equality is boundary-aware. Add a nullable scoring watermark and
  next-sample-boundary timestamp to the Postgres
  `user_scoring_input_versions` row. Suppress only when the watermark exists,
  database time has not crossed the stored next boundary, and the canonical
  scoring tuple is unchanged. A crossed future `periodEnd`, missing watermark,
  clock uncertainty, or comparison failure is a scoring change and must
  bump/enqueue.
- In sync-v2, advance `user_scoring_input_versions` exactly once per transaction
  when either canonical input changed; do not retain the current redundant bump
  after a sample write has already advanced it.
- Preserve enqueue for any uncertain comparison or failed reconciliation. Fail
  closed toward today's work rather than risk stale race state.
- Persist nullable `scoringChanged` on the sync-v2 reservation in Transaction A
  and consume that exact decision in Transaction B and expired-lease recovery.
  Missing state on an old or in-flight reservation means enqueue. Recovery must
  not reclassify already-persisted input as unchanged and suppress work that
  never reached Transaction B.
- Do not suppress `DISPLAY_REFRESH`, `EFFECT_BOUNDARY`,
  `GLOBAL_EVENT_BOUNDARY`, `POWERUP_MUTATION`, recovery, settlement, or any
  other non-STEP_SYNC reason merely because a previous resolution wrote zero
  participant rows.
- Do not use `changedRows === 0` as a worker short circuit. That signal is known
  only after required computation and does not prove post-commit work is inert.

### 5. Queue observability and capacity guard

- Report intentional debounce separately from claimable service lag. Keep the
  oldest-request-age metric for continuity, and add aggregate claimable count,
  oldest claimable age, running count, and work-lane occupancy.
- Define claimable with the exact `claimNext` predicate: a QUEUED row whose
  retry/debounce deadlines are due, or a RUNNING row with an expired lease. Use
  the existing state/deadline indexes, keep the aggregate probe at the current
  once-per-minute cadence, and do not add a hot-path table scan.
- Work-lane occupancy is process-local diagnostic state, not durable queue
  truth. It is logged from `raceResolutionWorkBudget` and never read to make a
  cross-process ownership or correctness decision.
- Compare restart catch-up separately from steady state in rollout decisions.
- Do not raise concurrency as the first remedy. Reconsider the cap only if
  claimable lag remains high after the four work reductions and database/API
  latency remains healthy under existing regression/load checks.

## Runtime controls and implementation ownership

- `raceResolutionNudgeBatchV1Enabled` controls only race-level nudge batching.
- `raceResolutionPostTaskFastHandoffV1Enabled` controls only the complete-first
  insert/finalization and bounded readiness cache.
- `raceResolutionNoopInputSuppressionV1Enabled` controls only proven unchanged
  daily/sample input suppression across both legacy and sync-v2 command paths.
- `raceResolutionDependencyClosureShadowV1Enabled` and
  `raceResolutionDependencyClosureV1Enabled` retain their existing independent
  meanings. Neither may be reused for another optimization. Add a separate
  `raceResolutionDependencyClosureV1Percent` (0 by default) and use a stable
  race-id hash for the write cohort; the boolean remains the master kill switch.

Expected implementation surfaces are the queue worker, `recordSteps` nudge
helper, post-task model/handoff/runner, canonical Steps/StepSample persistence,
sync-v2 and legacy recording commands, app settings, and aggregate metrics. The
public routes and serializers remain unchanged.

All durable jobs, post-tasks, suppression watermarks/digests, reservations, and
scoring truth remain in Postgres. Redis remains derived snapshot/cache storage;
it is not a queue, lock, lease, suppression authority, or correctness source.

## Non-goals

- No Flutter, iOS, Android, UI, endpoint, request, or response change.
- No scoring, odds, economy, payout, effect-duration, rank, box, push, or
  notification behavior change.
- No removal of the full resolver or its fail-closed fallback cases.
- No active-race migration, race splitting, or participant-cap change.
- No optimization based solely on a post-hoc zero-row-write observation.
- No production test traffic and no integration suite against production data.

## API and backward compatibility

There is no API contract change. Frozen app binaries continue sending the same
payloads and receive the same JSON. All new runtime switches default off;
missing settings retain current behavior. Rollout order is backend-only and each
optimization can be disabled independently without stranding a claimed queue
generation or a durable post-task.

For an unchanged sync-v2 request, Transaction B returns the existing response
shape without advancing a generation: it reports the stable first active race's
existing job ID/generation/requestedAt and retains the compatibility state
`QUEUED`. If any active race has no durable job, enqueue normally instead of
returning an owner that does not exist. With no active races, preserve today's
null jobId/generation response. Frozen clients can therefore poll the existing
generation exactly as they do today.

No migration is expected for nudge batching, closure exactness, or handoff
round-trip reduction. No-op suppression requires additive nullable scoring
watermark/next-boundary columns on `user_scoring_input_versions` and nullable
`scoringChanged` reservation state. Old writers remain valid; every absent value
means "perform current work." Migrations must not rewrite existing rows.

## Relationship to existing requirements

`docs/race-resolution-dependency-closure-requirements.md` remains authoritative
for closure graph semantics, fencing, and fail-closed classifications. This
document supersedes its heuristic Phase 4 expiry timing mechanism and is
authoritative for closure-scoped prefetch, exact boundary handling, combined
optimization order, runtime controls, production gates, and the user's explicit
no-new-tests constraint. Any older instruction to author additional closure
tests is not part of this optimization; existing closure suites remain protected
regression guards and must pass unchanged.

## Implementation order

1. Land the aggregate queue/claimable-lag metrics and keep all behavior flags
   off so rollout comparisons are interpretable.
2. Batch the nudge roster work and deploy behind its own default-off flag.
3. Reduce post-task handoff round trips behind a separate default-off flag.
4. Add proven no-op input detection at the canonical persistence seams and
   enable both legacy and sync-v2 paths together behind the same switch.
5. Finish dependency-closure expiry/global-boundary exactness and closure-scoped
   scoring prefetch, run the existing shadow planner in production, then roll
   out subset writes separately.
6. Re-measure before considering any worker-concurrency increase.

## Verification constraint — no new tests

Per the user's explicit direction, this optimization will not add, rewrite, or
delete test files. Implementation verification is limited to running the
existing relevant unit/integration suites as regression guards, with every
integration run pointed at the dedicated local/test Postgres database, plus
syntax/static checks and production canary metrics. Existing assertions may not
be weakened or skipped.

This is a deliberate project-specific exception to the repository's usual
tests-first rule. If existing coverage exposes a regression, the implementation
must be fixed; the test must not be changed to accommodate it.

The unchanged regression set includes the existing nudge command tests; v2
queue, write-fence, step-sync-scope, artifact, and dependency-closure suites;
post-task model/handoff/runner and delivery-intent suites; legacy step/sample
command suites; sync-v2 HTTP/unit coverage; and the existing integration suites
for sync-v2 and resolution locking. Run them through `npm run test:unit` and
`npm run test:integration` only after confirming the latter points at the
dedicated local `steps-tracker-integration_test` database. Never run bare
`npm test` and never point either command at production.

## Rollout and rollback

- One default-off server flag per optimization; do not flip them together.
- Establish a fresh baseline with the new claimable-lag dimensions.
- Enable nudge batching first, then post-task handoff, then no-op suppression.
  Observe each independently for at least one normal production traffic window.
- Run dependency closure in shadow mode before subset writes. With the boolean
  write switch on, expand the stable race-hash cohort through 1%, 5%, 25%, 50%,
  and 100%, holding each stage for at least one hour of normal traffic. A
  time-bounded explicit race allowlist may precede 1%. Advance only after
  fallback, expiry, prefetch, planner-overhead, and operational evidence is
  clean.
- Roll back the single flag at the first increase in resolver failures,
  fence loss, delivery ambiguity, snapshot failures, queue lag, or API health
  latency. Already-owned durable tasks continue through the existing runner.

## Acceptance criteria

- One accepted-roster read and one rank construction at most per resolved race
  generation, regardless of triggering-user count.
- No new nudge recipient, duplicate recipient, cooldown, or delivery behavior.
- Eligible active-effect STEP_SYNC traffic can select a bounded dependency
  closure; every unproven case selects `FULL` before writes. Closure prefetch
  reads scoring input only for the proven input set, while the full lean roster
  remains available for non-scoring post-commit semantics.
- No-intent post-task creation no longer performs an unconditional task update;
  positive runner readiness does not require one external probe per task.
- A canonically equivalent step/sample re-upload creates no STEP_SYNC generation
  while preserving response and sync-bookkeeping behavior. A crossed sample
  boundary, missing watermark/reservation decision, or recovery uncertainty
  always enqueues.
- Existing non-STEP_SYNC convergence work is never suppressed by zero changed
  participant rows.
- Existing relevant regression suites pass without test-file modifications.
- Production shows no new failed/fence-lost jobs, post-task errors, delivery
  ambiguity, health regressions, or sustained claimable backlog.
- CPU time, database time, and steady-state queue lag improve against the
  recorded 2026-08-19 baseline. Specifically: normal non-artifact plans reduce
  external nudge roster reads to zero and aggregate nudge participant-load time
  by at least 90%; zero-intent tasks eliminate `taskUpdate` (baseline 98.75% of
  tasks); closure-selected 101+ participant jobs reduce both matched FULL
  scoring-prefetch time and total compute by at least 50%; planner plus
  fingerprint overhead stays below 25% of the avoided matched FULL prefetch
  time; and the new claimable-lag p95 remains below five seconds without raising
  worker concurrency.

## Revision log

- 2026-08-19 — Initial draft after code-path exploration. Kept zero-row-write
  handling fail-closed and reused the existing dependency-closure design rather
  than proposing a duplicate scorer.
- 2026-08-19 — Fresh-eyes gap pass 1 (correctness and rollback): made the
  no-intent fast path depend on the known empty claim list, bounded and
  invalidated runner-readiness caching, named independent runtime switches, and
  identified implementation ownership without changing public routes.
- 2026-08-19 — Fresh-eyes gap pass 2 (version skew and hidden side effects):
  preserved bookkeeping/events/cache invalidation on equivalent uploads,
  changed sample equality to canonical-set equality, required one scoring-input
  generation bump per changed sync-v2 transaction, and resolved the verification
  conflict with the older dependency-closure document in favor of the user's
  explicit no-new-tests direction.
- 2026-08-19 — Evidence refinement: preserved insert-before-claim ownership but
  made the first insert carry accurate snapshot bytes, allowing the task update
  to disappear whenever post-ownership claim resolution produces no intents.
- 2026-08-19 — Replaced preliminary evidence with the exact 88-minute production
  window and post-drain slice; set measurable rollout targets from the observed
  nudge, handoff, large-race compute, and claimable-backlog costs.
- 2026-08-19 — Architecture review: required committed-write replay before
  nudge ranking, closure-scoped prefetch, exact expiry/global-boundary rules,
  time-boundary-aware no-op suppression, crash-safe sync-v2 reservation/response
  semantics, Postgres-only correctness state, exact claimability, a deterministic
  percentage rollout, and separate planner/prefetch gates. All required changes
  were incorporated.
