# Admin analytics: server-memory processing and snapshots

Research date: September 13, 2026. Recommendation: use bounded bulk reads and server-memory aggregation for the small relational datasets, selective reads for large event sources, and shared completed analytics snapshots. A 15-minute cache alone does not reduce the cost of rebuilding a snapshot.

## Evidence and limits

Read-only production inspection around 12:00 UTC found four application CPU cores, 7,941 MiB RAM, 5,069 MiB available, load averages 0.70/0.85/0.77, and 77 MiB swap used. Two HTTP workers used approximately 434/424 MiB RSS, resolution 348 MiB, cron 350 MiB. These are instantaneous observations, not a sustained capacity guarantee. Staging was stopped. Runtime checkout was `17c89831b8ba99311a3400f09389f1b91bcb6d9b`.

Local and deployed `src/modules/admin/adminMetricsQueries.js` matched SHA256 `53c0ea0db8aa5ae1761a289177bceb0bf219fffacf01775068efe8d60971898c`.

Metadata-only reads from `pg_stat_user_tables` reported:

| Source | Estimated live rows | Total relation bytes, including indexes/TOAST |
| --- | ---: | ---: |
| users | 1,530 | 5,300,224 |
| races | 2,033 | 1,990,656 |
| race_participants | 35,605 | 39,813,120 |
| user_activity_days | 10,747 | 2,973,696 |
| device_tokens | 828 | 1,990,656 |
| friendships | 1,846 | 1,015,808 |
| activation_events | 962,021 | 531,685,376 |
| race_powerup_events | 468,560 | 265,584,640 |
| push_deliveries | 40,196 | 36,159,488 |
| coin_transactions | 56,734 | 37,330,944 |
| ad_reward_grants | 12,205 | 7,151,616 |
| daily_reward_claims | 7,135 | 3,276,800 |

These are statistics estimates, not exact COUNTs. Relation bytes are neither projected network bytes nor JavaScript heap size. No production records were exported. Diagnostic transactions were read-only with five-second local statement timeouts. A targeted pg_stat_statements lookup returned no matching retained entries; no measured query CPU or duration is claimed. No expensive dashboard refresh or EXPLAIN ANALYZE was deliberately triggered. Earlier same-day database reports document a separate one-vCPU/2-GB managed database under pressure; its current utilization was not remeasured in this investigation.

## Existing work and amplification

The Flutter overview loads summary, growth, and DAU engagement serially. Its controller caches only within the dashboard session. The stats route calls the calculators directly without a shared result cache.

Every block unconditionally runs the coverage query. That query includes all-user populations, mature signup cohorts, eligible-racer populations, device capability counts, accepted-field counts per race, and ranking each user's first qualifying power-enabled race. All of this is repeated even for blocks that do not use all those coverage measures. Summary and growth can both call the same foreground-count query. Summary also recalculates retention.

Code-derived overview count: three coverage queries, one summary aggregate, one retention query, one growth query, one DAU query, and zero or two foreground queries: **7–9 analytics queries**, excluding authentication/settings/transaction commands. This corrects the earlier conversational estimate of 6–8. They return few result rows, but those result counts conceal the much larger joins and scans inside PostgreSQL. Detail pages add further work.

DAU engagement reads nine action sources over 61 calendar dates, including for a seven-day request. Some measures genuinely require longer comparisons, but the same history should not be rebuilt separately for every selected range.

Correction to initial diagnosis: `d.action_id=da.action_id` compares two different aliases and is valid. The issue is aggregate fan-out: `daily_action` already has per-date/per-action user counts, then joins those rows back to individual events before SUM(users) and AVG(users). The sum is multiplied by event counts and the average becomes event-weighted. Distinct daily union users remains deduplicated; individual JSON action counts need not be inflated. A local synthetic example with action A having two users/three events and B one user/one event gives intended sum 3 versus current-join sum 7, intended average 1.5 versus 1.75. This was a small JavaScript relational reproduction, not an HTTP/SQL integration test. Repair by aggregating action statistics and daily unique-user unions independently, then joining the two small daily results; changing the join predicate alone is insufficient.

## Where server memory helps

| Dataset/calculation | Proposed handling | Reason |
| --- | --- | --- |
| User eligibility, signup dates, coverage populations | Read narrow user projection once; calculate multiple windows in memory | Small current population, many repeated SQL scans |
| Race qualification and first/second race cohorts | Read narrow races/participants once in bounded pages; build maps and per-user ordered histories | Replaces repeated joins, correlated field counts, and window rankings |
| Foreground DAU/WAU/MAU and retention | Read required user/day pairs once; use exact sets in memory | About 10.7k activity rows currently; reuse across summary/growth/retention |
| Device capability and friendships | Read only needed identifiers/status/capability fields; reuse sets | Small inputs; do not load token strings or unrelated user data |
| Powerup and activation events | Indexed time/type-filtered projections or compact per-user/day/action aggregates | About 1.43 million rows combined; avoid fetching full JSON event records |
| Revenue/ads/ledger totals | Start with bounded SQL sums/grouping shared across sections | Simple database aggregation may be cheaper than transmitting every ledger row |

The first four sources (users/races/participants/activity) total approximately 49,915 rows. As an illustrative sizing calculation, 200 bytes per projected row is about 9.5 MiB before protocol and JavaScript object/map/set overhead. This is not a measured payload or memory forecast. Measure peak RSS, heap, GC, serialization copies, and wire bytes on realistic local fixtures before choosing limits.

Do not sum daily distinct-user totals to calculate WAU/MAU. Keep user identities internally for exact unions. Preserve ET/DST date boundaries, epoch eligibility and maturity, review-account exclusion, cancelled/seeded/tournament filtering, first-race ordering and tie breaks, notification delivery/open rules, missing-source status, and all current metric definitions except explicitly tested bug corrections.

