# Race-resolution dependency closure requirements

## Summary

Replace the current all-or-nothing active-effect guard in the race-resolution
worker with a race-scoped dependency-closure planner. A normal step sync must
recompute only the syncing participant and the participants whose score can
actually change because of that sync. It must never alter scoring, ranking,
effects, boxes, payouts, notifications, or old-client API behavior.

The immediate production problem is visible in the current seeded races: the
Weekly Challenge has 396 accepted participants and active effects, and the
Daily Challenge has 385 accepted participants and active effects. Today,
`buildRaceResolutionStepSyncScope` rejects *any* race with an active effect and
the worker then calls the full scorer for every participant. This document
replaces that blunt guard; it does not make an unsafe partial calculation
acceptable.

## User story

As a participant in a large race, syncing my steps should update the people
whose scores truly depend on mine without making the entire application slow.
As a participant affected by a powerup, I must receive exactly the same score,
effect outcome, box outcome, feed event, and notification as the current full
resolver would produce.

## Scope

- Add one core backend service, `raceScoringDependencyClosure`, used by the
  v2 race-resolution worker before it selects a scoring plan.
- First release scope: `STEP_SYNC` jobs only. The service returns either a
  bounded dependency closure or `FULL`.
- Compute the closure from the canonical scoring-effect graph in the claimed
  race (including historical rows the scorer still consumes),
  including transitive dependencies.
- Replace the current `activeEffects.length > 0 => FULL` rule in
  `raceResolutionStepSyncScope`.
- Recompute and persist only closure participants when the closure is proven
  safe; preserve the current full resolver for every other case.
- Use the same service for future scoped resolver reasons. No second
  dependency implementation may be introduced in a route, powerup command, or
  cron.
- Add structured, aggregate-only observability for plan selection, closure
  size, fallback reason, and parity results. Never log user IDs, tokens, or
  raw step totals.

## Non-goals

- No client API or Flutter UI change.
- No change to drop odds, payouts, coin sources/sinks, scoring formulas,
  effect duration, rank tie behavior, notifications, or box timing.
- No partial handling for powerup casts in release one. `POWERUP_MUTATION`,
  `RACE_START`, join/leave/forfeit, effect/global-event boundaries, recovery,
  Daily Mover, and unknown metadata remain `FULL`.
- Do not split an existing large legacy Daily/Weekly race. Seeded buckets are
  a separate future-window mitigation, capped at 15 participants.
- Do not rely on a viewer opening a race to reconcile state.

**Staleness contract for non-closure participants (architecture review 3,
R11).** Under the closure, a participant who never uploads is refreshed only
by their own sync, any `FULL` job, or settlement — while their score remains
time-dependent through open-ended `ACTIVE` effects (`effectMultiplier.js`
treats a null `expiresAt` as `Infinity`) and through hourly buckets closing
(`leechTransfers.js`). The bounded convergence mechanism is
`findRecoveryRaceIds` (`raceResolutionJobV2.js`: limit 2 races per tick, 1h
stale window): worst-case persisted-total staleness for an idle participant in
a race under continuous closure traffic is ~1h plus recovery-queue delay. A
required test proves a race under continuous closure with no
`FULL`-triggering event still converges via recovery.

## Current behavior and root cause

`src/modules/races/jobs/raceResolutionQueueV2.js` currently selects `FULL`
for every dirty reason except `BOX_OPEN`. For a `STEP_SYNC` job it delegates to
`src/modules/races/services/raceResolutionStepSyncScope.js`, which permits the
lightweight `STEP_SYNC_COMMITTED` plan only if `findActiveForRace()` returns no
active effects. Any effect anywhere in the race therefore causes
`buildResolveRaceState()` (`src/modules/races/services/raceStateResolution.js`)
to read and calculate the full accepted field.

The full resolver is correct because Leech and Hitchhike are cross-participant
calculations: a target's walked steps affect one or more casters, and those
changes can be transitive. Trail Mine and other race-wide mechanics must also
see canonical full standings. The defect is not the safety fallback itself; it
is treating unrelated active effects as dependencies.

## Core service contract

Create `src/modules/races/services/raceScoringDependencyClosure.js` exporting:

