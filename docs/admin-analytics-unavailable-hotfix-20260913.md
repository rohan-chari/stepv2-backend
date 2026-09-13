# Admin analytics unavailable sections and per-page memory calculation

After TestFlight 2.3.14 (1), the user reported unavailable Active users, Activity and Ads sections while some summary data remained visible. Production analytics logs contained PostgreSQL statement cancellation `57014`; old logs did not identify the section. Earlier deployment smoke checks covered summary and purchase history, not every lazy section. The validation missed this failure path.

## Findings

The released coordinator applied a global failure cooldown after an individual section timed out, preventing unrelated cold sections from loading. Its DAU query calculated 61 days of comparisons that the new Overview and Activity screens do not display. Legacy Ads and Shop also ran 13 base queries before their section queries.

An experimental SQL compaction grouped events before daily joins. On a local fixture it reduced materialized rows from 680,800 to 4,165 and runtime from 1,571 ms to 491 ms. Both the original and compacted queries still exceeded the existing five-second statement limit in production read-only probes. The SQL-only experiment is therefore insufficient and is superseded by the user's clarified per-page memory design. No experimental index migration was created.

## Authorized implementation in progress

Each of nine views gets its own 15-minute snapshot, calculated only when requested. Narrow source fields stream through transaction-owned cursors in batches of 2,000 into a bounded application-memory worker. The worker calculates only the selected page's metrics. Cached requests perform no analytics source reads. Stale completed results remain visible while one refresh runs; unopened pages do no work.

Legacy and new requests share the existing global lease and database pool. Individual calculation failures have isolated cooldowns; shared database failures retain shared containment. The five-second statement limit remains. Existing installed clients keep their full response shapes, including a streamed replacement for the legacy DAU calculation. Updated clients send a single view request and retain a fallback for older backends. Purchase history and usernames remain independently paginated.

The exact approved contract, limits, field map and manual UI placement checklist are in the frontend repository's `docs/admin-page-memory-requirements.md` and `docs/admin-page-memory-field-map.md`.

## Verification status

Tests-first incident isolation: the new real-HTTP regression failed against the released coordinator when a genuine PostgreSQL timeout blocked unrelated Revenue. After isolation, Revenue, legacy Ads and Growth returned 200 while the failed Activity section stayed backed off across workers and windows. Both section and shared extraction isolation cases passed on a dedicated loopback test database with ephemeral Redis. The original 17-case snapshot/purchase suite also passed with the first isolation case (18/18).

These results validate the initial isolation correction only. Revised page extraction, exact metric parity, old-client compatibility, frontend behavior, memory limits, benchmarks and final code review remain pending. Do not interpret these preliminary results as release approval.

Production deployment requires fresh explicit authorization under backend AGENTS.md. Investigation has used no production writes or restarts. No staging service has been started.


## Candidate performance evidence (before final review)

The candidate passed the original 17-case snapshot/purchase HTTP suite plus both timeout isolation regressions: 19/19, 26.2 seconds, on `admin_snapshots_isolation_test` with ephemeral Redis. The injection target was mechanically moved from the abandoned aggregate query to the streamed participation cursor; all behavior assertions remain.

A SELECT-only production cursor probe read the legacy 61-day leaderboard source: 222,686 rows in batches of 2,000. DECLARE took 88 ms, first FETCH 198 ms, slowest FETCH 1,445 ms, and total elapsed time 16,934 ms including 113 laptop-to-database round trips. Every statement retained the five-second limit. This validates one source's ability to stream, not whole-page production latency. There were no production writes or index changes.

A local synthetic-data HTTP benchmark returned 200 for all nine views and zero analytics source reads on every warm repeat. The 30-day populated pages measured:

| Page | Streamed rows | Cold HTTP ms | Warm HTTP ms | Charged retained state bytes |
|---|---:|---:|---:|---:|
| Overview | 362,237 | 2,307 | 3 | 3,133,726 |
| Growth | 12,278 | 105 | 2 | 2,516,254 |
| Activity | 367,753 | 1,015 | 3 | 962,030 |
| Retention | 37,412 | 307 | 3 | 6,407,154 |
| Races | 39,169 | 1,520 | 4 | 6,606,988 |

Invites, Onboarding, Ads and Shop returned in 103–105 ms cold and 3–4 ms warm, but had no matching source rows in this benchmark. Those timings are empty-source checks, not representative populated performance claims. Charged retained state is the implementation's conservative accounting, not total process memory; the evidence also records worker heap/external memory separately. No production-wide CPU reduction is claimed.

Machine-readable non-user-data evidence is under `docs/evidence/admin-page-memory-20260913/`. Final correctness review and remaining tests are still required.


## Final verification

The frozen behavioral source passed 97 distinct backend HTTP tests: 37 page/streaming/legacy-DAU regressions and 60 snapshot, purchase, timeout-isolation and existing dashboard-contract tests. All used dedicated loopback test databases and ephemeral Redis. The new frontend passed 77 focused tests, a clean analyzer and independent SHIP review; frontend commit `94ee67b` is pushed. Full unrelated suites and manual device checks were not rerun for this revision.

The benchmark originally labeled process-wide CPU usage as worker CPU. The retained evidence corrects that field to `processCpuMs`; it must not be interpreted as per-thread CPU. Final source now uses thread-specific CPU measurement when supported and reports null otherwise. Timing and memory results above are unaffected.

No migration, infrastructure capacity change or production restart is included in verification. Production deployment and subsequent native release verification remain pending.
