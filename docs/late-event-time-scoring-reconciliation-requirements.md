# Late Event-Time Scoring Reconciliation

## Status

Draft for architecture review. No production implementation is included in
this document change. Backend-only feature; no Flutter API or UI change is
required.

## Summary

When a newly received `StepSample` has event-time coverage inside an already
expired timed power-up window, the backend must repair only the newly admitted
race/user reconciliation intent. It must not scan old effects, replay old
races, or alter the existing immutable impact event. The repair recomputes the
affected timed attribution from authoritative samples using the canonical race
scorer, then applies the difference exactly once under the existing race fence.

The first release supports only:

`RUNNERS_HIGH`, `WRONG_TURN`, `LEG_CRAMP`, `QUICKSAND`, `RAINSTORM`,
`CAMPFIRE_REST`, `UPRISING`, `RALLY_FLAG`, `COIN_FLIP`, and `GHOST_PEPPER`.

It explicitly excludes Leech, Hitchhike, Drill Sergeant, Piggy Bank, Bounty,
Trail Mine, completed-race global 2×, recap correction, payout/reward reversal,
and historical backfill.

## User story

As a participant whose Health provider uploads a historical bucket after a
timed power-up expires, I want the race's historical timed-effect contribution
to converge to the score that the canonical scorer would have produced from
all authoritative buckets, without double crediting retries or changing old
records merely because this feature was deployed.

## Current repository constraints

Phase 1 already provides the source-change envelope, user scoring generation,
membership-first historical discovery, durable coalesced
`HistoricalRaceReconciliationIntent`, continuation, leases, retries, race
fencing, and maintenance priority:

- `src/modules/steps/services/stepInputIntake.js`
- `src/modules/steps/models/stepSample.js`
- `src/modules/steps/services/scoringInputVersion.js`
- `src/modules/races/services/historicalRaceDiscovery.js`
- `src/modules/races/models/historicalRaceReconciliationIntent.js`
- `src/modules/races/jobs/historicalRaceReconciliation.js`
- `src/modules/races/models/raceResolutionJobV2.js`

The canonical sampled modifier evaluator is
`src/modules/races/services/effectiveStepScoring.js`; canonical whole-race
totals are assembled by `src/modules/races/services/wholeRaceAttributionScoring.js`
and `src/modules/races/services/raceStateResolution.js`. Existing expiry and
settlement attribution paths are in `src/modules/powerups/commands/expireEffects.js`
and `src/modules/races/jobs/raceExpiry.js`.

`race_impact_events` and `race_effect_impacts` are immutable explanatory
artifacts. Phase 2 must never update or delete those rows.

## Scope and non-goals

### In scope

1. Consume only intents admitted after the Phase 2 deployment boundary.
2. Find supported timed effects in the intent's race/user scope whose persisted
   `[startsAt, expiresAt)` interval overlaps the changed event-time envelope.
3. Fetch the union of affected source windows once per bounded reconciliation.
4. Reuse canonical segment boundaries, bucket closure, proration, stacking,
   phase metadata, and integer attribution allocation.
5. Compute `expectedContribution - currentContribution` and persist the new
   current contribution idempotently.
6. Apply the signed difference to the participant's derived race score under
   the race fence, with generation revalidation before commit.
7. Keep correction work asynchronous, bounded, retryable, auditable, and
   horizontally safe.
8. Invalidate/publish only affected race projections after commit.

### Non-goals

- No startup scan, migration replay, periodic expired-effect scan, or backfill.
- No completed-race global 2× repair; active global 2× remains on its existing
  dynamic path.
- No recap correction; the current first-write-wins behavior remains unchanged.
- No Leech/Hitchhike, Drill Sergeant, Piggy Bank, Bounty, Trail Mine,
  payout/reward/economy, or notification redesign.
- No per-sample or per-effect queue jobs.
- No synchronous correction in `/steps/sync-v2`.
- No Health completeness watermark and no arbitrary lateness cutoff.

## Forward-only activation

No general release flag is proposed. The durable intent's `createdAt` is the
admission boundary: the Phase 2 worker consumes only queued intents created by
the Phase 1 source-change path after the Phase 2 deployment. A deployment
timestamp/config value is only needed if operational rollout requires workers
to reject pre-deployment intents; if used, it must be a server-side setting
declared in `KNOWN_FLAGS`, default to the deployment instant, and never trigger
creation of new work.

The worker must not query for effects without an intent. Existing intents from
before activation remain untouched and can be left queued/dry-run according to
the rollout decision. No migration changes historical scores.

## Data model

Additive expand-only schema is required. Exact names are subject to the
architect review, but the minimal durable model is:

### Current contribution projection

`HistoricalEffectContribution` (one row per `raceId`, recipient `userId`,
`effectId`, and attribution version):

