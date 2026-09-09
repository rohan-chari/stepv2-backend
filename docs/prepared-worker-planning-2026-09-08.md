# Worker statement reuse — September 8, 2026

## Change

Five existing SQL families opt into the existing bounded prepared-query adapter: resolution claim (queue-wide and targeted shapes), placement claim, placement next-due read, post-task claim, and batched active-event read. The implementation is five SQL-comment annotations in four files. The hook already supports reads and queue writes, hashes exact SQL, admits at most 128 names per pool, and does not retry failed queries. This adds at most six fixed statement shapes, not one per user or race.

SQL predicates, parameters, transactions, SKIP LOCKED, generation/lease fencing, retry handling, statement count, queue cadence and client responses are unchanged. No migration, dependency, runtime flag, database setting, deployment, or mobile change is included. Old iOS and Android clients retain their existing API behavior. Deployment must retain PgBouncer prepared-statement support, already configured for the earlier prepared-read release; recheck before any authorized deployment.

## Tests first

Before modifying business logic, the new real HTTP/production-worker suite completed with 2 passing cases and 1 intended failure:

> resolution-claim must reuse a bounded named statement instead of reparsing each call

The failure occurred after successful HTTP intake, worker processing and old-client progress checks. Delayed work, expired-lease recovery and concurrent progress behind a blocked race already passed. The observer forwards every actual pg call unchanged; it does not stub query results or substitute a worker.

After the five annotations, all three new cases passed. Review then strengthened persisted claim-time checks and bounded child-process shutdown. The final targeted run passed **45/45 tests, zero skipped**:

- New prepared worker full-path tests: 3.
- Existing prepared-read HTTP/worker regression: 1.
- Existing empty-claim queue regressions: 3.
- Existing post-task regressions, including transaction rollback: 4.
- Existing indexed active-event HTTP banner and eligibility regression: 1.
- Existing placement worker suite: 23.
- Existing durable post-task storage suite: 5.
- Existing prepared adapter protocol/unit guards: 5.

The full backend suite was not run. Existing tests/assertions were not weakened. Flutter analysis is clean; both mobile platforms have unchanged code/API contracts, so no mobile builds were necessary. Code reviewer completed final review: SHIP, no blockers.

## Local measurement

Dedicated local PostgreSQL 18.4, PgBouncer 1.25.2 transaction pooling, max_prepared_statements=128, plan_cache_mode=auto. No production DB was used. The benchmark replays the synthetic SQL captured through the new public-path test using the real prepared-query hook. The baseline removes only the annotation.

Each of 18 cases runs 30 alternating baseline/prepared pairs. Mutations roll back to a savepoint after each execution; returned rows must match (only the deliberately clock-based placement lease-expiry timestamp is excluded). Queue cases have 1,000 races with zero, one or 1,000 eligible jobs. The active-event 256-request case has one eligible user and 255 missing users, not 256 active users. The first six elapsed samples are excluded from medians. Local PgBouncer server connections are recycled between topologies to avoid carrying another topology's custom-plan history into that comparison.

Representative sparse-queue medians (one eligible job among 1,000 races):

| Statement | Unnamed | Prepared | Local elapsed reduction |
|---|---:|---:|---:|
| Resolution claim | 0.452 ms | 0.217 ms | 52% |
| Placement claim | 0.293 ms | 0.188 ms | 36% |
| Placement next-due | 0.225 ms | 0.121 ms | 46% |
| Post-task claim | 0.603 ms | 0.473 ms | 22% |

PostgreSQL reported 25 generic executions and five custom executions per 30 runs for the three parameterized worker claims in the final isolated comparisons; next-due used 30 generic executions. This confirms actual plan reuse, not merely assigned statement names. These local timings include protocol/round-trip/execution overhead and do not measure production host CPU.

The active-event read used 30 custom plans per case. It can reuse the parsed statement, but this experiment establishes **no generic-plan savings for that family**. Its local sparse medians improved about 15–19%; the 256-request all-race case was essentially unchanged at about 108 ms. Do not extrapolate that fixture to an event with 256 active users.

Two exploratory issues were corrected transparently: the first empty-queue replay encountered leftovers from a previous test, so the benchmark now requires a clean test DB; early runs carried server prepared-plan history between topologies, and some dense/previously-dense cases stayed custom-planned. An initial benchmark expectation that every case must choose a generic plan was incorrect: auto is intentionally allowed to prefer a custom plan. The benchmark records both counts, requires actual reuse somewhere, and retains result-parity assertions for every pair. No production force_generic_plan setting was added.

[Sanitized measurements and source hashes](evidence/prepared-worker-plans-2026-09-08.json).

## Reproduction

Provision a fresh local PostgreSQL 18 test database and a dedicated local PgBouncer transaction pool for it with max_prepared_statements=128 and local admin access. Export DATABASE_URL pointing to that pool, NODE_ENV=test, TZ=UTC, REDIS_URL empty, and synthetic SESSION_TOKEN_SECRET / REFERRAL_IP_HMAC_ACTIVE_VERSION / REFERRAL_IP_HMAC_SECRET_V1 values. Apply migrations directly to the local database first.

