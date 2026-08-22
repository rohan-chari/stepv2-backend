# Weekly Race Page-Scoped Projection Requirements

## Summary & user story

When a user opens an active weekly race, the API should load only the requested
participant page (normally 15 rows) on the request path. A 500-participant race
must not synchronously replay or hydrate all 500 participants just to return
the first page. The response must retain exact ordering, placements, viewer
overlays, active effects, and existing client compatibility.

## Scope / non-goals

In scope: `GET /races/:uuid/progress` and the compact bootstrap path for active,
non-team races using `view=participants-v1&offset&limit`, the persisted page
projection, and the resolution-worker publication path that keeps page reads
authoritative.

Out of scope: finished-race result pagination, team-race layout, message
streams, scoring-rule changes, mobile UI changes, and any release flag.

## Current behavior and proposed design

The current request path can read a lean snapshot, but a cold/expired snapshot
still rebuilds a race-wide standings snapshot before slicing `participants`.
The proposed design separates authoritative ranking from page serialization:

1. The resolution worker publishes a compact race-wide ranking index containing
   each accepted participant's stable identifiers, effective total, placement,
   finish/forfeit state, and the shared race metadata. This is the authoritative
   source for ordering and viewer placement; it is refreshed by the existing
   race-resolution path, not by a page GET.
2. A paged GET reads only the requested ranking-index slice plus the requester
   row (if outside the slice), then hydrates presentation and active-effect data
   only for those rows. It uses a bounded SQL/Redis read and never runs a full
   scoring replay on the request path.
3. If the index is missing or too old, the GET serves the persisted page-safe
   fallback and schedules/retains a worker refresh. It must not synchronously
   calculate all participants. The response identifies pagination totals from
   the index/fallback count and preserves the existing response contract.
4. Legacy callers without `participants-v1` continue through the current full
   response path. Existing app versions therefore see no contract removal.

The implementation must not pretend that page-scoping makes ranking cheaper by
itself: exact rank still requires an authoritative race-wide index. The
optimization is moving that work off the request path and limiting request-path
hydration/serialization to the visible page.

## API contract and compatibility

No required request parameters or existing fields are removed or repurposed.
The existing `participants-v1` response retains `participants`, `pagination`,
race metadata, viewer-specific overlays, and active-effect fields. Missing new
internal cache data falls back safely to persisted columns. Legacy full reads
remain unchanged. The backend is deployed before any optional client change;
no client change is required for this optimization.

For active solo races, `pagination.total`, `offset`, `limit`, `hasMore`, and
`nextOffset` remain exact when the ranking index is available. On a cold cache,
the fallback may return a conservative count but must not return an incorrect
participant ordering; if exact ordering cannot be proven, it serves the
existing safe fallback and schedules refresh rather than returning a fabricated
page.

## Data model / migrations

Prefer Redis/persisted projection storage already used by
`raceProgressSnapshot`; do not add a relational migration unless profiling
proves Redis plus existing indexed participant columns cannot support the
projection. Any new snapshot schema is additive/versioned and readers accept
missing optional fields. No seed or destructive data operation is allowed.

## Frontend plan

No frontend code is required. Existing clients continue sending the current
pagination request and defensively consume the same response. iOS and Android
must both be smoke-tested because they share the endpoint but may differ in
capability headers.

## Downsides and mitigations

- A cold page can be briefly stale while the worker refreshes the index; show
  the last safe page and converge asynchronously rather than blocking all
  users on a 500-person replay.
- An index refresh must be atomic/versioned, or an old page could be paired
  with a newer total. Store `asOf` and schema version and reject mismatches.
- Active effects and viewer-relative overlays can change ordering. The worker
  must publish effective totals/placements, while GET computes only visible
  overlays; a changed ranking invalidates the index.
- Page navigation may see a different snapshot between requests. Return
  `asOf`/version so the client can detect a changed snapshot; do not promise a
  frozen multi-request pagination view unless a cursor is added later.
- Redis loss must remain a graceful degradation path. Persisted columns and
  the existing full legacy path remain available.

## Test-first plan

1. Integration test: a 500-participant active race requests page 0 and proves
   the response contains only the requested rows, exact total/placements, and
   no request-path full replay.
2. Integration test: requester outside the visible page still receives its
   viewer overlay without hydrating the other 485 presentations.
3. Integration test: page 1 and legacy no-view requests preserve parity with
   the current authoritative snapshot.
4. Integration test: missing/stale index returns the safe fallback and queues
   refresh without a synchronous race-wide replay.
5. Integration test: concurrent page requests share one atomic index refresh.
6. Run focused C3/Redis integration tests, then the allowed unit suite and
   document unrelated baseline failures.

## Acceptance criteria

- A paged active-race GET performs no synchronous full scoring replay.
- Only visible rows plus the requester overlay are presentation-hydrated.
- Exact page ordering and placement are preserved from the authoritative index.
- Legacy clients and unpaged/finished/team responses retain current behavior.
- Redis outage and missing-index paths remain safe and bounded.
- Backend tests pass without weakening existing assertions; both mobile
  platforms remain contract-compatible.

## Revision log

- Initial draft: separated race-wide authoritative ranking from page-scoped
  request serialization and documented stale/correctness tradeoffs.
- Gap pass 1: added explicit handling for requester-outside-page overlays,
  active effects, versioned atomic snapshots, and Redis outage behavior.
- Gap pass 2: added legacy/team/finished non-goals, exact-pagination caveat,
  and tests proving no request-path full replay.