```js
async function buildRaceScoringDependencyClosure({
  raceId,
  dirtyParticipantIds,
  job,
  now,
  Race,
  RaceActiveEffect,
  RaceParticipant,
})
// => {
//   plan: 'DEPENDENCY_CLOSURE' | 'FULL',
//   participantIds: string[],          // sorted, accepted, bounded
//   sourceParticipantIds: string[],    // sorted original STEP_SYNC rows
//   graphFingerprint: string | null,
//   asOf: Date,
//   fallbackReason: string | null,
// }
```

Rules:

1. The only candidate input is a known `STEP_SYNC` reason, with
   accepted dirty participant IDs and a coherent committed uploader snapshot.
   Missing, capped, malformed, stale, or unknown metadata returns `FULL`.
   **Merged-reason carve-out (gap pass 3, amended by architecture review 3):**
   a coalesced `STEP_SYNC + DISPLAY_REFRESH` envelope remains closure-eligible
   — the display generation is served by the fenced snapshot assembler this
   document already requires, never by a second scoring pass. Watched races
   enqueue `DISPLAY_REFRESH` on a ~15s snapshot-expiry cadence, so treating
   that merge as unknown would demote most big-race step syncs back to `FULL`.
   Every other reason mix stays `FULL`. Implementation constraints:
   - `buildRaceResolutionStepSyncScope` currently rejects any envelope with
     more than one reason (`raceResolutionStepSyncScope.js:8-11`); it must
     admit exactly the set `{STEP_SYNC, DISPLAY_REFRESH}` (order-independent)
     and nothing else. The existing `["STEP_SYNC","BOX_OPEN"]` red case in
     `test/services/raceResolutionStepSyncScope.test.js` must stay red.
   - Closure entry is gated on the reason **set**, never on
     `baseResolutionPlan === "FULL"` (`resolutionPlanForDirtyReasons` returns
     `FULL` for `RECOVERY`, `DAILY_MOVER`, `JOIN_LEAVE_KICK`, …).
   - Precedence when a job carries both a display artifact and a merged
     envelope: artifact attempt → on any artifact fallback reason, closure
     attempt → on closure rejection, `FULL`. The existing `forceFull` retry
     loop also disables the closure on its second pass.
   - The merge SQL NULLs `display_artifact_*` when a STEP_SYNC lands after a
     DISPLAY_REFRESH; that is the DESIRED outcome — do not "fix" it.
2. Load the accepted race participants and the canonical **scoring-effect
   history** in a bounded number of race-scoped queries. This includes the
   `ACTIVE` and `EXPIRED` rows that the canonical Leech/Hitchhike helpers read;
   “currently active” is not a sufficient graph. Preserve `joinedAt` order
   wherever current scoring/tie behavior consumes it.
