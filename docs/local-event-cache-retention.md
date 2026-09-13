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

The user subsequently authorized production deployment; verification follows below.

Final result:67/67 focused integration tests passed (56 event-cache and11
planning-input cases), Flutter analysis is clean, and code review reports
SHIP with no blockers. Full repository and known-failing broader closure
suites were not rerun for this policy-only change.

## Production verification — September 13 UTC

Runtime949605f is deployed through the guarded reload. Local backend and
production are on main. API/Redis health pass, with exactly two HTTP processes,
one resolution process and one cron process, pool budget32, staging stopped.
Schema and copy were already current; no dependency or migration change.
Environment and the existing remote lockfile edit were hash-preserved. Referral
audit/apply/audit found zero missing rows. Existing balance drift was preserved.

After startup,31 sampled v4 keys all had more than60 seconds remaining; maximum
TTL was299471ms. All31 remained present35 seconds later, directly confirming
retention beyond the old30-second limit. Redis used23702944 bytes of209715200
and reported zero evictions at sampling. Race commits were observed; existing
billing-unavailable and notification backlog alerts continue. These checks
verify deployment and retention, not a production-wide hit-rate or CPU saving.

Rollback tag: `pre-event-cache-retention-20260913` (`079ff84`). Deployment tag:
`deploy/event-cache-retention-20260913-949605f`.