- `id` UUID primary key
- `raceId`, `userId`, `effectId`, `powerupType`
- `currentDeltaSteps` signed integer
- `sourceGeneration` bigint
- `calculationVersion` integer
- `updatedAt`, `createdAt`
- unique `(raceId, userId, effectId, calculationVersion)`
- indexes for `(raceId,userId)` and `(effectId)`

This is rebuildable derived state, but it lives in Postgres because it is part
of settlement/scoring truth. It is not a Redis value.

Initialization for a pre-Phase-2 effect reads the matching immutable
`race_effect_impacts` row when present; absent means zero current contribution.
The original row remains untouched.

### Correction audit

`HistoricalEffectCorrection` records each successful logical transition:

- `id` UUID primary key
- `projectionId`, `raceId`, `userId`, `effectId`
- `fromDeltaSteps`, `toDeltaSteps`, `correctionDeltaSteps`
- `sourceGeneration`, `calculationVersion`
- deterministic `sourceRevision`/transition key
- `createdAt`
- unique `(projectionId, sourceGeneration, calculationVersion)` or an
  equivalent compare-and-set transition identity

Negative corrections are valid. The projection is the bounded read surface;
the audit is not summed on every leaderboard request. Compaction is out of
scope for the first release.

The architect must verify whether a single projection plus transition audit is
smaller and safer than appending correction rows to `race_impact_events`.

## Data flow and responsibilities

```text
StepSample.reconcileBatchOn
  -> changed event-time envelope + scoring generation
  -> existing Phase 1 race discovery/admission
  -> active race: RaceResolutionJobV2 dirty source metadata
  -> completed race: HistoricalRaceReconciliationIntent
  -> Phase 2 worker claims coalesced race/user intent
  -> load overlapping supported effects
  -> union effect windows and bulk-load StepSamples
  -> canonical scorer / attribution capture
  -> acquire race fence
  -> re-read source generation and projection
  -> correction/projection/participant write transaction
  -> post-commit cache invalidation and publication
```

Shared infrastructure remains in steps/races queue and observability modules.
Timed modifier recomputation remains separate from global-event recap and
terminal/economy consequences.

## Effect discovery and canonical recomputation

The worker receives `raceId`, `userId`, changed range, and requested source
generation from the intent. It queries `RaceActiveEffect` scoped by race and
target user, includes `EXPIRED` rows, restricts to the ten supported types,
and applies half-open overlap:

```text
effect.startsAt < changedEnd && effect.expiresAt > changedStart
```

Effects with mutated persisted boundaries (Pocket Watch, Quick Rinse, Cleanse,
or equivalent) use their stored timestamps and metadata; current default
durations are never reconstructed.

All selected effects are processed in chronological order. The worker must use
the existing sampled canonical path rather than reimplement formulas:

- `effectiveStepScoring.js` for signed segment multipliers and closed-bucket
  sums;
- `effectMultiplier.js` for boundaries and composition;
- `raceStateResolution.js` capture helpers for complete prefixes and integer
  allocation;
- `raceSettlementAttribution.js`/`wholeRaceAttributionScoring.js` where the
  authoritative race total and marginal attribution are required.

The worker fetches the union of required windows in one bounded sample read,
or uses the existing scorer prefetch interface to ensure no effect causes its
own StepSample query. It must preserve partial start/end proration, rainstorm
clamping, freeze phases, boost phases, persisted Coin Flip outcome, Ghost
Pepper phase boundaries, and overlapping-modifier semantics.

## Persistence and transaction protocol

Expensive effect/sample reads and canonical calculation occur outside the write
transaction. The worker then:

1. Begins a transaction and acquires the existing race write fence using the
   lease-token protocol.
2. Re-reads the user's current scoring generation.
3. If it differs from the claimed generation, does not commit the calculation;
   it merges/retains newer intent state and retries.
4. Reads the current contribution projection for selected effects.
5. For each selected effect, computes the signed difference from current to
   expected. A compare-and-set/upsert transition makes duplicate delivery a
   no-op.
6. Inserts audit transition rows and updates current projection rows in the
   same transaction.
7. Updates participant derived score/current standings fields using the signed
   net correction, never raw source fields.
8. Marks the claimed intent complete only if the generation still matches.
9. Commits.

Cache invalidation and race publication occur only after commit. They must be
scoped to affected race projections. Notifications are silent.

The implementation must prove that a crash after audit/projection write but
before queue acknowledgement, duplicate workers, downward source corrections,
and overlapping late batches all converge to the same projection and score.

## Active and completed races

Active races continue through `RaceResolutionJobV2`; Phase 2 repairs only
expired timed-effect attribution not already represented by the dynamic live
resolution. The worker must not double-apply portions covered by the current
race resolver.

Completed races use the existing historical intent worker and shared race
fence. Participant historical score/projection may change according to current
race policy, but payout/reward reversal is excluded. Placement changes must be
treated as a product decision and must not silently imply economy correction.