3. Construct a directed graph from the canonical effect semantics, not from
   display labels. `raceScoringDependencyClosure` owns a checked-in,
   exhaustive row-per-`PowerupType` classification table. A structural test
   must fail if Prisma/catalog introduces a type without a row. Each row pins
   metadata/version validation, score class, edge direction, historical-status
   needs, earliest boundary, expiry/coin consequences, and fallback condition.
   The table may declare only:
   - `SELF`: the target's score depends only on their own source input;
   - `DEPENDENCY`: source/target score dependency edges;
   - `RACE_WIDE`: force `FULL`;
   - `UNSUPPORTED`: force `FULL`.
   At minimum, the v1 table must separately represent local scoring modifiers
   (`LEG_CRAMP`, `RUNNERS_HIGH`, `WRONG_TURN`, `CAMPFIRE_REST`, `RAINSTORM`,
   `QUICKSAND`), cross-score rows (`LEECH`; Hitchhike scoring v1 and v2), and
   non-scoring-but-boundary-sensitive rows (including `FANNY_PACK`,
   `DRILL_SERGEANT`, and `PIGGY_BANK`). Team/race-wide mechanics, unknown
   metadata, and every unsupported catalog row are `FULL` in v1.
   `isTeamRace === true` is an explicit `FULL` condition row, not an
   inference — the worker's team write logic (`retainTeamAsOfHeartbeat`,
   `buildTeamsBlock`) assumes a full field.

   **`TRAIL_MINE` — `CLOSURE_ELIGIBLE_WITH_ESCALATION` (not a veto;
   architecture review 3 delta).** An `ACTIVE` `TRAIL_MINE` row does not force
   `FULL`. Prod forensics (2026-08-14): mines live ~5.6h on the Weekly
   Challenge, so a hard veto makes the v1 production gate unachievable on the
   target race. Instead, the subset resolver evaluates `triggerTrailMines`'
   candidate predicate
   (`src/modules/races/services/raceStateResolution.js:551-566`) over a
   **full-field projection**: newly computed totals for closure participants,
   persisted `race_participants.total_steps` for every other accepted row,
   taken from the same fingerprint read
   (`raceResolutionInputFingerprint.js:27-42`) — no additional query. If the
   selected victim is a closure participant and no non-closure participant
   satisfies the predicate, the detonation proceeds inside the closure (its
   only writes are the victim's `bonusSteps`, the mine row, and one feed
   event — all inside the closure). If **any** non-closure participant
   qualifies as a candidate for any active mine, the generation escalates to
   `FULL` before the fence and no closure write occurs. The escalation is
   mandatory because `reconcileUploaderRaces`
   (`src/modules/steps/commands/recordSteps.js:193-211`) persists a syncing
   user's own total outside the worker, so a participant absent from this
   generation's dirty set can have crossed a mine threshold since the last
   full run; `candidates[0]` is the lowest-total crosser, so omitting them
   changes *which* player the mine hits and the mine then `EXPIRE`s.
   `TRAIL_MINE` is never `SCORING_INERT` (it reads every participant's
   total).

   **Scoring-inert rows are mandatory in v1 (gap pass 3, amended by
   architecture review 3).** Types the scorer never reads (`POWER_OUTAGE`,
   `SIGNAL_JAMMER`, `STEALTH_MODE`, `MIRROR`, `COMPRESSION_SOCKS`, `DECOY`,
   `DEFENSE_SCAN`, `QUICK_RINSE`, `CLEANSE`, …) carry an explicit
   `SCORING_INERT` classification: no dependency edge, no closure veto. A type
   may be classified `SCORING_INERT` only if it is absent from **all** of:
   `SETTLEMENT_EFFECT_TYPES`
   (`src/modules/races/services/raceScoringEffectTypes.js`), `{HITCHHIKE}`
   (read by `collectRaceHitchhikeCopies`,
   `src/modules/powerups/hitchhikeCopies.js:152`), `{TRAIL_MINE}` (read by
   `triggerTrailMines`,
   `src/modules/races/services/raceStateResolution.js:540`),
   `SNAPSHOT_AT_EXPIRY_TYPES` and `{DRILL_SERGEANT, FANNY_PACK, PIGGY_BANK}`
   (`src/modules/powerups/commands/expireEffects.js:14,63,76,89`). A
   structural test derives the inert set from those five source lists and
   fails if the checked-in table disagrees, and fails if any key of
   `POWERUP_SCOPE_BY_TYPE` is missing a row. The reverse implication is NOT
   asserted: a type outside `SETTLEMENT_EFFECT_TYPES` is not automatically
   inert. The table's key set is exactly `POWERUP_SCOPE_BY_TYPE`
   (`raceResolutionReasonRegistry.js`); classifications are derived from the
   source lists above, never hand-listed twice. `POCKET_WATCH` is inert
   **only because** it mutates other rows' `expiresAt` at cast time and every
   cast is `POWERUP_MUTATION` → `FULL`; that conditional rationale must be a
   comment on its row.

   **Inert types need no expiry veto**: `expireEffects` runs from the
   worker's post-commit hook for every admitted plan and reads its own due
   set race-wide, so inert expiry timing, ordering, and consequences are
   unchanged by plan selection. A due boundary forces `FULL` only when the
   expiry consumes data the closure did not compute — i.e. a due effect of a
   type in `SNAPSHOT_AT_EXPIRY_TYPES` or `DRILL_SERGEANT` whose
   `targetParticipantId` is NOT in the closure, because
   `expireEffects.js:56-59` and `:165` silently skip the `stepsAtExpiry`
   stamp / dare judgement on a missing key rather than failing loudly. That
   condition is evaluated at plan selection and re-evaluated before the
   post-commit handoff.
   Production evidence (2026-08-14): the Weekly Challenge saw 331 Power Outage
   casts in 24h (~30 min each) — overlapping coverage over the whole day — so a
   table that leaves `POWER_OUTAGE` unclassified or `RACE_WIDE` means the
   closure never fires on exactly the race this document exists for. The
   registry's existing `POWER_OUTAGE: "RACE_WIDE"` entry describes cast
   targeting, not scoring dependency, and must not be copied into this table.
   The scoring-relevant types the minimum list above omits (`UPRISING`,
   `RALLY_FLAG`, `COIN_FLIP`, `GHOST_PEPPER`, `UMBRELLA`) also need explicit
   rows: `UMBRELLA` is SELF (it adjusts only its holder's Rainstorm math);
   `UPRISING`/`RALLY_FLAG` team scope may be classified `RACE_WIDE`/
   `UNSUPPORTED` in v1.
4. Seed traversal with each dirty participant. Expand both incoming and
   outgoing dependency edges until fixed point. This catches multiple Leech
   sources, Hitchhike links, and chains such as an uploader feeding a target
   whose score feeds another caster.
5. `MAX_DEPENDENCY_CLOSURE_PARTICIPANTS` is **64** in v1. A closure is valid
   only if every scoring-effect row in its relevant graph component
   has an explicit safe classification. Any global event, Trail Mine, effect
   boundary due at/before the claim as-of instant, unresolved lifecycle state,
   frozen/forfeited edge case, or closure above the documented cap returns
   `FULL`.
6. The first implementation must classify Leech and both supported Hitchhike
   scoring versions from their existing authoritative metadata. It must use the
   same sources as `leechTransfers.js` and `hitchhikeCopies.js`. It must not
   infer dependencies from powerup type alone.
7. `graphFingerprint` IS the shipped
   `buildRaceResolutionInputFingerprint`
   (`src/modules/races/services/raceResolutionInputFingerprint.js`) — it
   already digests the race row, every participant row, every accepted
   member's `user_scoring_input_versions.generation`, active effects, global
   events, `nextSampleBoundary`, and `balanceConfigVersion` in four
   race-scoped queries, and is already used in the pre/post-bracket pattern
   with in-fence re-verification. A second fingerprint implementation is
   prohibited. Its one gap: it selects `status='active_effect'` only, while
   the closure graph needs `EXPIRED` `LEECH`/`HITCHHIKE` rows — bump the
   payload `schema` to 2 and include them (a schema bump harmlessly
   invalidates in-flight display artifacts: digest mismatch → `FULL`).
   The closure's exclusive validity deadline is the minimum over the boundary
   set produced by `multiplierBoundaries` semantics
   (`effectMultiplier.js` — including `startsAt+freezeMs` and
   `startsAt+boostMs` intra-effect transitions), the next closed-sample
   boundary, global-event edges, race `endsAt`, and the legacy Hitchhike
   top-of-hour; `computeArtifactReuseDeadline`'s `startsAt`/`expiresAt`-only
   enumeration is NOT sufficient. Every graph edge, accepted participant
   membership set, the relevant users'
   `user_scoring_input_versions.generation`, effect metadata/version, and the
   earliest relevant closed-sample, effect, and global-event time boundary
   contributes to `graphFingerprint` and its exclusive validity deadline. The
   canonical scoring read is bracketed by equal pre/post fingerprints (or uses
   one read-only repeatable-read snapshot); an internal mismatch abandons the
   closure before enqueue. The worker re-reads and verifies the fingerprint,
   membership, effect history, input generations, job generation, and deadline
   atomically under its existing fence before writing. A
   mismatch or elapsed deadline retries as `FULL`; it never writes a stale
   closure.
8. Leech is `DEPENDENCY` only when every affected active participant and every
   ordered leech transfer needed to resolve the connected component is present
   in the closure. Hitchhike is `DEPENDENCY` only when its exact stored scoring
   version and the target's required effect/sample inputs are supported. The
   service must otherwise return `FULL`; it may never approximate either
   transfer/copy from current displayed totals.
9. A Leech source that is frozen, no longer accepted, or absent from the active
   scoring entries is still an input to its victim's transfer: the full scorer
   drains the victim but drops the unavailable source's credit. The closure
   graph and fingerprint therefore retain that source's effect/sample/version
   input whenever it targets a closure participant; absence is not permission
   to omit the transfer.

## Resolver integration

1. Keep `raceResolutionStepSyncScope` as the committed-uploader input and box
   state validator. It may return a preliminary source scope only; it must not
   reject solely because the race has an active effect.
2. The worker calls `raceScoringDependencyClosure` after the source scope is
   validated and before `buildResolveRaceState` is constructed.
3. Add `DEPENDENCY_CLOSURE` as an internal plan name. It invokes a new,
   canonical subset-capable resolver entry point, not a copied scoring loop.
   That entry point consumes the full effect graph but calculates/persists only
   the sorted closure participants.
4. The subset resolver must reproduce the full resolver's Phase A base score,
   Hitchhike insertion, Leech transfer ordering, raw-step high-water mark,
   box-effective total, and frozen/forfeited semantics byte-for-byte for every
   closure participant.
5. If an operation requires complete standings—Trail Mine triggering,
   race-wide events, team computation, settlement, snapshot publishing that
   cannot be assembled from fenced persisted rows, or a new effect type—the
   worker uses the existing `FULL` path.
6. A closure result must include the same generation-time artifacts required by
   the post-commit path. `expireEffects` still receives the correct immutable
   base-adjusted values for any due effect targeting a closure participant;
   a due `SNAPSHOT_AT_EXPIRY_TYPES`/`DRILL_SERGEANT` effect targeting a
   NON-closure participant forces `FULL` (rule 3's narrowed veto). Snapshot
   publication must use a fenced persisted-row assembler that is
   byte-equivalent to the current snapshot, without a second score recompute.
   **Deferred out of v1 (architecture review 3, R8):** the earlier
   `race_participants.lastResolvedBaseAdjusted` / `lastResolvedBaseAt` /
   `lastResolvedInputGeneration` columns and their race-wide healing pass are
   NOT built in v1 — the narrowed veto above covers the only consumer that
   needs a base value for a non-closure participant, and requiring non-NULL
   on every roster row would keep the closure from ever firing until a
   whole-base fan-out completed. They return as a Phase 5 only if rollout
   evidence shows the narrowed veto fires too often; if built, the healing
   pass must be a `buildX`/`scheduleX` cron registered in `src/index.js`
   behind an env kill switch with `job_runs` insert-first dedup — never an
   ad-hoc loop, never an advisory lock, never derived from `raw_steps` (a
   high-water value, not equivalent — note the shipped `STEP_SYNC_COMMITTED`
   scope already uses `participant.rawSteps` as its base for dirty rows;
   that is grandfathered for the zero-effect case it serves, not endorsed
   for closure use).
7. The post-commit worker path must not reintroduce an N-participant scoring
   hydrate. It may process only source/closure users for box work and must
   retain current generation ordering, one-attempt delivery semantics, and
   durable intent claims. High-multiplier re-arm/alert behavior must remain
   exact — and the projection is pinned (architecture review 3, R9): **a
   `DEPENDENCY_CLOSURE` result carries the full accepted roster in
   `result.race.participants`; only `stepTotals`,
   `baseAdjustedByParticipantId`, and the captured writes are subset.**
   `runHighMultiplierAlert` already reads only
   `id`/`userId`/`status`/`finishedAt`/`forfeitedAt` off the roster with one
   `findActiveForRace` read and no score recompute; narrowing `result.race`
   would silently shrink alert recipients and re-arm coverage. It may not
   silently omit alerts or invent a later retry.
8. `DEPENDENCY_CLOSURE` is admitted to the existing `onCommitted` path. Its
   plan carries an exclusive post-commit deadline and the immutable fields
   required by expiry/alert/snapshot work. If a due effect or global boundary
   could cross between fence and post-commit handling, it selects `FULL`
   before writes; it must never skip `expireEffects`, box consequences,
   re-arm, snapshot, or one-attempt delivery just because the plan is scoped.
9. Existing race-keyed lease, fence, ascending participant lock order, and
   one-core-lane budget remain authoritative. The closure service cannot write
   race state itself.

## Data model and migrations

No persistent dependency graph is introduced in release one. Effect history is
read fresh. Add only the following additive state:

- ~~`race_participants.lastResolvedBaseAdjusted` / `lastResolvedBaseAt` /
  `lastResolvedInputGeneration`~~ — deferred out of v1 entirely (architecture
  review 3, R8; see resolver-integration item 6). No `race_participants`
  migration ships in release one.

- `race_resolution_jobs_v2` gets nullable processing graph fingerprint/as-of
  fields only if the existing processing metadata cannot safely carry them.
- If fields are added, old binaries ignore them, a missing value means `FULL`,
  and migration defaults are nullable/no-op.
- Do not store user IDs, effect payloads, device tokens, or raw steps in Redis
  artifacts or task payloads.

The implementation must first prove whether the existing job fence plus a
transactional effect-history re-read is sufficient. It must reuse the existing
scoring-input version table; it must not create a request-path bulk writer.

## API and compatibility

There is no new endpoint or response field. Existing app versions keep their
current requests and response JSON. The optimization is server-only and must
be invisible except for lower latency and fresher standings.

Seeded bucket clients remain capability-gated. A bucket is an ordinary race to
the closure service, so a 15-person bucket follows identical scoring rules.
Legacy clients remain in their legacy seeded race until a future eligible
window; no active race is moved or split.

## Rollout and rollback

1. Ship backend code and tests with `raceResolutionDependencyClosureV1Enabled`
   default false. Existing `raceResolutionReasonAwareV1Enabled` must not select
   closure behavior by itself.
2. Enable only in a disposable integration DB first, then staging with the
   worker limited to one core lane.
3. In production, enable the closure flag only after a fresh one-hour baseline
   of `FULL` reasons, CPU, queue lag, failed jobs, and p95 health latency.
4. Start with a small deterministic cohort of race IDs or an explicit bounded
   percentage; do not flip all resolver flags together. Expand only after the
   parity and operational gates below pass.
5. Rollback is one DB flag. It must send all jobs back to the existing full
   resolver without stranding a claimed job or changing API behavior.
6. Keep the bucket flag independent. Buckets mitigate field size; dependency
   closure mitigates cross-player scoring cost. Neither is a prerequisite for
   the other.
7. Capture SQLSTATE/operation-category (never SQL text, IDs, raw steps, or
   tokens) for resolver failures, including the earlier production `P2010`
   incidents, so a flag rollback has a diagnosable cause.

## Observability and success gates

Per resolved generation log only:

- plan (`FULL`, `STEP_SYNC_COMMITTED`, `DEPENDENCY_CLOSURE`);
- source count, closure count, full participant count;
- classified fallback reason;
- compute/write/post-task duration and queue lag;
- graph fingerprint match/mismatch aggregate.

Production gates for a 396-person legacy race over at least one hour:

- normal STEP_SYNCs with only a small Leech/Hitchhike component select
  `DEPENDENCY_CLOSURE`;
- graph/input reads are a bounded constant number of `O(N + E)` race-scoped
  scans (candidate plus mandatory fence); score
  computation and writes are `O(C)` where `C <= 64`, with no post-commit full
  score hydrate;
- no new resolver failures, stale writes, duplicate notifications, or missed
  expiry/box outcomes;
- p95 `/health` and race/open/powerup endpoint latency do not regress;
- CPU burst duration and queue lag improve versus the pre-rollout baseline.

## Implementation phases (architecture review 3)

All behind `raceResolutionDependencyClosureV1Enabled`, default false, declared
in `KNOWN_FLAGS` (`src/shared/config/appSettings.js`). Each phase is
independently landable and reviewable.

1. **Phase 1 — classification table + inertness proof.** Ship
   `src/modules/races/services/raceScoringDependencyClosure.js` exporting only
   the table and its classifier. No plan change, no flag read, zero production
   behavior change. Gate: the R1 structural test (inert set derived from the
   five source lists; every `POWERUP_SCOPE_BY_TYPE` key has a row; a fake
   `PowerupType` fails the suite; `HITCHHIKE`, `TRAIL_MINE`, every
   `SNAPSHOT_AT_EXPIRY_TYPES` member, `DRILL_SERGEANT`, `FANNY_PACK`,
   `PIGGY_BANK` are provably not inert).
2. **Phase 2 — planner in shadow mode.** Closure traversal (Leech/Hitchhike
   edges, transitive fixed point, 64 cap), fingerprint reuse (rule 7),
   `multiplierBoundaries` deadline, gatekeeper edits
   ({STEP_SYNC, DISPLAY_REFRESH} admission; artifact → closure → FULL
   precedence). The worker computes and logs the plan but still runs `FULL`.
   `TRAIL_MINE` is not in the veto set; the shadow log records `minesActive`
   and `wouldEscalateOnMine` so the escalation rate on the Weekly is measured
   before any write path exists. Gate: closure membership matches a
   brute-force full-graph oracle (Leech chains, both Hitchhike versions,
   frozen/absent sources); every veto selected correctly; staging shadow-log
   forensics.
3. **Phase 3 — subset resolver and fenced write.** `scoreParticipantIds`
   threaded into `processRace`'s Phase A loop (Phase A2 Hitchhike and Phase B
   `applyLeechTransfers` unchanged — never a second scorer file);
   `DEPENDENCY_CLOSURE` admitted to the write path and `onCommitted`; full
   roster retained per R9; the Trail-Mine full-field projection + escalation
   with its three required tests (byte-identical detonation; inline-reconcile
   crosser escalates with zero partial writes; in+out crosser pair escalates
   and the `FULL` rerun picks the lower-total victim). Gate: byte-parity
   matrix, mutation/fence tests, 10/100/350 `EXPLAIN` evidence,
   crash/lease/rollback tests; suite passes with `REDIS_URL` unset.
4. **Phase 4 — post-commit exactness + rollout.** Narrowed expiry veto wired
   at plan selection and pre-handoff; re-arm/alert, snapshot, one-attempt
   delivery parity; the R11 convergence test. Staging one core lane → bounded
   prod cohort, baselined only after the `ce77551` fix and the 30s debounce
   have been live a full hour.
5. **Phase 5 (contingent).** The deferred `race_participants` baseline columns
   and healing cron, only if Phase 4 evidence shows the narrowed veto firing
   too often.

## Test plan — tests first

Backend integration tests must use real HTTP and a disposable `*_test`
Postgres database. No production DB test writes.

1. Red test: one normal uploader in a race containing an unrelated SELF effect
   takes `DEPENDENCY_CLOSURE`, writes only that row, and matches the full
   resolver's persisted output.
2. Red test: Leech target sync recomputes the target and every leecher;
   multiple leechers and transitive chains match a full resolver exactly.
3. Red test: both Hitchhike scoring versions and a mixed Leech/Hitchhike graph
   produce the same totals, raw steps, boxes, and effect metadata as `FULL`.
   Include a frozen or absent Leech source: its victim is still drained while
   the unavailable source receives no credit.
4. Red test: Trail Mine, global event, due expiry, unknown effect type,
   effect graph mutation during compute, join/leave, and closure-cap overflow
   all fall back to full without partial writes.
5. Red test: concurrent uploader sync plus an effect creation/extension between
   graph read and fence rejects the closure and commits the current full state.
6. Red test: finished/forfeited participants and joinedAt raw-score ties remain
   identical to the full resolver.
7. Real-HTTP 10/100/350 participant matrix: candidate plus fence graph reads
   remain a bounded constant number of `O(N + E)` scans; score computation and
   affected writes remain `O(C)`; `FULL` controls retain current output.
8. Real-HTTP bucket matrix: a 15-person bucket and a legacy seeded race keep
   their current membership, payout, and client-capability behavior.
9. Worker crash/lease/reclaim and rollback-flag tests prove no generation is
   partially committed or stranded.
10. Red test: high-multiplier crossing and re-arm, due expiry, snapshot bytes,
    and one-attempt delivery behavior are identical for closure and full plans;
    the closure implementation does not perform an N-participant *score*
    computation after commit.
11. Red test: uploader-reconcile failure, stale/missing input generation,
    active sample-boundary crossing, and an effect/global-event boundary during
    the pre/post fingerprint window all choose `FULL`.
12. Red test: `ACTIVE` and `EXPIRED` Leech/Hitchhike rows are both included in
    the graph; a missed row, stale base-adjusted baseline, snapshot deadline,
    or post-commit deadline chooses `FULL` before any partial write.
13. Query-plan evidence proves the accepted-member and effect-history scans
    use race-scoped indexes, then demonstrates 10/100/350 participant races
    have a bounded constant number of graph scans and closure-proportional
    score writes.

## Acceptance criteria

- A single core service owns dependency classification and closure traversal.
- An unrelated active effect no longer forces a full recompute for a safe sync.
- Every closure participant exactly matches full-resolver output.
- Closure selection is bounded to 64 affected participants and never suppresses
  an existing alert, re-arm, expiry, snapshot, box, or delivery decision.
- Every unsafe/unknown condition selects `FULL` before writes.
- No API/UI/economy behavior differs for old or current clients.
- Flags default false and permit immediate rollback.
- Focused tests, full backend unit/integration suites, EXPLAIN/query evidence,
  and a code-reviewer verdict are complete before release.

## Frontend plan

No Flutter source, screen, payload, or placement change is required. iOS and
Android receive the same existing race data. The backend must remain safe if a
frozen client sends legacy step-sync requests or never declares bucket support.

## Revision log

- Draft 1: scoped release one to STEP_SYNC, preserved full fallback for all
  race-wide/unknown work, and made seeded buckets a complementary—not
  substitutive—mitigation.
- Gap pass 1: pinned the v1 closure cap (64), added coherent input/time fencing
  using existing scoring-input generations, and made Leech/Hitchhike closure
  eligibility depend on their authoritative transfer/copy semantics.
- Gap pass 2: required byte-equivalent snapshots and exact post-commit
  alert/re-arm/expiry behavior, prohibited a hidden second full scorer, and
  added failure diagnostics plus unsafe-boundary regression coverage.
- Game/economy review: required frozen/absent Leech sources to remain in the
  dependency fingerprint because they still drain their victim; confirmed no
  expected-value, source/sink, or exploit change when that parity rule holds.
- Architecture review: expanded the graph from active rows to canonical
  active/expired scoring history; required an exhaustive effect table, an
  atomic fixed-time fence, an additive exact-base snapshot baseline, and an
  executable post-commit deadline handoff. Revised the performance claim to
  bounded graph scans plus closure-proportional scoring/writes.
- Architecture re-review: added an atomically stored input-generation attestation
  for every persisted snapshot base, and made the metric honest about the
  candidate-plus-fence graph scans.
- Architecture review 3 (2026-08-14, delta on gap pass 3): corrected the
  structural test to a one-way implication derived from five source lists
  (the biconditional would have forced `HITCHHIKE` inert and deleted its
  edges); replaced the inert-expiry veto wording (expireEffects is
  plan-independent; only due `SNAPSHOT_AT_EXPIRY_TYPES`/`DRILL_SERGEANT`
  effects targeting non-closure participants force `FULL`); pinned
  `graphFingerprint` to the shipped `buildRaceResolutionInputFingerprint`
  (schema 2 adds EXPIRED LEECH/HITCHHIKE rows) and the validity deadline to
  `multiplierBoundaries` semantics; made the `{STEP_SYNC, DISPLAY_REFRESH}`
  admission, artifact→closure→FULL precedence, and reason-set gating
  explicit; deferred the `race_participants` baseline columns to a contingent
  Phase 5; pinned the full-roster projection for alerts/re-arm; made
  `isTeamRace` an explicit `FULL` row; added the non-closure staleness
  contract (recovery backstop, ~1h worst case); and replaced the Trail Mine
  hard veto with `CLOSURE_ELIGIBLE_WITH_ESCALATION` after prod forensics
  showed ~5.6h mine lifetimes on the Weekly (the original closure-scoped rule
  was rejected as unsafe: `reconcileUploaderRaces` advances non-closure
  totals outside the worker, changing victim selection). Measured
  non-binding: global events (~2% coverage, 30-min events), team buffs
  (target races are non-team).
- Gap pass 3 (2026-08-14, production forensics): mandated explicit
  `SCORING_INERT` rows keyed off `SETTLEMENT_EFFECT_TYPES` (Power Outage alone
  covered the Weekly Challenge ~24/7 — 331 casts/day — and would otherwise veto
  every closure), admitted `STEP_SYNC + DISPLAY_REFRESH` merged envelopes via
  the snapshot assembler, and recorded the shipped prerequisite: the
  `skipRaceResolution` backstop enqueue in `recordSteps.js` used to stamp a
  null reason that normalized to a sticky `FULL`/`IMMEDIATE` envelope,
  poisoning ~79% of big-race jobs before plan selection (fixed separately).
  Note the closure success gates must be measured only after that fix and the
  `RACE_RESOLVE_DEBOUNCE_MS` cadence change are live, or the baseline is
  dominated by the poisoning artifact.
