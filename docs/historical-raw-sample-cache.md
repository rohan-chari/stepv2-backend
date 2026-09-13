# Historical raw sample cache

Implementation is verified and reviewed. Runtime commit `912fc16` was deployed
with explicit user authorization on September 13, 2026 UTC.

## Why this work exists

The batched step-history query already loads bounded sets of users. The remaining
amplification is across recalculations: a recent upload advances the user's
scoring generation, invalidating the complete process-cached timeline and causing
older samples to be loaded again. Retaining a separately verified older segment
can reduce rows loaded during step-driven race update bursts.

The user's supplied two-minute spike investigation counted 90 history reads and
35,414 returned rows alongside 134 race recalculations. These counts do not
attribute CPU to individual queries. This change targets sample loading, not
effect/roster reads, queue claims, display boundaries or swap activity.

## Source writer audit

- Normal intake: `stepInputIntake.js` holds the per-user scoring lock through
  sample reconciliation and the version write. Reconciliation sees both replaced
  stored spans and incoming spans. Classification uses changed scoring rows in
  their symmetric difference, so resending unchanged older rows alongside a
  recent edit does not invalidate history unnecessarily.
- Other `StepSample` and `Steps` model writes: unclassified generation increments
  fail closed rather than being presumed recent. A later classified intake must
  carry this gap forward by rotating historical revision.
- `stepSampleRetention.js`: deletes in bounded batches and bumps all affected
  user generations in the same transaction. This invalidates reuse through the
  completeness mismatch.
- `reset-app-review.sql` and `seed-app-review-demo.sql`: lock and advance source
  generations before raw source edits. They also fail closed through the gap.
- Account deletion: removes samples and the user; the version row cascades away.
  Recreated proof state must receive a fresh opaque revision to avoid matching
  an old disposable Redis entry.
- Load-test/performance seed scripts are fixture writers, not ordinary production
  intake. They must continue to use isolated fixture/test data.

## Compatibility

There are no API changes. Frozen iOS and Android clients keep using the same
sync and race-progress contracts. No native release is required. Settlement
continues loading raw samples from PostgreSQL. Late history corrections remain
supported; source rows are not made immutable.

## Cache contract

- Source: `step_samples`, fenced by `user_scoring_input_versions`.
- Additive migration: `20260913030000_historical_raw_sample_proof` adds nullable
  `historical_raw_revision` (UUID), `historical_raw_complete_generation` (bigint),
  and `historical_raw_protected_cutoff` (timestamp). Existing rows need no source
  backfill and cannot provide a cache proof until classified intake stamps them.
- Keys: existing environment prefix followed by
  `historical-raw:v1:<revision>:<coverage SHA-256>`. The coverage digest binds the
  user, requested start and fixed cutoff. The value contains schema version,
  user, revision, start, cutoff and exact `[startMs,endMs,steps]` rows.
- TTL: ten minutes. A new historical revision makes old keys unreachable; their
  TTL reclaims them without synchronous per-key invalidation writes.
- Limits: 1 MiB/20,000 rows per entry, 25 users per proof batch, at most four
  Redis keys per read, 4 MiB/50,000 cached rows per batch. Lua rejects oversized
  values before transfer; publication is sequential. Caller source-loading
  memory/paging limits remain authoritative.
- Missing proof, mismatch, expiry, malformed payload or unavailable Redis uses
  bounded PostgreSQL loading. Pre/post proof batches protect cache publication;
  the existing final transaction generation fence still protects score writes.
- The current-generation process input cache remains the first reuse layer.
  Redis older-history reuse applies only after that layer needs fresh samples.

The optimization trades bounded proof reads and Redis work for fewer sample rows
returned from PostgreSQL. It does not guarantee fewer SELECT statements. The
actual tradeoff is measured in the local test evidence before release.

## Validation

Frontend contract assessment and `flutter analyze --no-pub` passed with no issues.
The first eight new HTTP/worker integration tests passed after failing before
implementation. A mixed unchanged-history/recent-change test separately failed
with 97 rows before the classification fix and passed with one afterward.

