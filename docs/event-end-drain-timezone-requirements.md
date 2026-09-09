# Bounded event-end draining and immediate timezone reconciliation

## Approved scope

User approved implementation and detailed integration tests first, followed by
before/after database contention/statistics measurement under heavy local traffic.
No production writes/deployment, staging use, extra process, or capacity change.
The existing shared daily event horizon remains unchanged.

## Behavior and compatibility

1. Event ends drain continuously in bounded, paced passes inside the existing
   cron process. One active pass per process, overlap guard, no unlimited loop,
   one continuation timer maximum, stop cancels timers and awaits active work.
   Existing minute cadence remains a recovery/maintenance trigger. Continuations
   must not repeat future-event enrollment, retention, or legacy event creation.
2. Use existing PostgreSQL entitlement end state as durable work and existing
   race-resolution queue for calculations; Redis is a wake/cache accelerator.
   Per-race dirty state must merge concurrent step sync and boundary changes.
   Transaction fences/atomic summaries/end stamps and late-step scoring remain.
3. Transient batch failures back off without exploding into per-user transactions.
   Bad-row isolation must be bounded and allow healthy rows to proceed. Retain
   old standalone callers where necessary; starts must not change behavior.
4. Latest valid authenticated X-Timezone is authoritative immediately. Remove the
   48-hour delay from scheduling, reuse cached authenticated user timezone when
   present, cache committed timezone in Redis with bounded expiry/invalidation,
   and use PostgreSQL on miss/outage. Missing/invalid headers never overwrite it.
   Do not add one DB timezone query or write per unchanged request.
5. On change, persist timezone and relocate eligible future entitlements with
   revised notification obligations transactionally. Both old/new starts must
   remain future; started/finished or already externally delivered opportunities
   remain unchanged. If corrected start is past, preserve existing opportunity.
   Parent worldwide start no longer blocks a user's still-future opportunity.
   Avoid overlapping opportunities. Changes back to a prior zone work normally.
6. Revalidate current user state at commit and coordinate all entitlement writers
   with timezone mutation; stale preloaded scheduler data cannot insert old-zone
   schedules after a change. Use versioning/shared serialization as appropriate,
   with bounded bulk reads and locks; do not introduce N+1 user locking queries.
7. Existing stale future schedules need a safe bounded audit/repair path. Current
   uncommitted timezone patch/support script is earlier work, not the approved
   final behavior; replace it as needed, preserving its evidence/history in docs.
8. Flutter refreshes reported timezone on app resume/request appropriately for
   both iOS/Android. Reuse app lifecycle/service paths; no UI placement changes.

No new required API fields or endpoints. Existing requests/responses retained;
optional additive timezone observation/version only if architect proves needed.
Old app headers continue working. No release flags. Backend first if deployed;
no deployment part of this implementation goal.

## Implementation map

Backend: globalStepEventScheduler.js, globalStepEventEntitlement.js,
globalEventTimezoneReconciliation.js, globalEventTimezone.js, requireAuth.js,
authSessionUserCache/authMeCache as needed, entitlement enrollment/materialization,
notification projection and existing queue integration. New DB columns/indexes
only when justified; additive migration and old-server compatibility required.
Frontend: backend_api_service.dart timezone cache and existing lifecycle hooks.

## Tests first

Real HTTP + PostgreSQL + actual scheduler/worker entrypoints, dedicated loopback
*_test database. Fail on unchanged source before business logic. Cover:
- >100 and >1000 due ends, future cohort untouched; bounded pass and prompt retry;
- scheduled tick during active drain, one active invocation, stop/restart recovery;
- transient transaction rollback/backoff, row-local failure, no duplicate summary;
- concurrent schedulers, step sync, end processing; final old/new HTTP totals;
- immediate timezone change, change back, invalid/missing headers, no-op requests;
- pending event after parent start moves; own started and newly-past stays;
- notification revision delivery timing, replay/out-of-order schedule projection;
- concurrent enrollment vs timezone update on both sides of commit;
- timezone changes concurrent with event end/start and step sync;
- cache hit/miss/outage/invalidation correctness, no repeated DB writes;
- iOS/Android service lifecycle tests for refreshed request timezone.

