# Races bandwidth and cache optimization requirements

## Summary & user story

Reduce production response bytes and repeated PostgreSQL work for the two
largest recurring surfaces: `GET /races` and
`GET /races/:raceId/message-streams`, without serving one user's state to
another user or making active race state stale beyond the existing product
contract.

The user should see the same race list and chat behavior, while repeated
refreshes reuse safe derived data and unchanged message responses transfer no
body bytes.

This is a backend-first optimization. The Flutter client only changes its
request headers/query shape if production verification shows that the existing
conditional message contract is not being used by the shipped clients.

## Scope

- Measure production adoption and effectiveness of message-stream caching and
  conditional requests.
- Make `message-streams` conditional requests reliable and high-value, using
  `ETag`/`If-None-Match` without weakening authorization or redaction.
- Design and implement split Redis caching for `/races`, keeping volatile
  viewer-specific fields out of shared long-lived entries.
- Add invalidation, fail-open behavior, integration coverage, and operational
  metrics for both surfaces.
- Preserve old app behavior and response compatibility.

## Non-goals

- No whole-response shared cache for `/races`.
- No caching of authorization decisions, private offers, inventory, active
  effects, or viewer-specific placements as shared values.
- No changes to race rules, payouts, scoring, or settlement semantics.
- No release flag or temporary rollout control. Existing permanent app-setting
  controls may be used only where already part of the deployed cache system;
  new behavior must have a safe permanent default.
- No production deploy or production data mutation as part of implementation.

## Current implementation findings

- `src/modules/races/routes.js` assembles `/races` from `getRaces`, optional
  tournaments, payout-double data, and next-race data.
- `src/modules/races/queries/getRaces.js` already uses lean SQL summaries and
  bulk presentation/effect/inventory queries when the permanent settings are
  enabled, but it returns a per-user assembled response and has no Redis
  response cache.
- `src/modules/social/queries/getRaceMessageStreams.js` performs access
  validation per request, then loads USER and SYSTEM streams in parallel.
- `src/modules/social/services/raceMessagesCache.js` already caches raw rows,
  invalidates after message and membership writes, and hydrates viewer-specific
  presentation outside Redis.
- `isCacheableShape` currently permits only explicit USER/SYSTEM streams with
  no cursor and `limit === 50`; the app coordinator's default refreshes use
  the default limit of 50, while non-default callers remain uncached by design.
- The conditional message route computes a revision and returns `304` when
  `If-None-Match` matches, but the request still performs the read and
  serialization needed to calculate that revision.
- Redis is configured as a disposable, fail-open cache with a 100 MB limit and
  `allkeys-lru`; PostgreSQL remains authoritative.

## Proposed architecture

### A. Message streams

1. Keep the existing raw USER/SYSTEM Redis row cache and post-commit
   invalidation protocol.
2. Verify, using nginx logs and request telemetry, whether current clients send
   `view=conditional-v1` and `If-None-Match`.
3. If adoption is low, update the Flutter API client and coordinator to send
   the conditional request for capable clients. The request must remain
   additive: clients that do not support the contract continue using the
   existing response.
4. Preserve `Vary: Authorization, X-Client-Features` and private cache
   semantics. No intermediary or shared HTTP cache may reuse a private chat
   response.
5. Do not expand Redis caching to arbitrary limits/cursors until production
   traffic proves a material benefit. If the common shipped request is not the
   exact cacheable shape, add a bounded, explicit cache shape with a stable key
   contract and tests rather than caching arbitrary query variants.

### B. `/races` split cache

The final response remains assembled per request from three classes of data:

1. **Stable per-user membership snapshot** — candidate race IDs and immutable
   or rarely changing race metadata needed to identify the user's pending,
   active, and completed races. Key is scoped by user ID and a versioned
   representation name. It must not contain private offer or live inventory
   state.
2. **Completed-race summaries** — completed rows and immutable result/podium
   fields may be cached per user for a longer TTL, with invalidation on race
   completion/result changes and membership changes. The cache must preserve
   feature-gated serialization at read time or include the feature variant in
   the key.
3. **Pending-race summaries** — may use a short TTL and explicit invalidation
   for invite, join, leave, kick, edit, buy-in, and start transitions.

Active-race live fields stay on the current SQL-summary path initially. The
assembler overlays current viewer-specific state (participant status,
placement, inventory, active effects, invite/result-seen fields, and offers)
after reading the shared/stable fragments.

