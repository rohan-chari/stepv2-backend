# Event fingerprint cache validation

Status: implementation committed as `2e707a5`; not deployed. Baseline test
failures remain documented below; this is not an all-green full-suite claim.

## Baseline and scope

Baseline is backend commit `136e682`, which contains the other agent's committed
receipt-recovery changes. Implementation is isolated on
`feature/event-fingerprint-cache`. No client endpoint or response change is
allowed; both frozen iOS and Android clients continue using their existing
contracts.

The earlier conversation's 614-call figure came from a moving ten-minute query
filter. Its CPU samples did not cover the requested complete five-minute
window. It is not an acceptance baseline or proof of cache savings.

## Required evidence

Record failing tests before business logic, then the passing exact tests after
implementation. Every database write in this validation must target a dedicated
local `_test` database; Redis must be isolated from other agents and production.
Preserve existing assertions and record unrelated baseline failures separately.

| Scenario | Required proof |
| --- | --- |
| Cold cache | Identical event history, future boundaries, and scoring result |
| Warm cache | Fewer expensive reads; complete event vector preserved |
| Completed event, later sample | Historical bonus recalculated correctly |
| Empty local result | Legacy global events remain present |
| New local entitlement | Previously empty cached result cannot hide it |
| Relocated entitlement | Persisted revision and timestamps supersede old payload |
| Changed impact status | Planning cannot commit using an obsolete event vector |
| Concurrent event creation/update | Final PostgreSQL validation rejects stale inputs |
| Loader finishes after invalidation | Old payload cannot become valid for new revision |
| Exact start/end/horizon | Current SQL equality and ordering semantics preserved |
| Redis unavailable/malformed/oversized | Canonical PostgreSQL fallback |
| Older backend writer | Database revision protection remains effective |
| Settlement | PostgreSQL authority and existing final outcomes preserved |
| Old client | HTTP race-progress and step-upload contracts unchanged |

## Work accounting

Measure complete worker attempts rather than counting only the removed SQL.
Include revision reads, cache-fill reads, sibling fingerprint reads, final
transaction validation, trigger updates, Redis operations, retries, and job
counts. Separate warm, cold, no-Redis, local-event and global-only cases.
Report calls, buffers, elapsed execution/planning, and CPU only when actually
measured. Do not derive host CPU savings from elapsed query time.

No assertion that a completion marker gives zero database work is valid if
authoritative revision or transaction validation reads remain.

## Results

Frontend compatibility review: the unchanged API contract requires no Flutter,
iOS, Android or tutorial modifications. `flutter analyze --no-pub` passed with
no issues. Existing frontend widgets/tests were inspected, not executed. No
builds or uploads were required or performed. Production race display misses
use committed data rather than the alternate request-side fingerprint rebuild.

Backend implementation is complete. Architecture and scoring reviews found the
exact-vector design safe with revision/incarnation protection, database epoch,
race-start keying, and canonical fallback for ambiguous ordering. Final SQL and
settlement remain authoritative. Production savings remain unmeasured.

Final independent code review of `2e707a5`: SHIP, no remaining blockers,
issues, or nits. Owned local Redis was stopped and no test workers remain.

Independent source check: the extracted FULL_EVENT_SQL is byte-identical to
the 3,221-character event query in baseline 136e682. This is source parity,
not proof of caller-path execution or final integration correctness.

Pre-implementation failures are retained in the ignored local red.log on the
dedicated bara_event_fingerprint_cache_test database. The original tests and
design evolved from shared race revisions to row-local witnesses; final
validation must distinguish that chronology. The first six-suite regression
run had 70 passes and four failures; it is not an acceptance result.

Final focused integration run: **40/40 passed**, comprising 29 cache cases and
11 protected planning regressions (`.local/event-cache/final.log`). An earlier
broader acceptance run passed **89/89**. Initial pre-implementation tests had
nine failures across 15 cases; review regressions separately reproduced five
failures before their fixes. All writes used dedicated local test databases.

Matched warm-worker measurements against baseline source: **31 to 30 database
round trips**, with the two fingerprint reads together decreasing **8 to 7**.
Cold global attempts used 32 round trips and cold local attempts used 31.
These counts do not establish CPU, buffer, or latency savings. Local witness
stamps add no separate tuple update; parent event edits update one catalog row.
The baseline query-count database also contained the additive migrations, so
these comparisons do not measure pre-migration trigger overhead.

Ambiguous shared local windows bypass directly to the canonical query (four
planning SELECTs). Oversized vectors and sub-millisecond timestamps also fall
back. Consequently this optimization does not eliminate every repeated event
query, and common tied local windows receive no cache-hit reduction.

Three integration failures in the local-global entitlement suite reproduced
on unchanged baseline source. The full unit suite had **3405 passes and one
missing ignored capacity-config failure**, also reproduced on baseline. With
that fixture restored, the affected suites passed **45/45** on both checkouts;
a later full run encountered the missing file again. Existing assertions were
not weakened. Prisma validation, runtime-control checks, powerup documentation
checks, and whitespace checks passed.

Apply all four additive migrations (`20260911160000` through
`20260911160300`) before running the new reader. They provide revisions, the
race-leading index, row incarnations, and the database epoch. Redis failure
falls back to PostgreSQL; missing schema is not a supported deployment order.
No Flutter build, staging start, or production deployment was performed.
