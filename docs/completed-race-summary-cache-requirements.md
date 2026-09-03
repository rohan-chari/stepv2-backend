# Completed Race Summary Cache Requirements

## Summary and user story

Repeated `GET /races` requests currently recompute completed-race rankings and
aggregates in PostgreSQL. Completed race results are shared by every participant
and normally stop changing once completion commits. Cache the shared completed
summary per race in Redis so users can open the Races tab quickly without
rebuilding immutable history on every request.

As a user, I see exactly the same completed-race cards and results as before,
including my own mutable state, while repeated Races-tab opens use materially
less database CPU.

## Goals

- Cache the shared computed summary of each completed race by race ID.
- Reuse one summary across all participants instead of caching duplicate
  per-user copies.
- Preserve byte-equivalent API meaning on cold reads, cache hits, Redis errors,
  and mixed old/new backend processes.
- Keep PostgreSQL authoritative and Redis fail-open.
- Prove the change with the restored-user 108 Races-opens/sec VM comparison.

## Scope

- The completed subset passed through `Race.findSqlSummariesForUser` by
  `GET /races`, including ordinary, team, tournament-match, and powerup races.
- Shared fields derived from accepted participants: accepted/team counts,
  payout aggregate, team step totals, leader, totals timestamp,
  and duplicate-finisher fallback marker.
- Live overlay of the requesting participant, including authoritative persisted
  placement, after the shared cache read.
- Versioned Redis keys, bounded payloads, telemetry, and fail-open behavior.

## Non-goals

- No frontend or public API change.
- No caching of active or pending race summaries.
- No caching of viewer-specific fields: favorite, results-seen, invite status,
  forfeiture, buy-in state, or the viewer's payout claim state.
- No database migration, feature flag, rollout percentage, or production load
  test.
- No change to ranking, payout, completion, or scoring rules.
- No environment/database/Redis recreation per load-test level.

## Existing behavior and implementation boundary

- `src/modules/races/queries/getRaces.js` splits safe active classic races onto
  the page projection but sends residual races to
  `Race.findSqlSummariesForUser`.
- `src/modules/races/models/race.js` computes shared and viewer-specific SQL in
  one `WITH accepted AS (...)` query plus a viewer-row query.
- `src/modules/races/services/raceListCache.js` caches stable membership and
  completed race metadata, not computed completed summaries.
- `src/modules/races/services/raceSqlSummaryReadBatch.js` only coalesces
  concurrent reads with identical race sets; it is not a durable cache.

The implementation must separate the shared completed result from the viewer
overlay without changing the final object consumed by `getRaces`.

## Internal cache contract

Add a dedicated service:

`src/modules/races/services/completedRaceSummaryCache.js`

The service accepts completed race IDs, returns a map keyed by race ID, and
loads cache misses through one bounded PostgreSQL batch supplied by the model.
It must deduplicate concurrent fills in-process and use the existing
`redisCache`/`derivedCache` conventions.

Logical key:

`v1:race:completed-summary:<raceId>:<resultVersion>`

`resultVersion` must be deterministic from authoritative completion state and
must not contain user input. Prefer the completed race's persisted `updatedAt`
timestamp plus an internal schema version. A cached value from an older key is
therefore unreachable after an authoritative race-row repair. If investigation
shows a post-completion participant mutation can change a cached shared field
without updating the race row, that writer must either update `Race.updatedAt`
in the same transaction or explicitly invalidate this exact race key before
the cache may ship.

Payload schema, version 1:

```json
{
  "version": 1,
  "raceId": "uuid",
  "acceptedCount": 10,
  "teamACount": 0,
  "teamBCount": 0,
  "teamAPayoutRecipientCount": 0,
  "teamBPayoutRecipientCount": 0,
  "completedPayouts": [],
  "teamASteps": "0",
  "teamBSteps": "0",
  "totalsAsOf": "ISO-8601-or-null",
  "leaderParticipantId": "uuid-or-null",
  "leaderUserId": "uuid-or-null",
  "leaderTotalSteps": 0,
  "leaderPlacement": 1,
  "leaderFinishedAt": "ISO-8601-or-null",
  "leaderJoinedAt": "ISO-8601-or-null",
  "ambiguousFinisherOrder": false
}
```

No viewer ID, viewer-specific value, or full rank roster may enter this
payload. Validate the schema, race ID, version, and serialized byte size before
using a hit. Malformed or oversized entries fall through to PostgreSQL.

Default TTL: 30 days, centrally defined in the service. TTL is eviction policy,
not correctness policy; the versioned key controls freshness. Do not refresh
TTL on every hit.

## Read algorithm

1. Partition residual races into completed and non-completed rows.
2. Run the existing SQL-summary path unchanged for non-completed rows.
3. For completed rows, derive the exact versioned keys from authoritative
   stable race metadata and read Redis in one multi-get.
4. Query PostgreSQL once for all misses, preserving the existing powerups-only
   rank-roster SQL behavior but projecting only compact aggregate/leader fields
   into the completed cache.
5. Overlay the viewer's live participant row. Completed `viewerPosition` uses
   its persisted `placement`; no full completed roster is needed or cached.
5. Validate and write successful miss results with one bounded multi-set.
6. Fetch requesting-participant rows from PostgreSQL exactly as today and
   overlay them on shared cached/missed summaries.
