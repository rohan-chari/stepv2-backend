# Continued production CPU investigation — September 7, 2026

Release under investigation: e582ed0. This follow-up does not change queue capacity, indexes, schema, or any unrelated backend files. Production investigation is SELECT/EXPLAIN only; the proposed query replacement is not deployed by this work.

## Findings

The two-minute cluster capture recorded 25,096 tracked app statements and 98.816 aggregate execution seconds. The badge query led with 67 calls, 9.320 seconds, and ~139ms mean: 9.4% of tracked execution time. Other leading work included scoring-input-version writes (84 calls/5.743 seconds), presentation fingerprints (152/4.650 seconds), post-task claims (359/3.184 seconds), and domain-event writes (22/2.724 seconds). Query execution time is not direct CPU attribution; planning time tracking is disabled.

The app database accounted for ~1.10 million cached-block accesses and 7,345 reads in pg_stat_database. Other databases showed much smaller catalog/monitoring workloads. Active samples were overwhelmingly app clients: 177 no-wait observations, 25 data-file-read observations, and 8 transaction-ID lock observations. No active autovacuum worker was observed. This sample does not rule out background work at other times. Dead tuples exist in large durable-work tables; counts alone do not justify vacuum/configuration changes as a CPU fix.

The production badge plan scanned all 21,537 entitlement rows, retaining 13,710 eligible-outcome rows before matching the requested user/time. The original pre-release query also did avoidable work: it traversed 160 active races and ~2,341 accepted participant rows. Fewer buffers in the e582ed0 query did not establish lower production latency; the scan shape remained poor.

An important validation gap: the existing local integration database is PostgreSQL 16.14, while production is 18.6. A separate disposable PostgreSQL 18.4 instance was initialized and all 237 migrations applied for this follow-up. Both fixture distribution and planner version affect plans; version mismatch alone is not proven to cause the production scan. Future performance validation should include PostgreSQL 18 and representative unrelated/history rows.

## Contained correction

Start from each requested user, use a lateral lookup ordered by entitlement start time, and LIMIT 1 only after every event/race/participant eligibility predicate. Keep the outer DISTINCT ON behavior for duplicate batched user requests. Retain OFFSET 0 on EXISTS subqueries to prevent flattening that defeats early termination. A user-only membership check avoids all event probes when no eligible active race can exist; the original impact membership checks remain and execute in the same SQL statement snapshot.

No API fields, event boundaries, race scope, scoring rules, or runtime flags change. Existing user/time entitlement indexes suffice. This reaches old iOS/Android clients through the same backend response.

## Evidence and limitations

- Test-only candidate precedes source edits. The real HTTP assertion failed against the deployed query before the lateral implementation; a second no-membership HTTP assertion failed before that gate was added.
- PostgreSQL 18 staged positive lookup: ~211→21 shared-buffer accesses for the first lateral candidate, with ~0.08–0.10→0.02–0.03ms execution. The final membership gate adds a small fixed check for eligible users.
- No-membership batches of 1/32/256 users: ~137/4,373/35,006→6/192/1,536 buffers, and ~0.12/3.31/27.9→0.018/0.167/1.29ms in the recorded candidate experiment.
- Bounded production SELECT-only comparisons, before the membership gate, showed 741→71–78 buffers. Execution under live load ranged ~55–129ms deployed versus ~0.6–21ms candidate. These few samples are evidence of reduced work, not a production p95 or CPU forecast.
- Final read-only production candidate with the membership gate: 742→76–84 buffers and 54.5–76.8→6.4–8.9ms execution. Planning time varied as well (candidate17–57ms versus deployed12–20ms); total user latency needs a post-deploy measurement.
- Fixtures include 1,000 unrelated users × 22 entitlements, legacy events, overlapping active events, newest-ineligible/older-eligible selection, two HTTP viewers with different results, duplicate users with equal/different times, exact boundaries, race scope, membership exclusions, missing impacts, and 1/32/256-user batches.
- All 11 query-efficiency integration cases pass on PostgreSQL 18; both badge integration cases pass on PostgreSQL 16. Additional final edge-case rerun covers an active member with no impacts. No existing tests or assertions were weakened.
- Independent code review found no remaining blockers. No production deployment is included in this follow-up without fresh approval.

This correction targets one confirmed hotspot. It does not explain or eliminate the remaining ~90% of tracked execution time. After deployment, compare a fresh post-startup sample; next priorities are fingerprint/persisted-work query volume and scoring-input lock contention, with production-sized retained history in PostgreSQL 18 tests.