Existing tests are protected. If old policy assertions conflict with the explicitly
approved behavior, identify them to the user/reviewer instead of silently weakening.

## Measurement plan

Pin unchanged baseline 83d749484bab807fb2da10088d4bf3be6dc50387. Use isolated
synthetic local PostgreSQL databases and same fixtures/config for baseline/final.
Record resource sizing, database version, pool ceiling, concurrency, offered and
completed traffic, data cardinalities and elapsed time. At least a cohort well
above batch size (thousands), shared-race hot spots and distributed races, with
concurrent real HTTP sync/reads and timezone moves. Include downstream resolution
and summary processing. Compare fixed-duration behavior AND equal-work drain
cost so leaving work queued cannot appear as a performance win.

Capture per-path SQL/queue writes, rows/WAL and database transaction statistics,
lock-wait samples, deadlocks, queue age/backlog, errors and HTTP p50/p95/p99.
Use pg_stat_statements and process CPU where local setup permits; distinguish
SQL execution time from CPU and local hardware results from production claims.
Preserve raw sanitized JSON and reproducible commands. No production load tests.

## Acceptance

New tests observed red then green; required relevant suites, clean Flutter analyze;
independent code-reviewer; deterministic race/history correctness and finite
backlogs; reproducible before/after heavy load evidence including limits/failures.
Do not claim production CPU savings from local timings. Existing process count
and public API compatibility unchanged. Deliver report, code and test artifacts.

## Revision log

- Pass 1: retained several-day horizon; excluded extra process and any production
  action; distinguished maintenance timer from end-only continuations.
- Pass 2: added stale enrollment race, revised notifications, cache outage,
  return travel, late samples, fixed-duration vs equal-work benchmark evidence.

## Architect-required implementation constraints

- Serialize every timezone mutation (including zero candidates) and entitlement
  writer with existing sorted C0 race fences → global enrollment lock. Reload
  user and candidates after serialization; bulk materialization reloads bounded
  users and computes windows inside its lock. No N+1 user locks before C0.
- Refresh decision time after acquiring locks; evaluate old/new future eligibility
  against that time. Preserve already-admitted delivery and terminal facts.
- Keep legacy stable/candidate columns compatible: synchronize stable zone with
  authoritative latest zone, clear candidates; no destructive column removal.
- Legacy header ordering means server-serialized observations, not provable device
  chronological order. Define cache key/TTL, invalidation and stale-fill handling;
  report bounded missed-invalidation recovery rather than absolute immediacy.
- Revise pending notification schedule atomically or defer stale source revisions
  before delivery AND expiration. Test delayed projection past old expiry and
  out-of-order revisions. Existing admitted notifications remain immutable.
- End-only passes need both elapsed/transaction-attempt ceilings, positive pacing,
  shared overlap guard, stop cancellation. Bound individual transactions too;
  retries distinguish transient failures and persist/recover bad-row eligibility.
- Leave summary-worker optimization outside initial code scope unless measured
  contention prevents end-drain acceptance; include it in benchmark totals.

## Required deployment sequence (separate authorization)

This release requires a nonrolling cutover. Old materializers do not share the
new enrollment lock, and the existing generation-2 census does not distinguish
these revisions. Before enabling new writers, quiesce and drain all old HTTP,
race-join and cron work, including their database transactions. Apply the
additive migration, start exactly the existing two PM2 workers on the same new
revision, verify readiness, then restore traffic. Allow a brief maintenance
window; stopping only the old scheduler is insufficient. Do not overlap old
and new application workers. No new process, flag or capacity change is needed.
Production deployment and any account repair require fresh user authorization.
