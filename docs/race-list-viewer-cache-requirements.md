# Races-tab viewer and public-count cache requirements

## Summary & user story

When a signed-in user opens the Races tab, the API should reuse Redis for the
personal race-card overlay and the public-race badge count while preserving the
current Postgres-authoritative behavior and compatibility with older clients.

The public badge displays only a count; it does not need the public race rows
until the user opens the public-race browser.

## Scope

This change covers `GET /races` and the compact discovery count used by
`GET /races/discovery-summary`:

- cache the per-user race-card overlay fields that are currently rebuilt after
  the stable race-list fragments;
- cache completed-race podium rows by race/result version;
- cache `publicRaceCount` for 60 seconds using a viewer-aware key;
- preserve existing race-list, standings, presentation, slot, and viewer-state
  caches and their source-of-truth rules;
- invalidate affected entries after committed race and participant changes.

Out of scope: API response shape changes, frontend rendering changes, chat/feed
payloads, migrations, product policy, payout math, or a whole personalized
page-response cache.

## Cache design

Postgres remains authoritative. Redis failures, malformed values, disabled Redis,
or stale generations fall back to the existing reads.

### Viewer overlay

Use one bounded, batched overlay value per `(userId, raceId, client variant)`
rather than one key per field. The value contains only personalized display
fields: status, placement display, buy-in/payout state, results-seen state,
invite expiry, team/forfeit state, favorite state, and leave action. A 30-second
TTL is the default; live placement/effect fields must use the existing progress
freshness and invalidation boundaries or a shorter TTL.

Invalidate the user overlay/list generation on invite, join, decline, leave,
kick, forfeit, team switch, buy-in, start, completion, cancellation, results
seen, favorite, payout, placement, participant-total, and active-effect writes.

`isCreator` is derived from the cached race creator id and user id and does not
need its own cache field.

### Podium

Store the bounded top-three completed solo rows in a race-wide key versioned by
the authoritative race result/update version. Use a long backstop TTL (up to the
existing completed-summary TTL). Invalidate on completion, placement/finish,
payout, or result correction. User presentation remains hydrated through the
shared presentation cache.

### Public-race badge count

Store the integer returned by `getPublicRaceCount` under a key containing:

- user id, because joined-race and capacity exclusions are viewer-specific;
- the capability variant affecting team/bucket visibility;
- the seeded-window visibility generation or equivalent normalized input.

The read must also be fenced by the existing shared public-discovery generation
and the viewer's membership/list generation. A generation change makes an old
value unusable without scanning or fan-out deleting every user's key. The
cache is permanent behavior when Redis is enabled; no new rollout flag is
needed.

Use a fixed 60-second TTL. The cached value is the final count, not public race
rows. On a miss, run the existing count query and write the result. On Redis
failure, use the existing Postgres count path.

Invalidate affected user count keys when public races are created, started,
completed, cancelled, joined, left, kicked, or resized, and when the current
viewer joins/leaves or seeded-window visibility changes. A bounded generation
marker may invalidate a user without scanning all keys.

### Freshness and authority rules

`myPlacement`, `myPlacementHidden`, `myDisplayPlacement`, and
`myActiveEffects` must never be served as an unversioned 60-second overlay.
They remain bound to the existing standings/effect generations, absolute effect
expiry checks, and short freshness windows. Resolution/step publication, effect
changes, and race transitions invalidate those generations.

`myBuyInStatus`, `myPayoutCoins`, and podium payout amounts are display copies
only. Settlement, coin mutations, authorization, and claims continue to read
Postgres; Redis is never their authority. Podium identity/placement rows use a
race-scoped result-versioned key, with capability-safe user presentation
hydrated separately.

## API contract and compatibility

No endpoint or JSON field changes. `GET /races` and
`GET /races/discovery-summary` return the same fields and status codes. Frozen
clients continue to use their existing endpoints and receive the same response
shape. Cache variants must include client capability inputs wherever those
inputs affect filtering or serialization.

## Implementation path

1. Add integration tests under `test/integration/` for public-count cold miss,
   warm hit, 60-second expiry, per-user isolation, capability variants,
   invalidation after public-race membership/state changes, and Redis fallback.
2. Add integration coverage for the Races-tab overlay and podium proving warm
   reads preserve the public response and invalidations expose committed writes.
3. Add cache keys/read-through helpers and wire them into `getRaces` and
   `getPublicRaceCount` without changing serializers.
4. Register all existing race/participant/effect/favorite/result writers with
   the corresponding invalidation markers.
5. Run focused race-list/discovery integration suites plus relevant unit tests;
   do not run the full suite repeatedly. Never use the production database.

## Acceptance criteria

- A warm public-count request performs no count query for the same user/variant
  until 60 seconds elapse or an invalidation occurs.
- Different users and capability variants never receive each other's count.
- A race create/join/leave/status/capacity change invalidates the affected
  count and list overlays after commit.
- Warm and cold responses are equivalent for old and current clients.
- Redis outages fall back to Postgres without a 5xx or stale-only response.
- Placement/effect values are generation-fenced and never served past their
  absolute freshness or effect-expiry boundary.
- Payout and podium values remain display-only copies of Postgres-authoritative
  settlement data.
- Focused integration tests pass and no new race-list regression is identified.

## Revision log

- Initial draft: separated stable shared race data, per-user overlays, live
  projections, completed podium, and the viewer-aware public-count cache.
- Gap pass 1: required capability-variant keys, post-commit invalidation,
  bounded values, and explicit Redis fallback.
- Gap pass 2: clarified that the badge caches only an integer, retained the
  existing API shape, and prohibited a whole personalized page cache.
- Architect review: added shared discovery and membership generation fences,
  explicit display-only settlement rules, capability-safe versioned podium
  caching, and freshness/expiry requirements for placement and effects. The
  review suggested a new default-off flag; this was rejected because the
  repository contract requires permanent cache behavior unless a flag is
  necessary for compatibility or migration safety.
