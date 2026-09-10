# Redis cache efficiency validation and release evidence

Status: implementation, targeted verification, measurements and code review complete. Six pre-existing failures in broader regression suites remain documented below; they are not silently waived. Application deployment is not authorized.

## Release artifacts and order

Release A is `cb790cd8b67ed4fb630c715f2c906191070f40e1`, the writer-only cache invalidation foundation. Release B is pinned by the local tag `redis-cache-efficiency-B-20260910`, layered on A. Resolve the exact commit with `git rev-parse redis-cache-efficiency-B-20260910`. B must not be deployed directly over pre-A workers: deploy A to every HTTP, cron and resolution worker, drain pre-A processes, then deploy B. Retain A for rollback from B. No runtime release flag, database migration, native app build or client update is required for these additive backend caches. Existing API shapes remain supported.

Production Redis maxmemory was changed to 209715200 bytes (200mb), runtime and persistent configuration, on September 9. No Redis restart was required. This capacity change is already complete; application releases have not been deployed. Production remains exactly two HTTP PM2 workers; staging remains stopped.

## Personal fragments: actual HTTP, PostgreSQL and Redis

`test/integration/cache-efficiency-personal-readers.test.js` passed 9/9 with the real release-A API child process and current B reader. The isolated PostgreSQL database is `bara_redis_efficiency_domains_20260910_test`; dedicated Redis uses port6402. No production data was used.

Coverage includes successful daily-step writes and milestone claims visible on the immediate B GET; local-date/user isolation; malformed payload and missing marker; discarded inventory; a database-triggered transaction rollback after the invalidation callback was registered; stolen inventory invalidating both actor and victim; failed A Redis invalidation causing B source bypass until recovery; and a production-mode B reader observing the actual A resolution worker minting and promoting boxes. Recovery tests wait for the repair condition, not cache expiry. A transport-scheduled HTTP concurrency test reproduced stale inventory resurrection before the shared-bulk fence fix and passed afterward; it preserves real database, Redis and handler execution. The code reviewer independently verified this red/green evidence and the batch-fence ordering.

The new measurement test records actual Prisma query events and Redis commandstats around complete HTTP requests. These are tiny local fixtures, not a production savings forecast. Cold B versus warm B is shown; other caches can also warm between the requests.

| Endpoint / fragment | Cold total SQL | Warm total SQL | Cold relevant SQL | Warm relevant SQL | Fragment bytes |
|---|---:|---:|---:|---:|---:|
| Milestones today | 3 | 0 | 2 | 0 | 163 |
| Race progress / viewer slots | 38 | 33 | 1 | 0 | 293 |

Relevant SQL means steps/claims for milestones and the participant inventory query for slots. Total counts include all queries observed during the request, including authentication and other response assembly. Inventory assertions check the actual returned box IDs; source query assertions are additional evidence, not a substitute for response correctness.

Redis commands observed (Lua internal commands are included, so these totals are not network round trips):

| Request | EVAL | GET | SET (includes SET NX attempts) | PTTL | PUBLISH |
|---|---:|---:|---:|---:|---:|
| Milestones cold | 3 | 4 | 2 | 1 | 0 |
| Milestones warm | 3 | 4 | 1 | 1 | 0 |
| Progress cold | 7 | 21 | 8 | 2 | 1 |
| Progress warm | 7 | 21 | 6 | 2 | 1 |

The generic fragment hit uses three Redis Lua round trips for marker capture, payload read and final marker validation. It eliminates the relevant PostgreSQL load, but Redis work is not free. Payload byte counts exclude Redis object/key/allocator overhead and cannot be used alone to size 200mb capacity.

## Other completed verification

The frontend widget suite passed3251 tests, including the shared Home/Friends behavior on both platform variants, and `flutter analyze` was clean. No frontend product/native code changed; no native archives were built. Frontend-specific evidence is in `docs/redis-cache-efficiency-frontend-validation.md` in the frontend repository.

Release-A operational maintenance integration tests passed3/3: managed seed/reset invalidation, preservation of the reviewer login with cleared claims and removed relationships, retained recovery manifest after a committed write plus Redis failure, wrong-target replay refusal, recovery replay, and unmanaged SQL rejection. The A operational-script code review passed after fixes.

## Outstanding gates

The final B code-review gate passed. The final full backend unit suite passed3391/3391; the public boundary-proof suite passed20/20, protected weekly projections10/10, focused worker/snapshot/metrics46/46, and personal cache HTTP suite9/9. The broader fragment measurements and successful bounded step-sync burst are recorded in [reader evidence](redis-cache-efficiency-reader-evidence.md); the local release-B tag pins the artifact. Existing regression failures must be attributed against A or fixed without weakening protected assertions.


## Baseline regression attribution (not green checks)

The exact original backend commit `7a4683c` and current B were run against the same isolated root test database with `LOCAL_REDIS_TEST_URL` explicitly set to the dedicated Redis. The original passed36/41 in the local-global-step-event-entitlements and race-bootstrap-persisted-standings suites. Five tests already failed before release A: the step-sync dependency-closure expectation, the legacy HTTP display-artifact expectation, and the three EXPLAIN-plan expectations at50/500/5000 participants. B reproduced those five failures. A separate ordering assertion was also reproduced failing on the original commit in a focused run: the test expects user-ID tie ordering, but raceParticipant.js uses participant-ID as its final SQL tie-breaker. Random UUID order makes that existing mismatch intermittent. No protected assertion has been altered or skipped.

