# Weekly race-detail projection optimization

## Summary & user story

Optimize the weekly race detail page for races with up to 500 participants.
The backend must retain full-field ranking correctness while avoiding repeated
full participant/user/cosmetic hydration and repeated cold scoring replays.

## Scope

In scope: existing `GET /races/:raceId/progress` and capable-client
`GET /races/:raceId/bootstrap`; the existing Redis standings snapshot; lean
participant/detail projections. Out of scope: scoring-rule changes, frontend
changes, new release flags, and migrations unless an additive index is proven
necessary.

## Design and compatibility

Full-field scoring remains necessary for authoritative placement, ties, teams,
effects, and viewer placement. Capable paging requests use the existing lean
scoring projection, then hydrate only the requested page plus the viewer for
presentation. Bootstrap reuses that lean context and does not preload the fat
participant graph. Legacy clients that omit the paging capability continue to
receive the existing complete participant response.

The worker and request path must publish/read the same lean snapshot schema.
Redis remains fail-open; Postgres remains the correctness fallback. No endpoint,
required parameter, or response field is removed or renamed.

## Implementation path

Use `findProgressScoringContext` for worker snapshot publication, mark the
projection with the existing non-enumerable `_leanProgressProjection` marker,
and therefore publish `LEAN_SCHEMA_VERSION`. Keep `findById` as the fallback
for older injected/model implementations. Preserve the existing allowlist and
viewer-specific overlay.

## Tests and acceptance

- worker snapshots use the lean model method and lean schema version;
- existing persisted/progress/bootstrap parity suites remain green;
- capable requests preserve full-field ranking while bounding presentation
  hydration to the requested page plus viewer;
- Redis-down and legacy-client behavior remain unchanged;
- syntax, focused tests, regression checks, and code review pass before a
  separate production-deploy approval.

## Revision log

- Draft: scoped to the observed weekly progress/bootstrap bottleneck.
- Gap pass 1: preserved legacy clients, Redis-down fallback, and viewer
  isolation.
- Gap pass 2: added worker schema compatibility and bootstrap reuse requirements.