Cross-participant and terminal effects are not implemented in this phase. If a
selected effect is outside the ten supported types, the worker records a
bounded skip reason and leaves it unchanged.

## Idempotency and generation fencing

The correctness identity is the durable projection transition, not the queue
message ID. A repeated run with the same authoritative source generation has
zero delta. A later generation recomputes expected values from current source
rows and transitions the projection once. A source decrease can create a
negative correction. An older generation can never replace a newer one.

If generation advances while an intent is leased, the current Phase 1 merge
semantics must preserve the newer generation/range; the worker must requeue or
retry rather than acknowledge stale work as final.

## Metrics and diagnostics

Add bounded metrics only:

- `historical_effects_checked`
- `historical_effects_corrected`
- `historical_reconciliation_noop`
- `historical_reconciliation_generation_stale`
- `historical_source_rows_read`
- `correction_delta_steps_absolute`
- `historical_corrections_created`
- `historical_reconciliation_duration_ms`

Labels are limited to bounded status/type/result buckets; no user, race,
participant, effect, or event IDs. Existing Phase 1 admission metrics remain
unchanged.

## Tests-first acceptance plan

Backend integration tests use the safe `steps-tracker-integration_test` DB and
real service/worker paths. Required cases:

1. Runner's High: +8 baseline to authoritative +2,668, correction +2,660.
2. No-backfill: old stale effect with no new post-activation intent remains
   unchanged; deployment alone creates no work.
3. Retry/duplicate delivery is a zero-op after first correction.
4. Second late batch converges to the new total.
5. Downward StepSample update produces a negative correction.
6. Wrong Turn becomes more negative using canonical reversal.
7. Leg Cramp and Quicksand freeze all appropriate late steps.
8. Rainstorm applies 0.5× with canonical rounding/proration.
9. Campfire freeze and boost phases.
10. Uprising and Rally Flag including race-scope promotion where required.
11. Coin Flip win/loss uses persisted outcome; no reroll.
12. Ghost Pepper boost/freeze phases.
13. Partial effect-start/effect-end buckets.
14. Overlapping modifiers match canonical whole-race totals.
15. Stale-generation worker cannot commit.
16. Active race and completed race paths remain distinct.
17. Existing active global 2× anti-regression test remains 4,000.
18. Existing recap stale fixture remains unchanged.
19. Scoped cache invalidation and no notification emission.

Each test must assert raw StepSamples are not rewritten by reconciliation and
the immutable original impact row is unchanged.

## Performance acceptance criteria

- No synchronous historical correction in `/steps/sync-v2`.
- No per-effect or per-sample jobs.
- One bounded source read per race/user reconciliation, reusing unioned windows.
- Existing Phase 1 normal-sync query/write budget remains unchanged except for
  already-admitted asynchronous work.
- Worker source rows, selected effects, participants, and transaction duration
  have explicit caps and continuation/retry behavior.
- Benchmark 1/3/10 effects, 48 late buckets, five affected races, and overlap
  stacking before rollout; compare with Phase 1 measurements.

## Compatibility and rollout

This is backend-only and additive. Existing mobile binaries see no changed
request requirements or response contract. Deploy database expansion before
worker code; old workers must tolerate nullable/defaulted new columns and must
not read correction projections. Do not remove or repurpose existing impact
fields.

Rollout order:

1. Add tests/metrics and expand-only schema.
2. Deploy projection/audit models and disabled/no-op worker path that consumes
   only newly created eligible intents.
3. Enable Runner's High in a controlled server deployment after parity tests.
4. Add the remaining nine supported timed modifiers one family at a time with
   shared worker code and per-family integration coverage.
5. Observe retries, stale generations, correction magnitudes, and queue age.

No startup scan or migration replay is permitted. Rollback must stop the Phase
2 consumer while leaving additive rows and immutable originals intact; Phase 1
admission data remains durable for later retry.

## Open decisions requiring approval

1. Confirm whether `intent.createdAt` alone is the deployment boundary or a
   stamped server activation instant is required for mixed worker rollout.
2. Confirm completed-race product policy for score/placement changes without
   payout reversal.
3. Confirm the minimal projection/audit schema after architect review.
4. Confirm whether an effect with zero expected contribution needs a projection
   row for explicit initialization, or whether absence represents zero.
5. Confirm cache surfaces and publication contracts for completed-race score
   correction.

## Revision log

- Draft 1: repository-grounded scope, canonical scorer reuse, forward-only
  admission, projection/audit proposal, transaction/idempotency protocol, and
  test/performance gates.
- Gap pass 1: checked no-backfill boundary, immutable impact preservation,
  active/global-event exclusion, and Phase 1 worker handoff.
- Gap pass 2: checked canonical overlap/phase/stacking requirements, generation
  fencing, negative corrections, additive schema compatibility, and bounded
  worker behavior.