## Proposed execution and cache design

1. One bounded analytics builder acquires a distributed lease; no rebuild per HTTP worker, date range, or refresh button. CPU-heavy JavaScript runs in an isolated worker thread or child execution context, preserving exactly two HTTP workers and avoiding blocking cron/resolution loops. Decide concrete placement and database connection budget during implementation design.
2. Capture an as-of time. Read narrow datasets once, with bounded query time, row/memory budgets, and keyset pagination where needed. Do not silently truncate and publish complete-looking metrics. Historical first-race semantics require full relevant histories or a trustworthy precomputed first-race fact; arbitrary 90-day truncation is wrong.
3. Use a short repeatable-read read-only extraction transaction if consistent multi-query state is required; release it before CPU processing. Long extraction transactions can retain old row versions, so benchmark duration and move to versioned fact snapshots if bounded extraction cannot stay short. A timestamp filter alone cannot freeze concurrently updated/deleted rows.
4. Build shared inputs and requested section results once, deriving multiple windows from them where definitions allow. Defer unrelated detailed analyses until requested. Bound total work across different section keys too.
5. Publish completed JSON snapshots atomically in Redis with schema/definition version, section, window, ET anchor date, collection epoch, and generatedAt. PostgreSQL remains source of truth. Keep raw user-level maps private to the builder and discard after use unless a separately designed incremental state contract warrants retention.
6. Treat 15 minutes as a freshness target while admin analytics are active. Serve a completed older snapshot during rebuild, with honest age metadata. Refresh work must not overlap when a previous build exceeds its interval. Cold-cache requests share one build and do not each compute; older clients retain their response contract and bounded wait/error behavior.
7. Retain successful snapshots beyond the freshness interval under an explicitly bounded maximum stale age; a failed refresh must not overwrite them. If Redis/lease coordination is unavailable, serve an allowed last-known snapshot or unavailable. Do not let every HTTP request fall through to expensive database computation. Existing `derivedCache` deliberately falls back to PostgreSQL on uncertainty and is therefore not an adequate wrapper unchanged for this workload.
8. Authenticate and authorize every snapshot read. Invalidate/version affected snapshots after metric definition/collection epoch changes and relevant administrative corrections; preserve generatedAt instead of stamping stale values as newly calculated. System health and mutation controls remain separate from analytics freshness.

## Why not simply load everything every 15 minutes?

Moving joins and set operations to the application can use spare application CPU, but the database still filters, reads, and serializes source rows. Large raw extraction adds network traffic and application decoding/GC costs. Use the small relational snapshot first and select only required event fields/time ranges. Keep cheap SQL reductions where they substantially reduce transfer.

For longer-term growth, persist repairable daily per-user/action facts and reuse completed historical days. Merely retaining daily total counts cannot answer exact weekly/monthly distinct users. Incremental extraction must handle late events, corrected/deleted users, changing race status, updated notification opens, and retention cleanup; a created_at watermark alone misses these. Define overlap/recomputation and deletion repair before replacing full recomputation. Avoid adding analytics writes to every step sync without quantifying write amplification.

A PostgreSQL materialized view caches results but refresh computation still runs on the constrained database. It is a useful alternative for simple summaries, not the preferred first solution when the objective is to use spare application compute.

## Expected work and verification before implementation is called complete

Warm reads target zero analytics SQL (authentication may still read PostgreSQL). The repeated overview coverage computations go from three to one shared calculation per generation, and foreground counts from up to two to one. The number of extraction queries can be higher than the current SQL statement count when paged; compare actual rows scanned, buffers, CPU, bytes and complete refresh cost, not query count alone. No percentage CPU saving or guaranteed refresh latency is established yet.

Benchmark three implementations on a dedicated local test database: current SQL, corrected/shared SQL plus snapshots, and hybrid extraction plus in-memory processing. Use representative data including high event repetition and sparse cohort boundaries. Measure database planning/execution time and buffers, extraction bytes, builder wall/CPU time, peak memory, event-loop responsiveness, duplicate jobs, and cold/warm HTTP latency. Confirm the test database identity first.

Tests must precede implementation and exercise real HTTP/DB behavior: old-client response shape, warm-cache reads, concurrent requests across workers, expiry/lease expiry, builder crash, Redis outage, ET midnight/DST, epoch switches, late corrections/deletions, distinct-user overlap, and aggregate fan-out. Do not blindly match existing incorrect DAU averages; assert correct fixture outcomes. Required implementation review and Flutter checks follow if UI changes are made. No implementation, production data/config changes, service reload, new worker, or staging start occurred in this research.

## References

- Source: `src/modules/admin/adminMetricsQueries.js`, `adminMetricsDashboard.js`, `getAdminStats.js`, `routes.js`; `src/shared/cache/derivedCache.js`; frontend `lib/screens/admin_dashboard_controller.dart` and `admin_dashboard_overview.dart`.
- [Node.js worker threads](https://nodejs.org/api/worker_threads.html): worker threads suit CPU-intensive JavaScript; isolate heavy computation from HTTP event loops.
- [PostgreSQL statistics](https://www.postgresql.org/docs/18/monitoring-stats.html): table live-row counts are estimates and cumulative statistics can lag.
- [PostgreSQL materialized views](https://www.postgresql.org/docs/18/rules-materializedviews.html): results are stored and refreshed with database computation.
- [Redis cache-aside](https://redis.io/docs/latest/develop/use-cases/cache-aside/): expiry can cause stampedes without coordinated regeneration.