The implementation must first inventory the exact fields used by
`getRaces.js` and fields appended by `src/modules/races/routes.js`, including
`tournaments`, `nextRace`, payout-double offers, and review-related fields.
Each field must be classified as stable/shared, per-user, or live; fields not
classified are excluded from cache entries. No cache entry may be returned
directly as the final `/races` JSON without this classification.

The cache is display-only. Settlement, payout, coin holds, and all other
authoritative writers/readers remain PostgreSQL-only and never trust Redis.

The implementation adds `redisCacheRaceListEnabled` as a graduated permanent
setting with value `true`; Redis remains fail-open, so the setting never makes
Redis a correctness dependency. Define exact TTLs, payload bounds, malformed
entry validation, and env-prefixed keys. Reuse `cacheKeys.js`, `redisCache.js`,
and `derivedCache.js`; do not create a second Redis protocol.

### Cache keys and invalidation

Use versioned keys under the existing production prefix, for example:

- `v1:user:races:membership:{userId}`
- `v1:user:races:completed:{userId}:{variant}`
- `v1:user:races:pending:{userId}:{variant}`

The exact names may be refined during implementation, but keys must include
representation version and canonical bounded variants for every response-
shaping dimension: team races, tournaments, seeded buckets, powerups, race
leave, characters, remote assets, payout-double support, review prompts,
compact view, and release channel. Unknown capabilities map to the safe legacy
variant. Never use raw headers or authorization tokens in keys.

Invalidation must be post-commit and fail-open. Add a complete
mutation-to-key matrix and fan out to every affected participant, invitee,
creator, and offer owner. Cover HTTP commands plus cron/worker paths. At
minimum include:

- create, invite, accept/decline, join, leave, kick, forfeit;
- edit, buy-in changes, start, cancel, completion, settlement/result updates;
- results-seen and any mutation that changes a field included in a cached
  completed/pending fragment;
- feature/asset presentation changes only if presentation is embedded rather
  than hydrated at read time.

If exhaustive invalidation cannot be demonstrated, use a shorter TTL and keep
the affected field out of the cache. TTL is a backstop, not a substitute for
correct invalidation.

## API contract

No required endpoint shape changes.

### `GET /races`

Request and response JSON remain unchanged for every existing client. Cache
usage is an internal implementation detail. Missing Redis, cache misses,
unknown feature tokens, and malformed cache entries all fall back to the
authoritative PostgreSQL path.

Older app versions continue receiving the existing legacy response shape.
Newer clients continue receiving additive fields already supported by the
current contract. No new required query parameter or header is introduced.

### `GET /races/:raceId/message-streams`

The existing conditional contract remains additive. The API flag still
controls 404 behavior, the conditional contract still requires the capability
token plus `view=conditional-v1`, unauthorized users still receive 403, and
partial USER/SYSTEM failures retain the existing resolved/error envelope. The
existing limit normalization remains authoritative:

- capable request: `view=conditional-v1`, optional `includeUser`, optional
  `limit`, and `If-None-Match`;
- unchanged response: current conditional JSON plus `ETag`,
  `Cache-Control: private, no-cache`, and `Vary` headers;
- unchanged response: HTTP `304` with an empty body when the tag matches;
- legacy request: current `race-message-streams-v1` response and status codes.

Authorization and viewer-specific redaction execute before any shared row cache
is used. A cache error never changes a successful response into an error.

## Data model / migrations

No database migration is expected. Redis entries are disposable derived data.
If implementation discovers that a durable monotonic version is required, use
an additive nullable/versioned field or an existing write timestamp only after
architect review; do not repurpose existing API fields.

## Frontend plan

No UI or screen changes.

The current Flutter API service/coordinator already emits the conditional
request path. Verify production adoption before editing Dart. If a client
change is required, update the shared API service and coordinator only. Both
iOS and Android use the same Dart path. The client must treat `304` as “no new
body; retain the existing messages.” Do not downgrade on transient errors: the
current client throws for non-2xx responses and only its established 404
compatibility path may enter legacy mode unless separately specified and
tested.

No client change is needed for `/races` unless a future server contract adds a
new optional field; all response parsing remains defensive for missing/null
fields.

## Observability and production verification

Before implementation, collect a read-only baseline:

- request counts and response bytes by conditional/non-conditional
  message-stream request;
- `304` count and ratio;
- Redis hit/miss/bypass/error counts for message rows and each `/races`
  fragment;
