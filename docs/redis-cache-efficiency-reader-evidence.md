# Redis cache efficiency reader and burst evidence

Measured locally on 2026-09-10 against dedicated PostgreSQL and Redis. Release A is `cb790cd`; B is the reviewed implementation layered on A. The release validation document pins the final immutable B commit. No production or staging service was used.

## Measurement method

`test/integration/helpers/measureCacheEfficiency.js` creates deterministic fixtures, sends real HTTP requests through the production-mode handlers, records actual Prisma query events, and samples Redis `INFO commandstats` immediately around each request. The local database is initialized in test mode solely to enable its guarded query-event instrumentation; application handlers are constructed in production mode. Both A and B use the same harness, fixtures, capabilities, existing permanent behavior, and dedicated services.

SQL counts include all observed statements during that HTTP request, not cache-loader invocations. Redis executions include commands executed inside Lua as well as top-level commands; they are **not network round trips**. EVAL counts are shown separately. Retained bytes count string payloads in the isolated fixture namespace, excluding CE generation markers; this is serialized payload size, not Redis allocator memory. Authentication, authoritative status/membership checks, mutable catalog hydration, and optional Home branches remain in these totals.

## Actual cold and warm requests

| Surface | Read | SQL A → B | Redis executions A → B | EVAL A → B | Retained payload bytes A → B | Response bytes A / B |
|---|---|---:|---:|---:|---:|---:|
| empty-summary | cold | 15 → 14 | 23 → 52 | 3 → 8 | 412 → 829 | 58 / 58 |
| empty-summary | warm | 11 → 4 | 6 → 23 | 1 → 6 | 412 → 829 | 58 / 58 |
| home-equipment-and-friends | cold | 34 → 34 | 16 → 64 | 2 → 11 | 412 → 1574 | 690 / 690 |
| home-equipment-and-friends | warm | 29 → 19 | 3 → 26 | 0 → 7 | 412 → 1574 | 690 / 690 |
| friends | cold | 3 → 4 | 0 → 20 | 0 → 3 | 0 → 503 | 314 / 314 |
| friends | warm | 3 → 0 | 0 → 7 | 0 → 2 | 0 → 503 | 314 / 314 |
| pending-invite-with-metadata-counts | cold | 9 → 11 | 6 → 45 | 0 → 12 | 411 → 1871 | 391 / 391 |
| pending-invite-with-metadata-counts | warm | 5 → 2 | 3 → 36 | 0 → 11 | 411 → 1871 | 391 / 391 |
| race-list | cold | 7 → 9 | 17 → 32 | 0 → 6 | 1864 → 3283 | 1404 / 1404 |
| race-list | warm | 4 → 4 | 4 → 12 | 0 → 3 | 1864 → 3283 | 1404 / 1404 |
| race-event-display | cold | 16 → 16 | 34 → 34 | 11 → 3 | 398 → 739 | 797 / 797 |
| race-event-display | warm | 13 → 11 | 2 → 23 | 0 → 3 | 398 → 739 | 797 / 797 |
| race-bootstrap | cold | 25 → 24 | 5 → 45 | 0 → 9 | 406 → 1265 | 2564 / 2564 |
| race-bootstrap | warm | 24 → 22 | 4 → 43 | 0 → 9 | 406 → 1265 | 2564 / 2564 |

Warm SQL falls on six of these seven surfaces. The already-warm race list retains four authoritative statements; its benefit is independent fragment expiry and longer retention, demonstrated separately by the HTTP test that removes only the pending fragment while preserving the completed payload. No universal percentage reduction is claimed. Cold Friends, invite and list reads cost additional queries, and Redis execution counts increase. The tradeoff depends on repeated reads within the documented retention windows. Local latency is not a production capacity forecast.

Home equipment hits still issue a bounded authoritative catalog query. This is intentional: catalog fields can be changed by peer/raw writers without target-Redis invalidation. The stored equipment payload contains references only. Exact response assertions and equal serialized response lengths verify that the new cache does not add presentation internals to the frozen creator contract.

## Correctness checks for these readers

- `redis-cache-efficiency-readers.test.js`: eight real HTTP tests, including split TTLs, explicit negative summary, catalog mutation on a warm equipment hit, Friends reuse, invite create/rename/decline, event display, bootstrap access, cross-worker friendship/identity mutations, and null-row corruption fallback. Release A runs as the separate writer process when `CACHE_TEST_WRITER_ROOT` is supplied.
- `active-impact-home-summary-cache.test.js`: five protected summary tests. The existing positive Redis key remains a required companion of the new positive envelope; both install in the same generation-checked Lua operation. Deleting the legacy positive key still forces a fresh source read. Empty envelopes do not require a companion.
- Combined reader and positive-summary regression: **13/13 passed**, with a real release A writer. The creator-field and malformed-null regressions were observed failing before their fixes; no existing assertion was weakened.
- Shared metadata loaders capture the entire batch generation fence before any bulk SQL. Each per-race reader uses that captured subset; a later sibling cannot stamp old bulk rows with a newly captured generation. The same protocol covers slots, whose cross-worker late-sibling test is recorded in the main validation evidence.
- The worker-backed payout-offer test proves an older completed race outside the latest ten remains present exactly once beside an active projection on cold and warm list reads. It failed with the old projected merge and passes after authoritative residual rows are included.