An earlier Home active-event-cache failure was caused by omitting `LOCAL_REDIS_TEST_URL` from that suite's environment; it passed on both original and B with the explicit dedicated Redis address. That setup failure is not counted as a product regression.

These broader suites are not represented as passing. Final readiness must explicitly resolve or report their pre-existing limitations alongside the targeted new regression results.

## Acceptance map

| Agreed item | Implementation / evidence |
|---|---|
| 1. Independent race-list TTLs | `efficientRaceListCache.js`; separate pending/membership/completed fragments; HTTP reader expiry/compatibility tests. The completed recovery union preserves authoritative requested results beyond the cached latest ten. |
| 2. Home equipment | `userPresentationFragments.js` and Home shell hydration; references cached, mutable catalog fields hydrated separately; viewer balances remain outside the fragment. |
| 3. Home/Friends reuse | Shared presentation/topology readers and real Home→Friends widget cases on both platforms. |
| 4. Empty summaries | Negative envelope15s plus generation fence; positive companion-key compatibility retained; HTTP summary regressions. |
| 5. Pending invites | Candidate IDs/timestamps60s, current access/status filtering and separately hydrated presentation/counts; malformed nested rows fall back. |
| 6. Milestones | User/date fragment30s, authoritative claims/configuration, separate-A-writer HTTP mutation and rollback tests. |
| 7. Race details/counts | Metadata/count fragments300s. Descriptive metadata reused by progress/bootstrap; those handlers still run the aggregate containing authoritative monetary/legacy fields and prime count fragments for invite reuse. Do not claim aggregate SQL elimination. |
| 8. Viewer slots | Participant+race tokens,30s, bounded bulk loads captured under a common pre-query fence; real A writer/worker and concurrency tests. Consumable notices remain separate. |
| 9. Event display | Viewer/race/timezone fragment bounded by30s and known transitions; entitlement and schedule generation fences. Scoring never consumes the display fragment. |
| 10. Shared standings30s | Additive input-fenced hard-boundary proof; race/effect/event starts/ends and phase boundaries; missing old-A proof falls back. Physical retention remains300s/shared and900s/pages, and page-age tolerance remains separate. |
| 11. Measurement and capacity | Bounded process-local metrics, actual query/Redis measurements, source-loader counters explicitly distinguished from SQL, successful2000-user burst with all12m steps resolved; Redis200mb already configured. |

The independent code reviewer cleared the shared-bulk fence, completed-result union, null-row validator and capture-counter fixes. The payout-recovery fixture now uses deterministic `completedAt` values and proves the requested old race is outside the latest ten before recovery. The architect separately reviewed boundary and personal cache contracts. Final whole-change review and measurement gates must remain consistent with the final artifact.


## Final boundary and unit checks

`race-display-boundary-proof.test.js` passed20/20 in105.8s on isolated PostgreSQL/Redis with separate real workers. It covers 14/16/29 versus31-second score ages; paged retention versus hard validity; Home/list/progress/bootstrap fallback; future PENDING local event start, event end, effect phases and race end; delayed durable publication after a crossed boundary or changed effect token; old proof-less commands; and mutation racing atomic publication. The payout recovery case sets explicit completedAt ordering and verifies the requested old race is absent from both the normal latest ten response and cached completed fragment before testing recovery.

Exactly one bounded boundary SQL statement was observed per worker publication. The score timestamp is retained through delayed tasks rather than reset at publication. The queue convergence15-second condition is unchanged. The protected weekly projection suite's10 assertions remain intact; fixtures gained valid additive proof metadata and explicit user timezone. Focused worker/snapshot/metric tests passed46/46. The final `npm run test:unit` passed3391/3391, with no skips.

A first root unit invocation incorrectly forced a live Redis URL on unit suites whose fixtures assume no externally enabled Redis; three unrelated setting/banner tests failed under that injected configuration. Running the normal unit command with only a guarded local test DATABASE_URL passed the full suite. No assertions or application code were changed for that setup issue.


## Successful burst and final queue correction

The tracked2000-user HTTP/real-worker burst passed with production permanent settings, bounded HTTP concurrency16 and the existing worker capacity. All2000 uploads succeeded; all12,000,000 steps were durable and resolved; one queue row advanced through four requested/committed generations; no triggers or post-tasks remained. The local HTTP burst took1655ms with p95 request latency17.36ms. HTTP processing issued19,202 observed SQL statements, including6001 writes and one queue-row write. The complete worker drain took35,660ms and issued2708 statements/42 writes. These are local fixture measurements, not production latency or CPU predictions.

This required verification exposed an existing promoter bug: an outer seed-only predicate stranded the remaining1500 triggers after the first500. Release B removes that redundant outer predicate; existing batch/scope bounds, row locks, generation handling and atomic delete-after-promotion remain intact. The same2000-user test failed before the fix and passed after it. The reviewer cleared the minimal SQL change;32 focused queue/model tests passed afterward. No existing assertion was relaxed.

The final review verdict is SHIP for the code, including the queue delta. Redis200mb configuration is complete. The dedicated local test workers and Redis processes are stopped after evidence collection; test databases and logs are retained. No production/staging worker was started, reloaded or deployed as part of implementation verification.