Verification passed:

- 56 focused checks: 19 HTTP/worker integration cases, five clock/budget checks,
  and prefetch/singleflight/roundtrip regressions.
- Earlier regression run: 27 checks including the initial 17 cache cases plus
  historical-scoring, retention and settlement regressions.
- Latest publication-validation refactor: 24 targeted checks passed.
- Prisma schema validation and `git diff --check` passed.
- Architect and final code review approved with no outstanding findings.

These runs overlap; their counts must not be added as unique tests. The complete
backend suite was not run. No frontend build/upload was needed or performed.

Measured sparse fixture (96 older hourly samples and one recent sample):

| Work | Cold generation | Next recent generation |
| --- | ---: | ---: |
| Sample rows returned | 97 | 1 |
| Sample SELECTs | 1 | 1 |
| Historical proof SELECTs | 2 | 2 |
| Stored historical JSON | 3,333 bytes | Same entry reused |

Those two proof reads are additional to the pre-existing source-read path. The
fixture demonstrates reuse and exact score behavior; it is not a representative
production hit rate or CPU forecast. These measurements preceded deployment.

The denser fixture uses six days of five-minute samples: 1,768 cold rows versus
616 recent rows (65.2% fewer), with 38,181 bytes in the historical Redis entry.
Both generations used one sample SELECT and two proof SELECTs. A separate worker
process also reused the Redis entry after an HTTP sync and committed the correct
score before any subsequent display read.

An illustrative local `EXPLAIN (ANALYZE, BUFFERS)` reported 2.876 ms/full versus
1.551 ms/recent. Both plans sequentially scanned the small fixture table and
touched the same 67 sample-table blocks; total-plan buffers were 76 versus 67.
This demonstrates reduced returned/sorted rows, not a proven reduction in table
blocks scanned. It excludes proof-read/Redis costs and is not a production CPU
prediction. Aggregate evidence is in
`docs/evidence/historical-raw-sample-cache/local-verification.json`.

## Operations and release

The lazy 60-second `historical_raw_sample_cache` log reports aggregate hits,
misses, reused rows, recent/full rows read and rejected proofs, without user IDs.
Counters are cumulative per process and reset on restart. Use their deltas after
deployment to verify actual benefit; Redis key presence alone is not proof of a
hit. Same-generation process-cache hits bypass this Redis layer entirely.

Apply the additive migration before starting new backend code. No source backfill,
new infrastructure, runtime flag or native release is required. Old backend
writers can continue during deployment: their generation changes leave proof
incomplete, and subsequent classified intake rotates the historical revision.
Rollback can leave the nullable columns and disposable cache entries in place.

The temporary local Redis instance used for validation has been stopped.

## Production deployment — September 13, 2026 UTC

User explicitly authorized deployment. Runtime `912fc16` is on main and tagged
`deploy/historical-raw-cache-20260913-912fc16`; previous checkout `c181570` is
tagged `pre-historical-raw-cache-20260913`.

The additive migration completed at 03:32:44 UTC through a verified direct
database connection. Prisma was regenerated; dependencies and configuration
were unchanged. Guarded reload succeeded: exactly two HTTP workers, one
resolution worker and one cron worker, aggregate pool ceiling 32. Staging stayed
stopped. Environment and pre-existing remote lockfile changes were preserved.
Local/public health both reported API and Redis healthy. Referral audit, apply
and convergence audit all returned zero outstanding rows. Existing Decoy balance
snapshot drift and BILLING_UNAVAILABLE logs were preserved and are unrelated.

At 03:36:26 UTC, the first observed resolution cache heartbeat reported three
hits, 379 older rows reused, 443 recent rows read, 143 misses and no proof races.
Redis held 24 historical raw entries (261,815 payload bytes); 23 users had current
proofs. These cumulative startup counters confirm actual reuse while the cache
warms. They do not establish a sustained hit rate or production CPU improvement.
The brief log check found no P2028/P2024/P1001/P1002 or new proof/metric errors.
Full aggregate evidence: `docs/evidence/historical-raw-sample-cache/production-verification.json`.