The runtime counter is named `cache_efficiency_source_loads_total`: it counts source-loader invocations, including shared-memo invocations, and must not be described as measured PostgreSQL SQL. Actual SQL evidence comes from the instrumentation above. Production labels remain bounded surface/outcome names, with no user or race identifiers.

## 2,000-user burst and downstream drain

The tracked `cache-efficiency-burst.test.js` drives 2,000 distinct authenticated users through `POST /steps`, using 16 HTTP lanes and one shared active race. It then checks durable daily totals, samples refreshed milestone HTTP responses, starts the real resolution entrypoint, and waits for **all** promotion triggers and post-commit tasks to drain. The worker retains local SQL instrumentation, while its inherited `NODE_TEST_CONTEXT` is removed so permanent production settings apply; no product flag or worker-capacity change was introduced.

| Actual result | Value |
|---|---:|
| Successful HTTP writes | 2000 / 2,000 |
| Raw steps persisted / participant steps resolved | 12,000,000 / 12,000,000 |
| Durable race queue rows | 1 |
| Requested / committed generations | 4 / 4 |
| Remaining triggers / unfinished post-commit tasks | 0 / 0 |
| HTTP burst duration | 1,655 ms |
| HTTP p50 / p95 / p99 | 12.58 / 17.36 / 23.48 ms |
| HTTP-side SQL statements / writes / queue writes | 19,202 / 6,001 / 1 |
| Worker SQL statements / writes | 2,708 / 42 |
| Full downstream drain after the burst | 35,660 ms |

Redis commandstats during the HTTP burst: `{"set":4008,"get":9,"publish":4000,"eval":3748,"client|setinfo":2,"del":2000,"hello":1}`. These are actual command executions, including Lua-internal commands, not network round trips. SQL includes the existing ingestion and worker business work. The test demonstrates bounded concurrency, durable correctness and queue coalescing; it is not a production capacity guarantee or a baseline-relative worker speed claim.

**Required verification exposed a pre-existing promoter bug.** Before the fix, the same burst persisted all 12 million daily steps but processed only the first 500-user page, leaving 1,500 durable triggers and only 3 million resolved participant steps after 120 seconds. The candidate SQL required `full_trigger_seed_only`, even though successful promotion clears it. Release B removes that redundant outer predicate. The existing active-race condition, dirty-scope bound, 500-row limit, 1,000-identity merge caps, row locks, generation/lease handling, and delete-after-success transaction remain intact. The durable regression now passes after four successive generations. No assertion was weakened and no runtime switch was added.

## Reproduction

Use explicit dedicated local `*_test` PostgreSQL and Redis URLs. Every harness validates them before imports that could write. Set the shell variables below to those isolated targets and to the detached release A worktree. No connection value is committed here.

```sh
DATABASE_URL="$CACHE_TEST_DATABASE_URL" REDIS_TEST_URL="$CACHE_TEST_REDIS_URL" CACHE_TEST_BACKEND_ROOT="$CACHE_RELEASE_A_WORKTREE" CACHE_TEST_EVIDENCE_PATH="$TMPDIR/cache-readers-A.json" NODE_ENV=test node test/integration/helpers/measureCacheEfficiency.js
DATABASE_URL="$CACHE_TEST_DATABASE_URL" REDIS_TEST_URL="$CACHE_TEST_REDIS_URL" CACHE_TEST_EVIDENCE_PATH="$TMPDIR/cache-readers-B.json" NODE_ENV=test node test/integration/helpers/measureCacheEfficiency.js
DATABASE_URL="$CACHE_TEST_DATABASE_URL" REDIS_TEST_URL="$CACHE_TEST_REDIS_URL" CACHE_TEST_WRITER_ROOT="$CACHE_RELEASE_A_WORKTREE" NODE_ENV=test node --test --test-concurrency=1 --test-force-exit test/integration/redis-cache-efficiency-readers.test.js test/integration/active-impact-home-summary-cache.test.js
DATABASE_URL="$CACHE_TEST_DATABASE_URL" REDIS_TEST_URL="$CACHE_TEST_REDIS_URL" CACHE_TEST_EVIDENCE_PATH="$TMPDIR/cache-burst.json" NODE_ENV=test node --test --test-concurrency=1 --test-force-exit test/integration/cache-efficiency-burst.test.js
```

The wider release checks, permanent settings, exact baseline failures, rolling-writer evidence, milestones, slots, standings counterfactuals, and final review are recorded in the main release validation document.
