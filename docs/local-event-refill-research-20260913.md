# Local event-cache refill research — September 13, 2026 UTC

## Verdict

The recommendation works in the isolated local experiment. Use the existing
Redis v4 cache with a five-minute maximum retention and five-to-six minutes of
extra coverage beyond the caller's ten-minute lookahead. Change both together.
Keep the private final-transaction snapshot at 30 seconds, all database version
checks, start/end expiry shortening, size limits and canonical SQL fallbacks.
This is a research result, not a production deployment or a production CPU claim.

## What the code does

`readRaceFingerprintEvents.js` selects the local refill query when the shared
global vector is usable but the race vector is not. Both entries are required
for a warm hit. The local refill joins this race's impacts with activated local
entitlements, looks up parent events, combines the cached global rows, and
returns rows and the database proof in one SQL snapshot.

Current entries expire within30 seconds. Their coverage ends at the caller's
ten-minute horizon rounded up to the next minute, plus one minute. Therefore
changing TTL alone permits retention but still causes a coverage miss roughly
one-to-two minutes later. A global cache entry with shorter coverage can also
limit a local-only refresh; the existing intersection check must remain.

Version identities incorporate the database epoch, catalog revision, race
incarnation/revision/count, race start and (for the global entry) cursor. Raw
old-writer mutations are covered by existing database triggers. A changed
version selects a different key, so longer storage is not permission to serve
old facts. The final transaction rechecks the version. Every materialization
filters the full retained vector to that read's horizon and recomputes global
boundary status; it does not reuse an old rendered score.

## Controlled experiment

Base: `079ff84`. A detached checkout and dedicated loopback `_test` PostgreSQL
and Redis were used. Main and production source/configuration were unchanged.
Two prototype changes: `MAX_TTL_MS`30000→300000 and extra coverage60000→300000.

| Scenario | Baseline planning SELECTs / event reads | Prototype SELECTs / event reads |
| --- | --- | --- |
| Same local event data, actual31-second wait | 4 / 1 | 3 / 0 |
| Same local event data, planning clock advanced3 minutes | 4 / 1 | 3 / 0 |

An intermediate TTL-only prototype still used4 SELECTs and1 event read in the
moving-horizon case. That confirms wider coverage is necessary.

Both scenarios used real HTTP step uploads, the real worker and PostgreSQL,
then asserted the persisted score and HTTP score were120 for60 steps under the
existing2x event. The second scenario controls the worker's planning clock; it
is a coverage test, not three minutes of real traffic. The first waits real
wall-clock time. Research tests report read counts for before/after comparison.

The combined prototype passed55 integration tests:53 existing event-cache
cases plus the two research scenarios. Existing tests exercise raw parent,
entitlement, impact, cursor and scoring-input changes; insertion/deletion/ABA;
Redis command failures; proof/precision/size guards; final attempt expiry;
event end and moving horizon; copy isolation; and transactional conflicts.
No scoring rules, API fields, migrations or new Redis namespaces were changed.
This is not a claim that the entire repository suite passes.

## Production read-only observations

A short sample found14 live v4 keys totaling809,899 bytes of serialized payload.
Remaining TTLs were4.6–28.1 seconds. Payload reads were capped at64KiB per key;
the9 inspected payloads had about85 seconds of extra coverage at sampling.
This is an illustrative sample, not the total event-cache memory footprint.
Redis INFO reported23,242,464 bytes used,209,715,200 bytes maxmemory,
`allkeys-lru`, and zero cumulative evictions.

Across45 seconds, all1,998 existing race version identities stayed unchanged,
and catalog revision stayed2. This supports an opportunity for retention-based
reuse, but does not establish how many production misses are caused by TTL
versus first access, revision changes, coverage or Redis failure.

## Refined recommendation and limits

1. Start with five-minute retention and matching extra coverage; retain earlier
   expiry at event start/end. Five minutes is a conservative initial engineering
   choice, not a measured optimum.
2. Retain8,192-row/2MiB admission limits. Wider coverage may include additional
   future events; oversized vectors still fall back. Longer retention also
   keeps obsolete version keys around longer, so production memory and
   eviction deltas must be measured under representative traffic.
3. Do not add refill coalescing in the first change. This cache is admitted only
   through worker planning, and the queue already has one unique race job and
   a leased `FOR UPDATE SKIP LOCKED` claim. Normal same-race processing is
   already serialized. Lease-expiry overlap and shared global fills across
   races are separate cases; add coordination only if duplicate fills are
   measured and their coverage/version differences are handled.
4. Current Redis payload shape and validation are unchanged. Mixed old/new
   workers can overwrite a key with shorter coverage/retention, which may
   reduce hits temporarily but must not produce stale scoring. Explicit
   mixed-version and long-lived invalidation tests belong in a shippable change.
5. Success should be measured as fewer local/full refill calls per planning
   read, with unchanged scores, bounded memory and no extra fallback/error
   rate. Do not project the old screenshot's56.6 seconds as recoverable CPU:
   earlier deployments already changed this query's proof cost.

Redis documents TTL as key expiration and eviction as a separate memory-limit
policy: [EXPIRE](https://redis.io/docs/latest/commands/expire/) and
[key eviction](https://redis.io/docs/latest/develop/reference/eviction/).
The recommendation's correctness comes from this application's transactional
versioning and coverage checks, not from Redis TTL alone.

Independent review found no correctness blocker for this research recommendation.
It confirmed aggregate memory and oversized-vector fallbacks as the main
tradeoffs. [Structured results](evidence/local-event-refill-research-20260913/results.json).
