# Race bootstrap performance

## Summary and authorization

The user authorized TDD implementation of all five race-detail/bootstrap
optimizations. Opening a race must show the same data with less database work.
This is a backend-only optimization of existing behavior; no production deploy
is authorized by this implementation request.

## Scope and implementation

1. In compact eligible bootstrap responses, skip the details participant page
   which the route currently hydrates and then deletes. Eligibility must be
   decided from successful progress, capability, direct membership, active solo
   race and actual details paging. Error/fallback and older clients retain the
   existing participant array.
2. Replace full scalar participant-summary hydration in paged details and paged
   progress money context with one SQL aggregate result. Feed the existing money
   serializer explicit equivalent counts and final payout arrays; never change
   scoring, qualification, rounding, financial privacy, or settlement. Preserve
   participantUserIds (including declined members, in joinedAt/id order) for
   frozen invite consumers. That compatibility array still has O(N) output;
   deferring it would require a separate client protocol and is not silently
   performed here. Aggregate rows reduce transfer and duplicate reads; this
   does not make every aggregate scan O(1).
3. Use the worker-maintained race_participants scoring columns as the persisted
   standings projection. Add an exact expression index for the existing finish/
   placement/steps/join/user order, plus a transactionally maintained accepted
   count per race. Replace full-field window ranking/count with an indexed
   ordered page and rank assignment over that bounded page. Legacy OFFSET is
   retained: cost is O(offset + page size), rather than a full-field sort on
   every cold first-page read. Zero/empty/out-of-range pages preserve total and
   response semantics. Backfill counts once during an additive migration, and
   maintain counts on membership insert/delete/status/race changes, not on
   ordinary score updates. Existing workers remain compatible.
4. Coalesce DISPLAY_REFRESH requests durably using existing race queue ownership.
   An outstanding refresh may satisfy repeated reads only when the requested
   viewer's work is covered. Preserve new viewer scope and new source-input
   generations, lease fencing, retries, and failed-enqueue recovery. Public
   previews remain strictly read-only. Redis outage must not strand refreshes.
5. Reuse request-local race and viewer context across bootstrap access, progress,
   and details; reuse the same aggregate result for progress/details. Never
   cache access across requests or mistake a viewer-only roster for the full
   field. Maintain preview/spectator/bucket/forfeit access and graceful progress
   or inventory failure behavior.

## Files and API contract

Work centers on races/routes.js, queries/getRaceDetails.js,
queries/getRaceProgress.js, models/race.js, models/raceParticipant.js,
models/raceResolutionJobV2.js, services/enqueueRaceResolution.js and
racePrizePool.js. Add schema/migration support only for persisted count/index
maintenance as needed. All paths are relative to src/modules except migrations.

No new public endpoint, required parameter, response field, flag, or app build.
GET /races/:id/bootstrap keeps race-bootstrap-v1/race-bootstrap-compact-v1,
including progressError/inventory degradation. GET /races/:id/progress keeps
classic/compact/participants-v1 behavior. Details responses retain existing
arrays, pagination totals, membership fields, privacy and money metadata.
Existing 403/404 checks and powerup/step inputs remain authoritative.

## Frontend and compatibility

Both iOS and Android use the unchanged Dart HTTP consumers. No widgets or UI
placement change. Inspect the compact parser, invitation exclusions, paging and
legacy fallbacks to verify compatibility; frontend changes are unnecessary.
Do not require a new app version to get these backend improvements.

## Test-first plan and acceptance criteria

Real HTTP + dedicated local PostgreSQL. Write and run red tests before each
implementation. Test compact vs legacy response parity, page query elimination,
one shared aggregate/context per bootstrap, empty/large/paged fields, active and
completed/funded/legacy/team money parity, positive/zero-step forfeits, quick-race
qualification and payout stamps, denied/preview/spectator access, and error
fallbacks. Test cold progress ranking with ties/finishers/deep offsets plus real
EXPLAIN evidence that the first-page scan stays bounded as field size grows.
Test membership-counter insert/delete/status/move/rollback and migration backfill.
Test concurrent refreshes, new viewer/source scope, queued/running/failed states,
and repeat reads without queue-row churn. Existing assertions are protected.

Independent architect and money-equivalence review precede relevant changes;
independent code review follows implementation. Run relevant existing integration
suites, report pre-existing failures using unchanged-baseline evidence, and
document deployment migration cost and observed query reduction. Full scope
must be complete before calling this ready for production. Do not deploy yet.

## Revision log

Architect-required constraints incorporated before implementation:

- Count and page are selected in one SQL snapshot, including empty pages.
  Install count triggers/backfill atomically; moves lock both counters in
  ascending race-ID order. Preserve the separate privacy-rank ordering.
- Bypass/remove race-only Redis admission on the durable refresh path. Atomic
  checks include viewer scope, timezone, artifact identity and generation;
  running captured scope remains separate from pending dirty scope.
- Explicit promise-memoized core/viewer, aggregate and optional full-context
  loader slots validate race/viewer identity and completeness. Never use a
  viewer-only roster as an existing full-race preload. Progress rejection must
  not poison the details loader.

- Gap pass 1: retained full participantUserIds for frozen invitation clients;
  an aggregate output must not be advertised as constant-size end to end.
- Gap pass 2: retained OFFSET semantics explicitly; require bounded first-page
  plan evidence, and count updates must not serialize ordinary step-score writes.
  Refresh coalescing must preserve viewer work, not merely deduplicate race IDs.