7. Merge completed and non-completed summaries back into the original stable
   order before serialization.
8. If Redis is disabled, unavailable, malformed, or over budget, use the same
   PostgreSQL result and response contract as before.
9. If any summary reports ambiguous finisher order, preserve the existing full
   legacy fallback for the request.

Cold and hit paths must produce semantically identical `GET /races` responses.

## Mutation and invalidation audit

Before implementation, enumerate every post-completion writer of these shared
fields, including completion/recompletion, admin repair, payout reconciliation,
account deletion/anonymization, participant deletion, and tournament repair.
For each writer, prove one of:

- it cannot change a cached field;
- it updates `Race.updatedAt` transactionally, creating a new versioned key; or
- it performs exact post-commit invalidation.

This audit is a shipping requirement. Broad key scans and wildcard deletion are
prohibited. Old keys may expire naturally after a version change.

## API contract and compatibility

No endpoint, request, response, status code, ordering, or field changes.
`GET /races` and `GET /races?view=compact-v1` retain their existing contracts.
Older app versions therefore observe only faster equivalent responses.

Mixed backend versions are safe because Redis entries use a new namespaced,
schema-versioned key and old processes ignore them. New processes reject
unknown payload versions and fail open to PostgreSQL.

## Data model and migrations

No PostgreSQL migration. Redis values are disposable derived data. If the
mutation audit cannot prove a reliable existing result version, stop and amend
this spec before adding a database column.

## Frontend plan

No frontend code or UI-placement work. Both iOS and Android consume the same
unchanged response. The frontend implementation agent only verifies that no
new field or endpoint dependency was introduced.

## Observability

Emit identifier-free structured counters for completed-summary `hit`, `miss`,
`write`, `malformed`, `redis_error`, `oversized`, and `bypass`, plus number of
races served. Never log race IDs, user IDs, tokens, or payloads.

The VM comparison records Races-open average/p95/max, failures, dropped opens,
backend CPU, PostgreSQL CPU, and completed-summary cache outcomes.

## Tests-first plan

Backend tests must be written and shown failing before business logic:

1. Service tests: cold multi-race miss, subsequent hits, partial hit, malformed
   value, Redis read/write failure, payload bounds, schema version, TTL,
   and concurrent-fill deduplication.
2. Model/query tests: completed and active rows are partitioned correctly;
   viewer fields never enter cached payloads; original ordering is retained.
3. Dedicated `_test` Postgres plus Redis db15 integration: two authenticated
   compact HTTP reads return equivalent bodies and the second avoids the
   completed ranking query.
4. Integration mutation coverage for every writer identified by the audit,
   proving changed authoritative data cannot return a stale shared summary.
5. Redis-disabled and Redis-failure integration reads return 200 with the same
   response semantics.
6. Existing full unit and integration suites remain green; never run tests
   against production and never run bare `npm test`.

## Performance verification

Use the already-prepared isolated VM, restored/scrubbed users, two HTTP workers,
and the same 108 opens/sec workload used for commit `cebcf67`:

- flush only the isolated VM Redis database;
- prewarm the fixed cohort for 30 seconds;
- reset measurement epochs/query statistics;
- measure 108 Races opens/sec for 60 seconds;
- sample backend and PostgreSQL CPU every two seconds.

Control result after `cebcf67`: p95 16 ms, average 9.4 ms, DB CPU 64.8%, backend
CPU 65.9%, with zero failures and zero drops. Keep and commit this optimization
only if repeated runs show a credible reduction in completed ranking-query work
and no regression in errors, drops, response parity, or latency. If the result
is neutral or worse, roll it back without committing.

## Implementation phases

1. Complete and document the post-completion mutation audit.
2. Write failing service and public-path integration tests.
3. Add cache keys and the bounded completed-summary cache service.
4. Separate shared completed summary loading from viewer overlays in the model.
5. Preserve non-completed SQL and ambiguity fallback behavior.
6. Run focused tests, full relevant suites, compatibility review, and code review.
7. Run the controlled VM A/B comparison.
8. Commit only on a demonstrated improvement. Do not deploy production without
   new explicit authorization.

## Acceptance criteria and definition of done

- Repeated completed-race summaries are served from Redis across different
  participants in the same race.
- Cached payloads contain no viewer-specific data.
- Cached completed payloads contain no full rank roster; completed placement is
  overlaid from the authoritative viewer participant row.
- Cold, hit, and Redis-failure HTTP responses are semantically equivalent.
- Every cached shared field has a proven freshness path after completion.
- Redis is optional and fail-open; PostgreSQL remains authoritative.
- No API, frontend, scoring, payout, or migration change.
- Focused and relevant full tests pass, code review has no blocker, and old
  clients remain compatible.
- The controlled VM run improves completed-query work and overall performance;
  otherwise the implementation is removed.
- Any production deployment requires separate explicit approval.

## Revision log

- Gap pass 1: separated shared immutable summary data from mutable viewer
  overlays; added payload bounds, partial-hit batching, ordering, and ambiguity
  fallback requirements.
- Gap pass 2: added the mandatory post-completion writer audit, versioned-key
  freshness rule, mixed-backend compatibility, Redis failure behavior, exact
  A/B controls, and the no-improvement rollback condition.
- VM correction: removed full rank rosters from completed cache payloads and
  restored powerups-only SQL roster construction after the first candidate's
  prewarm regressed severely.
