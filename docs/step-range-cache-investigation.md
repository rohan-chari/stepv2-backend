# Step-range lookup and empty coverage — 2026-09-07

## Production evidence

The five-minute post-task release window recorded 378 batched step-range
lookups, 121,519 returned rows, and 12.58 seconds aggregate execution (33.3 ms
per call). The prior typed-fingerprint window recorded 158 calls, 38,087 rows,
and 2.83 seconds for this query ID. Work volume and contention changed; this
is not a controlled before/after comparison. This statement was the largest
individual execution total, but only about 4.6% of all measured statement
execution. It does not explain most database CPU on its own.

A read-only, non-executing EXPLAIN against production at 23:49 UTC used
synthetic bound values. The plan is a nested loop with an index scan on
step_samples_user_id_period_end_idx and a final sort, not a full table scan.
The estimated table population was 772,458 rows. All expected sample indexes
were present. This is plan evidence, not actual runtime or cache-miss attribution.

## Local synthetic curve

The diagnostic script scripts/diagnostics/step-range-local-benchmark.js requires
a localhost *_test database and creates only a connection-local temporary
table. It stages 800,000 samples across 1,000 users and the existing index
shapes, then executes the actual model SQL with EXPLAIN ANALYZE. Rows are
synthetic 50-minute samples across approximately 28 days. The table is dropped
automatically when the connection ends. No production data is copied.

Median execution milliseconds over three runs after one warm-up:

| Users per query | 1-day range | 7-day range | 28-day range |
|---|---:|---:|---:|
| 1 | 0.025 | 0.068 | 0.243 |
| 5 | 0.056 | 0.278 | 1.457 |
| 25 | 0.205 | 1.399 | 8.002 |

The widest query returned 20,000 rows. These local warm-cache SQL timings
exclude network/result decoding and production contention; they are not a
production concurrency ceiling or a prediction of CPU savings. An initial
100-user/8,000-samples-each distribution selected a much more expensive plan,
demonstrating sensitivity to data distribution. The 1,000-user fixture better
matches current user scale but still does not reproduce actual data skew.

## Confirmed repeated-read bug and fix

Successful sample reads with zero rows did not create a timeline. The current
race marked that user prepared, but cachePreparedUser returned early without
a timeline, so another race repeated the same empty-range read. After a
successful load, retain an empty CompactSampleTimeline for any requested user
without returned samples. Existing input-generation, coverage, TTL, and user
capacity limits govern reuse. Failed reads never reach the new code.

The real HTTP/worker integration test failed before the source change: two
sequential whole-race jobs reread unchanged empty coverage twice. Afterward it
reads once. The fixture seeds the persisted FULL envelope consumed by scheduled
refreshes; jobs originate through HTTP and execute the actual worker entrypoint.
A later HTTP sample upload invalidates the cache and public progress becomes
100. A second case without a known input version correctly reads twice, then
also processes the upload correctly. Production prevalence of this empty-result
case has not been measured; do not claim it accounts for the CPU saturation.

All 27 relevant tests passed: two new integration cases, five post-task
integration cases, seventeen prefetch tests, and three sample SQL guards.
Independent code review found no blockers, issues, or nits. Existing assertions
were preserved. No schema, API, scoring-rule, runtime flag, or client changes;
old iOS and Android clients retain the same behavior.

Evidence: /tmp/step-range-prod-plan.jsonl,
/tmp/step-range-local-benchmark-1000-users.jsonl,
/tmp/empty-samples-red.log, /tmp/empty-samples-regression.log.

Deployment requires fresh approval. The database target remains 70% idle;
this bounded cache fix alone is not evidence that the target will be reached.