```sh
PREPARED_WORKER_EVIDENCE=/tmp/prepared-worker-queries.json node --test --test-concurrency=1 --test-force-exit test/integration/prepared-worker-queries.test.js
# cleanDatabase refuses database names that are not disposable test names.
node -e 'const s=require("./test/integration/setup"); s.cleanDatabase().then(()=>s.prisma.$disconnect()).then(()=>process.exit())'
node scripts/diagnostics/prepared-worker-plans.js /tmp/prepared-worker-queries.json /tmp/prepared-worker-results.json
```

Do not run another test concurrently against this database: the benchmark uses local PgBouncer RECONNECT between cases. Its fixture cleanup removes only IDs generated by its own run. The captured SQL/parameters are synthetic test data; do not supply production query exports.

## Production follow-up

No deployment performed. After explicit deployment authorization, compare direct managed DB CPU, planning counts/time, SQL throughput, traffic, and queue age under comparable load. Named plans can adapt differently with production distributions/history. This change does not establish the 70% idle target, remove event fan-out, or optimize notification repair scans. Those remain separate follow-up work.


## Authorized production deployment — September 9 UTC

User authorized deployment explicitly. Source commit `7915ad8` was pushed on
`release/prepared-workers-20260909`, tagged
`deploy/prepared-workers-20260909-7915ad8`, and deployed on the production
checkout. The guarded wrapper completed at approximately 02:02 UTC with two
HTTP workers, one cron process and one resolution process; staging remained
stopped. Startup pool limits were 10/10/4/8, aggregate 32. Existing server
package-lock changes were backed up and preserved byte-for-byte.

Preflight verified all repository migrations applied and none unfinished,
managed transaction pool size 40, direct max_connections 50, and PgBouncer
max_prepared_statements=128. No installation, migration, configuration or
powerup-copy change was needed. API/Redis health and marketing home/privacy/
support checks passed. Required referral audit/apply/final audit all reported
zero missing rows; the apply changed zero rows.

Production pg_prepared_statements exposed all five selected query families.
Generic executions were observed for placement claim/due, post-task claim and
resolution claim across sampled pooled backends; active-event reads remained
custom-planned. These are per-backend observations, not cluster-wide counts.

Five direct managed CPU samples before reload averaged 65.45% non-idle; five
after averaged 67.80%. One-minute statement deltas were 144.5 versus 150.8 calls/s.
These short windows include changed traffic, startup/cold-plan effects and
monitoring work: they do not demonstrate lower CPU or an event-start improvement.
No statistics reset or statement deallocation occurred during either delta.

No prepared-statement/cached-plan errors were found. HTTP minute telemetry for
01:59–02:04 UTC reported zero server 5xx. One notification completeness P2028
occurred during verification; 134 occurrences of that same error already existed
in the pre-deploy cron error log. Existing billing/configuration and scheduled-race
eligibility messages also continued. Notification repair is a separate remaining
issue, not declared fixed here. A post-deploy pg_stat_monitor diagnostic hit its
five-second read-only timeout; no post-deploy planning-time reduction is claimed.
A redundant standalone final topology command required a baseline file; the
actual guarded wrapper's final topology/budget validation had already passed.
Follow-up topology, startup limits and static budget checks confirmed the intended
running configuration.

The user requested continued monitoring after clarifying that ordinary traffic
checks do not substitute for measuring the next daily-event boundary. A bounded
ten-minute read-only observation began around 02:07 UTC; results follow below.


### Ten-minute follow-up completed

The temporary samplers exited normally after approximately 02:07–02:17 UTC.
21 direct CPU samples averaged **60.79% busy** (range 35.71–89.09%, latest
69.55%); mean CPU steal was 4.64%. This is lower than the short pre-deploy
65.45% sample, but statement traffic was also lower: 118.85 calls/s versus
144.52/s. Consequently this does not establish a causal CPU saving or the
70% idle target, and no daily-event boundary was observed.

The 602.303-second unfiltered statement delta recorded 71,586 calls and
285.45 seconds of aggregate execution elapsed. Statistics reset and deallocation
markers stayed unchanged. This includes diagnostic work and execution waits;
it is not a per-query CPU measure.

All four production PIDs remained stable; staging stayed stopped. The last
sampled queue had two jobs, oldest 3.25 seconds, and no expired leases. Retained
resolution logs through the final summary contained 437 commits, one superseded
discard, and maximum queue lag 25.23 seconds. Log/CPU/SQL windows are close but
not identical. All four worker families showed generic-plan executions on a
sampled production backend; the active-event read still used custom plans.
No prepared-statement/cached-plan errors were observed.

**Two database deadlocks occurred** (pg_stat_database 222 → 224), with two
P2010/40P01 step-intake errors and two HTTP 5xx in the 02:13 minute. HTTP minutes
02:07–02:16 totaled 3596 requests,
including 286 step-intake requests. No further 5xx appeared in
subsequent retained completed minutes. Earlier logs also contain deadlocks;
that proves prior occurrence, not unchanged frequency or that this release
cannot affect timing. This deserves a separate lock-order/concurrency
investigation because it affected requests.

One further notification completeness P2028 occurred during this watch. Billing
reconciliation errors also continued (8 BILLING_UNAVAILABLE, 17
BILLING_REALM_MISMATCH log entries). No additional fix or operational change was
made while monitoring. Prioritize the step-intake deadlocks and notification
repair timeouts for follow-up; do not describe this observation as error-free.

[Sanitized production observation](evidence/prepared-worker-production-watch-2026-09-09.json).
