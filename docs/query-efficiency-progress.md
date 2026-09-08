# Query efficiency — September 7, 2026

Base: deployed `eaea1e8`. Branch: `perf/query-efficiency`. Accepted changes form one commit. No production operations were performed during these experiments.

## Method and isolation

Each implementation followed a test-only PostgreSQL candidate experiment, an assertion that failed against the original HTTP/worker path, then implementation and passing integration checks. Tests use authenticated HTTP and, for background behavior, the normal `src/index.js` cron/resolution process. Observer preloads only collect Prisma query events; they do not replace business functions. No unit tests or production test writes.

The dedicated local `steps_query_efficiency_test` database has all 237 deployed-schema migrations. Each benchmark test guards for localhost and a `_test` database. Tests run sequentially because fixture cleanup is shared. Direct PostgreSQL sessions use UTC, matching application sessions. `QUERY_EFFICIENCY_EXPERIMENT_ONLY=1` is a test-only candidate phase, not an application flag; leave it unset for acceptance runs.

The unrelated backend worktree changes billing/realm behavior, Prisma schema, shared integration setup, app/index, routes, and web assets. None of those files is included here. Final overlap check found no shared changed file. Production API responses, scoring rules, and old-client contracts remain the same; neither mobile platform requires a new binary. No migrations or runtime flags are added.

## Disposition of all 11 audit areas

| Area | Disposition | Evidence / limit |
| --- | --- | --- |
| Public suggestions | Implemented | Set-based participant count selects eligible final race IDs before constructing rosters. Mostly-full/open/unlimited fixtures preserve exact ordered results. Buffer accesses 321→98, 461→144, 511→176 in expanded runs. Typical SQL time ~7.5→1ms or ~4→0.5ms. |
| Event enrollment | Implemented | Explicit DISTINCT/keyset/LIMIT in PostgreSQL; returns 500 users instead of 5,990 participant rows. ~7.2–7.9→2.4–3.2ms. Actual cron enrolls exact 600 users, including New York local scheduling, across advancing pages. LIMIT bounds returned users, not necessarily all examined rows. |
| Active-event badge | Implemented EXISTS | Qualifying race existence replaces fanout joins. ~4,843→103 buffers; ~3→0.07ms in 60-race/10-entitlement fixture. HTTP exclusion checks and SQL time-boundary equivalence pass. Exact duplicate-key batching was not demonstrated and is not added. |
| Standings | Implemented narrow projection | Eleven used participant columns replace `rp.*`. At 2,000 participants, sort memory 1,583→1,458KB; ~7.5–8.5→6.2–6.8ms. Buffers unchanged. Exact SQL results and HTTP count/placement preserved. Per-race cross-user batching remains unproven and is deferred. |
| Fingerprints | Implemented full-source fence projection | The covered full-source commit fence omits presentation names already excluded from its digest. ~309→9 buffers; ~2.2→1.4ms at 100 participants. Solo/team HTTP upload→worker→progress tests assert steps and names. Fresh commit validation is retained. Artifact callsite deferred until separately covered. Closure fence retains names because its scoped digest includes them. |
| Event history / eligibility | Implemented | Load eligible entitlements before impact lookup and filter impact event IDs; skip lookup when no entitlements qualify. 1,000→1 transferred rows, ~28–81→3 buffers. HTTP verifies doubled scoring, late-join clipping, missing impacts, and empty eligibility. No new index. |
| Step-history reuse | No business change | Actual solo worker: one sample query/one distinct bound; team worker: four queries/100 distinct bounds. No duplicate user/time bounds in these attempts. Existing prefetch deduplication/prepared-user tracking already avoids repeated loading. This does not prove all large paged workloads optimal. |
| Queue wake / empty claims | No business change | Trace exercises ordinary production scheduler, including 5-second recovery and three configured lanes. Empty claims persist because independent lanes probe durable work. No tested replacement proves savings while preserving wake/deadline/reclaim behavior and throughput. Current wake coordinator already coalesces scheduled work. |
| Queue enqueue JSON / no-ops | No business change | Repeating identical HTTP sample upload leaves generation at 1; no-op suppression already works. Existing enqueue is set-based and has covered-generation/scope guards. No further JSON rewrite or duplicate elimination was proven. |
| Snapshot completion | No business change | Source review confirms indexed compare-and-set from `attempting` to terminal state after publication. No evidence establishes a redundant completion. Preserve durable recovery rather than removing necessary writes. |
| Notification reconciliation | Implemented redundant probe removal | `NOT EXISTS(alert JOIN PUSH outbox)` also covers missing alerts, so separate `NOT EXISTS(alert)` is redundant. Same candidate rows; ~1.14→0.76ms in staged fixture. Actual cron rearms missing-alert and missing-push cases while leaving healthy schedule unchanged. Admission lock and scan ordering/LIMIT remain intact. |

Numbers are fixture-specific PostgreSQL measurements, not forecasts of production CPU reduction or safe queue concurrency. Cache/bloat state changes absolute buffer counts. Timing is recorded across repeated runs; most acceptance gates use buffer work, returned rows, or sort memory.

## Rejected or restricted candidates

- Initial suggestion rewrite reduced elapsed time but increased buffers; replaced by the proven set-based count implementation.
- Omitting names from the closure fence caused `scoped_fingerprint_changed` and a full-race fallback. Removed that callsite change. Integration checks now reject this regression. Only the full-source fence opts out of presentation.
- Notification candidate paging limited checks to 500 rows and traversed a gap beyond four healthy pages, but did not reliably improve time (~1.1–1.4ms versus ~1.1–1.2ms baseline). PostgreSQL still scanned other relations for the existence checks. No pagination/cursor redesign is shipped. The final simpler redundant-probe removal is independently measured and tested.
- Cross-request caching, broader queue architecture, and new indexes were not added without proof.

## Validation and review

Independent code reviewer: all seven implementation files reviewed together; SHIP, no remaining issues. Follow-up coverage includes exact suggestion order, event enrollment exclusions/cursor/timezone, active badge exclusions/boundaries, meaningful standings output, worker score/presentation, empty entitlement branch, and both notification gap cases.

Acceptance command (test-only environment variables are supplied separately):

```sh
node --test --test-force-exit --test-concurrency=1 \
  test/integration/query-efficiency-*.test.js \
  test/integration/home-suggested-races.test.js \
  test/integration/race-list-cache.test.js \
  test/integration/global-step-event-races.test.js
```

Known protected baseline failure: `home-suggested-races.test.js`, “leaves every legacy endpoint byte-compatible,” expects a tournament shape without `createdAt`, `isFavorite`, and `favoritedAt`. The unchanged baseline and optimized source both show 12 passing cases and this same failure. The assertion is preserved. Its tournament route is in the unrelated conflict set and was not edited. Do not report the full regression run as green.

Final combined acceptance run: **31 tests, 30 passed, 1 failed, 0 skipped** in 33.8 seconds. All 10 new performance/behavior integration cases passed. The sole failure is the unchanged tournament baseline described above. A prior combined run also exposed dead fixture tuples affecting suggestion buffer counts; ordinary VACUUM (ANALYZE) before the guarded local benchmark fixed fixture isolation without changing the threshold or business logic. At production-like concurrency 3, the solo trace recorded 6 claim attempts across startup and the 5-second recovery; the team trace recorded 3 startup attempts. Production deployment requires a separate, fresh authorization under backend AGENTS.md.
