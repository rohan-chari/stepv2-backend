# Longer reuse of versioned event vectors

## Behavior

The existing Redis v4 event cache now retains unchanged vectors for at most
five minutes rather than30 seconds. Extra time coverage spans that same maximum
lifetime beyond the caller's ten-minute lookahead, rounded up to a minute.
Both policies use one constant so extending storage cannot silently leave
coverage too narrow. Planning still materializes only its own lookahead.

No new cache, key schema, migration, dependency, runtime flag, API field or
mobile build is introduced. PostgreSQL remains the source of truth. The same
database proof is checked on every admitted read; relevant mutations select
new version keys. Event start/end boundaries still shorten Redis TTL. Redis
failure, missing/invalid proof, insufficient coverage and oversized vectors
retain canonical SQL fallback. Private final-transaction snapshots remain
limited to30 seconds; the previous deployment's transactional checks are intact.

Old workers can read the unchanged v4 payload shape. Their shorter TTL/coverage
fills may reduce reuse during overlap, but coverage validation prevents stale
reads. Existing iOS and Android clients receive unchanged responses and scores.

## Measured benefit and tradeoffs

The isolated [research](local-event-refill-research-20260913.md) established
that increasing TTL alone still misses when the lookahead advances. With both
changes, unchanged planning after31 real seconds or3 minutes of controlled
planning-clock movement uses3 SELECTs and0 event refills, versus4 SELECTs and1
refill. These are local controlled results, not production CPU estimates.

Longer retention keeps obsolete version keys longer, and wider coverage may
load additional future events. The existing8192-row/2MiB admission limits are
unchanged. They bound each vector, not total Redis use; oversized fills still
fall back. After an authorized deploy, measure refill calls per planning read,
payload sizes, Redis memory/evictions and fallback counts under comparable
traffic. The research sample found roughly22MiB used of200MiB and zero reported
evictions; that is not a guarantee about peak future usage.

No extra refill coalescing is added: normal same-race work is already serialized
by the unique race job and lease. Shared global fills and expired-lease overlap
can be investigated separately if duplicate loads are measured.

## Validation

Tests were written before source changes. Two new explicit read-count checks
failed on baseline079ff84:31-second retention and3-minute moving lookahead.
The mixed-worker shorter-payload compatibility test passed baseline.

New coverage also confirms a raw catalog edit invalidates a vector that has
survived beyond30 seconds, updates the persisted score, and matches the real
HTTP response. Existing mutation, malformed-cache, Redis-failure, precision,
size, boundary, concurrency and final-transaction expiry assertions remain.
Tests use only dedicated loopback PostgreSQL `_test` and Redis instances.

This branch has not been deployed. Production requires a separate user request.

Final result:67/67 focused integration tests passed (56 event-cache and11
planning-input cases), Flutter analysis is clean, and code review reports
SHIP with no blockers. Full repository and known-failing broader closure
suites were not rerun for this policy-only change.
