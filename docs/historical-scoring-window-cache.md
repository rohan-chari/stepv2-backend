# In-memory historical scoring window cache

This optimization reuses exact historical sample-window sums. Recent windows
remain live, and the existing scorer still combines daily totals, effects,
bonuses, frozen transfers and score floors. It does not introduce independent
final daily scores, Redis, a SQL snapshot table, or any scoring-policy change.
The Leech expiry correction is a separate preceding commit.

## Cache contract

- PostgreSQL samples remain authoritative. The existing generation/commit
  fences and source-loading rules are unchanged.
- Keys contain a schema version, user, exact original UTC window, open/closed
  eligibility mode, and SHA256 evidence for all overlapping sample data.
  Evidence includes full timestamps and step counts; equal counts or daily
  sums alone cannot prove that boosted steps are unchanged.
- UTC day buckets group dependency evidence only. The actual scoring window
  is never split or rounded differently for the cache.
- A new source generation still reloads authoritative inputs. Matching old
  contents reuse the same result; old corrections, deletions or timestamp
  changes produce different keys. No cross-process invalidation message is
  necessary, because each process verifies its loaded contents independently.
- Known race timezones use local yesterday's midnight as the cutoff, including
  DST. An adapter shared across races uses the earliest cutoff. When a race
  inherits an unknown request timezone, two complete UTC days provide a
  conservative guard. Today and yesterday are never frozen by this cache.
- Closed sums bypass reuse until every sample in the relevant dependency
  buckets has closed. Exceptionally long windows/records and paged timelines
  retain canonical calculation.
- Process memory retains at most 50,000 memoized sums for ten minutes. LRU
  evicts older entries; proof indexes use weak references to existing immutable
  timelines. Cache miss, eviction, restart or an unsupported input simply
  computes the original result. The two production HTTP workers and other
  processes have separate caches.

## Admission and cost

The initial prototype showed that high hit rates can still increase total work:
proving an entire fresh timeline unchanged costs more than calculating a small
number of sums. Production admission therefore requires at least 512 loaded
sample rows and 64 historical-window reads against a timeline. Whole batches
count before execution; repeated use of an immutable source-cache timeline can
also reach the threshold. Small workloads do not construct content proofs.
Demand is kept in a WeakMap because source timelines are frozen objects.

This change reduces repeated calculation in heavier workloads. PostgreSQL source
reloads, event fingerprint queries, and database write volume are unchanged.
It should not be presented as a fix for the entire earlier fingerprint hotspot.
In-memory `race_scoring_historical_window_cache_total` hit/miss counters allow
observing use without additional database writes.

## Local microbenchmark

Reproduce without database access: `node scripts/perf/benchmark-historical-scoring-cache.cjs`.

A read-only benchmark of the actual compact timeline and production admission,
including metric increments, used 2,016 samples and 240 batches. Median of three
rounds with a fresh source generation per batch: 100 historical windows took
144.97 ms with canonical sums and 95.12 ms with admitted cache reuse (34% less
calculation time). At 1, 5 and 20 windows, admission built no proofs; measured
ratios were 1.05x, 1.05x and 1.01x of canonical calculation time. Reusing the same
immutable timeline saved 32–80% across those workload sizes. All score checksums
matched.

These are synthetic JavaScript measurements. Local CPU/JIT variation produced
21% savings on a later fresh-generation 100-window run. No production query,
CPU or end-to-end latency reduction has been measured for this patch.

## Verification

A real HTTP integration test creates an active race with substantial historical
sample/effect work, uploads new steps through `/steps/samples`, and checks the
progress response after recent sync, old correction, and timestamp redistribution
with unchanged sample count and sum. It also verifies that the real scoring path
reuses old results across the new sync.

Pure tests preserve original midnight rounding, partially closed buckets,
zero-valued results, TTL/eviction and content invalidation. Existing prefetch and
incremental-scoring parity tests remain green. Integration uses only the local
`bara_event_ordering_test` database. No production deployment is authorized.