- `/races` response bytes and latency split by client capability variant;
- cache entry count, memory, evictions, and invalidation failures.

Add structured metrics that identify cache source without logging user IDs,
message bodies, auth tokens, or raw private payloads.

## Test plan — tests first

### Backend integration tests

- Exercise `GET /races` through the real HTTP route with two users and prove
  no user-specific fields cross between cache entries.
- Prove a cache hit returns the same JSON as a cold PostgreSQL path for legacy
  and capability-bearing clients.
- Mutate each membership/race lifecycle seam through its public HTTP path,
  then prove the next `/races` response reflects the mutation.
- Prove Redis unavailable, malformed, or evicted entries fall back without a
  500 and without changing response semantics.
- Exercise message streams with conditional and legacy requests; prove 200,
  304, authorization failures, redaction, invalidation after send/delete, and
  Redis failure behavior.

### Backend unit/structural tests only where integration cannot express it

- Cache-key variant and field-classification guards.
- Invalidation coverage inventory for every cached field/mutation seam.
- TTL, bounded-size, and serialization validation.
- Mixed-version tests in both directions, including capable clients against a
  cache-disabled/older backend.
- Real HTTP/test-Postgres runs with local Redis on isolated db15, plus a run
  with `REDIS_URL` unset. Confirm `DATABASE_URL` is never production.
- Job/worker completion and settlement invalidation, not only HTTP mutations.

### Frontend integration tests, only if client changes

- Pump the real race stream coordinator with a 304 response and prove existing
  messages remain visible.
- Prove legacy 200 responses and unsupported conditional responses still work.
- Run the shared tests for both platform configurations; no platform-specific
  behavior is introduced.

## Implementation order

1. Capture production baseline and verify current Redis flag/runtime state.
2. Lock the message conditional-request contract and add backend integration
   coverage.
3. If needed, update the shared Flutter client/coordinator to send and consume
   conditional requests.
4. Add the `/races` field classification and cache-key/invalidation design.
5. Add integration tests first for cold, hit, invalidation, variant, and
   fail-open paths.
6. Implement the smallest safe fragment, beginning with completed summaries;
   then pending summaries only if its invalidation inventory is complete.
7. Run backend tests, Flutter tests/analyze if touched, and production-shaped
   load verification against local/test data only.
8. Run code review and report the exact expected bandwidth reduction before any
   production deployment. Backend deploy must precede any client release.

## Backward compatibility and rollout

- Backend changes are additive and safe for old binaries.
- No new release flag is introduced by default.
- Redis is an accelerator only; PostgreSQL remains authoritative.
- `/races` cache fragments are display-only and cannot authorize settlement,
  payout, coin, or other state transitions.
- Deploy backend first. Do not deploy to production without fresh explicit
  authorization.
- Do not use staging unless explicitly authorized; staging remains stopped by
  default.
- Never run integration tests against production data.
- New content or fields are not required for this optimization, so no
  `testOnly` asset handling applies.

## Acceptance criteria / definition of done

- Existing and conditional message contracts pass integration tests unchanged.
- `/races` cache fragments are user-scoped, variant-safe, bounded, and have a
  documented invalidation path for every included mutable field.
- Redis failure and cache corruption preserve successful PostgreSQL behavior.
- Production-shaped measurements show cache hit/miss, invalidation, and 304
  behavior without sensitive data logging.
- `flutter analyze` is clean; relevant frontend tests pass if Dart changes.
- Backend tests use the approved unit/integration commands and a test DB.
- Both iOS and Android are accounted for.
- Architect review is complete, implementation review is complete, and no
  production deploy is claimed without explicit authorization.

## Revision log

- Draft 1: separated the two surfaces, retained the existing message row
  cache, and rejected whole-response `/races` caching because of viewer/live
  fields.
- Gap pass 1: added feature-variant key requirements, post-commit lifecycle
  invalidation, fail-open behavior, conditional-request fallback, and no-DB
  migration assumption.
- Gap pass 2: added production baseline metrics, exact tests-first ordering,
  old-client behavior, staging/prod restrictions, and the requirement to keep
  active race fields on the live SQL path until their freshness contract is
  proven.
- Architect review: required a dedicated race-list setting; classification of
  route-added fields; canonical capability variants; complete HTTP/cron/worker
  invalidation; derived-cache bypass semantics; mixed-version and Redis on/off
  tests; explicit display-only invariants; and alignment with current Flutter
  non-2xx/404 fallback behavior.
