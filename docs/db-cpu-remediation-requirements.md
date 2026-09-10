# Database CPU remediation requirements

Status: approved by the user and architect; implementation and measured dispositions recorded in [validation](db-cpu-remediation-validation.md). Production deployment requires separate approval. September 10, 2026.

## 1. Summary and user story

As Bara's operator, I want the application to do less database work per accepted action, so existing infrastructure can handle more users without delaying step acceptance, showing stale race results, or losing durable notifications/capture inputs.

This specification covers every issue raised by the [one-hour investigation](db-cpu-hour-2026-09-10.md), plus the telemetry defect discovered while correlating it. The strongest immediately actionable candidates are display-boundary preparation and retained-root maintenance. Notification repair scanning is a substantial follow-up. Other families require targeted experiments before selecting a change. Host steal and memory pressure require separate attribution; application optimizations cannot guarantee their removal.

Evidence baseline: deployed `3a60332e17dac7f843f107fb788e8479875104ef`; local review at `de7e8955708b0256ea67beb14d1fa2855a064a43`. The reviewed boundary, preparation adapter, resolution worker, notification reconciler, counter recorder and telemetry sources have no diff from that deployed commit. The previous report retains live function verification, runtime verification and source hashes. This follow-up used retained measurements and source review; it did not run another production watch or a candidate performance benchmark.

## 2. Evidence and priorities

CPU averaged 65.3% non-idle, peaked at 92.1%, and averaged 34.7% idle. The operator's objective is **70% average idle under comparable traffic**. This is an operational objective, not a promised result of this specification.

The completed PostgreSQL monitor buckets recorded 679,716 commands, including 220,841 utility commands and 458,875 other statements. Planning elapsed was 794.7 s; execution elapsed was 1,369.2 s. Background resolution/cron supplied 62.7% of application execution elapsed. There were 22,242 HTTP requests, including 2,010 step-intake requests, and 2,782 committed resolutions. These aggregate totals cannot establish SQL per step sync.

| ID / priority | Issue and measured opportunity | Disposition |
| --- | --- | --- |
| A / first | Boundary lookup: 2,648 calls; 135.27 s planning, 24.96 s execution | Implement preparation after test-first plan experiment; traversal rewrite conditional |
| B / first | Capture roots: 37,579 updates, zero inserts/deletes over 58.5 minutes | Replace retained-root timestamp churn with bounded fair traversal |
| C / next | Other leading stable queries repeatedly planned | Prepare selected shapes only after individual plan/compatibility gates |
| D / next | Notification/outbox family: 46,425 commands, 233.2 s execution | Prioritize two recovery scans; preserve already-batched delivery |
| E / investigate | Fingerprints: 19,764 calls, 143.6 s execution; sample reads: 2,539 calls, 60.4 s | Existing reuse is real; instrument remaining duplication before changing it |
| F / investigate | Queue/publication: 85,974 commands, 137.7 s execution; 808 zero-changed commits | Separate necessary fences/receipts from avoidable probes; no blanket job dropping |
| G / small | Counter family: 11,228 calls, 2.7 s execution; 10,748 table updates | Batch metrics within each existing transaction; no lossy buffering |
| H / observability | Timer minute labels wrong in 15 rows; 122 flushes for 120 worker-minutes | Correct interval ownership and early-timer handling |
| I / operational | CPU steal 8.06% average / 27.53% peak; active zram I/O | Provider/capacity investigation, no infrastructure change in this scope |
| J / measurement | Collector cost, stats eviction and incomplete CPU attribution | Keep interval deltas, collector attribution and honest missing-data reporting |

Table counters and CPU/bucket windows differ slightly; do not sum overlapping families or infer CPU percentages from their elapsed times. Autovacuum is a consequence worth measuring, not a service to disable. The report contains the precise windows and source limitations.

## 3. Scope, existing work and non-goals

Backend behavior/performance and internal telemetry only. No new endpoints, response fields, client requirements, scoring rules, economy changes, UI placement, assets, or Flutter edits. No runtime flags, wider concurrency, staging startup, provider configuration edits, deployments or production data writes are authorized by this specification request.

Preserve existing optimizations documented in [query efficiency](query-efficiency-progress.md), [active-event follow-up](query-efficiency-followup.md), [summary/notification hotfix](summary-notification-cpu-hotfix.md), and [event traffic efficiency](event-traffic-efficiency-requirements.md). In particular:

- Fingerprint planning reuse, source prefetch/coalescing and fresh commit checks already exist.
- Public suggestions already count participants as a set before hydrating final rosters.
- Active-event reads already use indexed lateral eligibility and a membership gate.
- Notification event/audience writes and silent-placement expansion already use bulk SQL. Nine queue shapes already opt into preparation.
- Summary wake suppression already preserves independent recovery and compaction deadlines.
- An earlier notification cursor experiment did **not** reliably improve performance because joined relations still scanned broadly. Repeating that rewrite without new evidence is not an accepted fix.

No arbitrary removal of transactions, SET commands, receipts, fingerprint reads, no-op resolutions or vacuum work. No assumption that every repeated query is unnecessary.

## 4. A — Display-boundary preparation and traversal

Source: `src/modules/races/services/raceDisplayBoundaryProof.js:89`, called by `raceProgressSideEffects.js` after `computePersistedSnapshot`; preparation adapter: `src/shared/database/preparedReadQueries.js:10`, installed by `src/db.js`.

The query computes the earliest future global/local entitlement boundary. It executes two copies of the participant/entitlement join. A retained production SELECT plan recorded 48.102 ms planning, 12.508 ms execution, 557 shared hits and two reads, traversing 31 participants in each local branch. Existing indexes are used. A new index is not the first prescription.

Implementation sequence:

1. Write public HTTP → real resolution process → public progress tests capturing the actual SQL. Establish baseline through PostgreSQL 18 and transaction-mode PgBouncer. Use test-only observer instrumentation; do not mock the helper.
2. Make the stable SQL string start **exactly** with `/* steps:prepared-read:v1 */`; leading whitespace before the comment will miss the adapter's startsWith admission check. Preserve bind types, predicates, null semantics and single-row result shape.
3. Use existing 128-name per-pool admission. Keep overflow unnamed, no error replay and no eviction/re-admission. Verify protocol-level names actually reach the adapter and server, including after pooled connection turnover.
4. Warm representative races beyond the initial five custom plans. Measure planning plus execution, buffers, custom/generic counts on owned sessions, and latency across small/large rosters, dense history and empty results. Preparation does not guarantee a generic plan; statistics refresh, DDL and connection turnover may replan. Do not globally force generic plans.
5. Only if residual traversal matters, compare a second candidate: one local entitlement traversal producing start/end values via lateral VALUES, filtered strictly after `scoredAt`, plus legacy branches. Preserve PENDING and both activated outcomes. This may change index usage; ship only if equivalent and lower total work across distributions. Keep this a separate measured change from preparation.

Retain marker capture and both generation checks, `current()` validation after the SQL, effect phase boundaries and race-end rejection. Do not cache proof results across generations or discard a boundary crossed while a task waited. Preserve Redis unavailable/malformed-proof fallbacks.

Gate: same client-visible results and fence rejection in all fixtures; no new errors after pool reconnect; materially lower warm planning plus execution for the representative mix, with no >10% p95 regression in any fixture across three repeated matched runs. Report actual reduction; 135.27 s is an elapsed opportunity, not guaranteed host CPU savings.

## 5. B — Retained capture maintenance without root rewrites

Sources: `prisma/migrations/20260905013000_durable_capture_bounded_eviction/migration.sql:12`, `20260906010000_capture_compaction_schedule/migration.sql`, and the newer compact function in `20260906010100_capture_compaction_batch_deadline/migration.sql`; callers `durableCaptureCleanup.js:28`, `durableCaptureFacts.js:195`, `globalEventSummary.js:482`.

The live evict function selects old roots then sets `last_used_at=now()` even when pinned or otherwise ineligible. Its scheduler treats any old retained root as more work. The inventory contained 6,763 roots, 6,454 pinned, none expired/evicting. Roots recorded 17 autovacuum and 17 autoanalyze increments. This proves churn; not every root update can be individually attributed from table counters.

Chosen design: a durable keyset sweep that **reads retained roots and writes only roots transitioning into eviction**. Do not simply filter pinned roots while leaving the scheduler's old-root predicate; that can create a one-second busy loop or starvation.

Add a new migration, never edit historical migrations. Add one internal singleton sweep-state table, provisionally `durable_capture_root_sweep(singleton boolean primary key check(singleton), after_id uuid null, next_due_at timestamptz not null default now())`. Initialize one row. This is cursor state, not a retention source of truth.

- Under the existing exclusive advisory lock, when due read at most `p_limit` root IDs after the cursor, ordered by the existing UUID primary key. Traverse **all** roots in the page before filtering; do not make progress depend on finding eligible roots. Use one bounded joined eligibility query with the pin-root and head-key indexes. Retained roots are not locked/updated merely for visiting them.
- A root may transition only if the existing ten-minute age predicate holds, retention expired or revision superseded, and no pins exist. Preserve the existing exclusive/shared advisory-lock protocol against pinning and the irreversible `evicting` identity fence. Retention/source-revision semantics do not change.
- Persist the last examined ID in the same transaction. A full page schedules continuation one second later. A short/empty page resets the cursor and schedules the next sweep one minute later. Existing evicting-child drains remain independently due. A rollback advances neither cursor nor eviction.
- Root arrivals behind the cursor, pin releases and head revisions that change after a visit are found on the following wrap. The cursor is a progress hint, not proof that earlier rows are permanently safe. No new write on every pin release/source update is needed.
- Replace the old retained-root EXISTS in `compact_if_due` with the sweep deadline. Include that deadline when determining the next compaction wake. Preserve journal/head deadlines, the ten-minute journal tail, unprepared-root protection, 30-day provenance, and independently bounded child deletion. Keep direct `durable_capture_compact` callers compatible as specified below; both entrypoints use the same new sweep state and advisory lock.
- Separate forced direct invocation from throttled scheduled invocation with a new internal compact/eviction helper accepting `force_sweep boolean`. Existing public SQL signatures remain wrappers: `durable_capture_compact(p_limit)` and `durable_capture_evict_roots(p_limit)` force one bounded sweep page even before its deadline; `durable_capture_compact_if_due(p_limit)` invokes the internal helper with false. A completed short page has already reset its cursor, so the immediate unpin-then-direct-compact foundation case must collect that now-eligible root. Do not weaken or delay its existing assertion. Large populations still use bounded fair cursor progress, not an unbounded forced sweep.
- Forced-call compatibility refinement (implementation evidence): the protected foundation contract explicitly ages the oldest root and calls `compact(1)`, requiring its child drain immediately even among roots retained by earlier operations. A UUID-only page cannot guarantee that. Therefore forced direct entry first examines at most `p_limit` oldest non-evicting age-qualified roots using the existing collection index, transitions only eligible roots, and then advances its one fair cursor page. Oldest eligible roots consume the transition budget first; the UUID page can transition only the remaining slots, so at most `p_limit` roots enter eviction and the protected `compact(1)` age-priority root cannot lose its child budget to a younger UUID-first root. Direct calls examine at most `2*p_limit` eligibility candidates; scheduled calls retain the `p_limit` bound and do not run this compatibility probe. Both paths retain the original child-delete and root-removal bounds; pinned/current roots are never refreshed merely for visiting them. Compare old/new scheduled cost separately from legacy forced-call overhead. No public SQL signature changes.
- Mandatory lock order: scheduled entry takes outer compaction schedule row, then advisory lock, then sweep state, then existing root/head locks. Direct entry takes advisory lock then sweep state and root/head locks, and **never updates or locks the outer compaction schedule row**. Do not introduce any advisory-lock → outer-schedule-lock path. In both entries preserve the existing source head/pin lock protocol; include a simultaneous direct/scheduled/intake deadlock test.
- Check an active root pin before loading its revision head: a pin alone excludes eviction. Compare the earliest timestamp in each indexed head eligibility class against one captured post-compaction timestamp. Use the existing partial indexes for the two MIN probes, so both custom and generic plans avoid traversing all current heads; do not perform a volatile per-row clock read. Include pinned superseded heads in matched total-work fixtures and test these two avoidable head traversals explicitly.
- Compute the outer scheduled deadline explicitly after work: let existing journal/head/evicting-child work choose the current one-second-versus-one-minute deadline, **excluding the removed old-retained-root EXISTS**; persist `LEAST(that_deadline, root_sweep.next_due_at)`. This propagates one-second cursor continuation through the outer gate that `nextSummaryDueAt` already reads. A direct sweep may move the sweep deadline without changing the outer row; at worst the next existing one-minute recovery observes it. No new unbounded spin or lost continuation may result from either entry.
- Child deletion remains at most `p_limit` pages and identities per invocation and at most 32 root removals, as today. Preserve fairness for partially evicted large roots. Do not introduce a cascading unbounded delete.

At 6,763 stable roots / 128 IDs per page, one sweep needs about 53 page invocations; with one-second continuations plus the one-minute wrap pause, a newly eligible previously visited root is revisited in roughly two minutes when the worker runs on time. This is a scheduling estimate, not a production SLA. It also implies roughly 1,700 sweep invocations and 217,000 root eligibility visits per hour at that static size, versus 966 recorded compaction-function calls in the observed hour. The inputs and functions are not perfectly equivalent, but this exposes a real tradeoff: fewer writes may come with more reads/calls. The cursor design must beat baseline total maintenance CPU/WAL while preserving intake p95 in a matched fixture before being accepted; if it fails, revise the cadence or eligibility access design and re-review rather than shipping on the zero-root-write metric alone. At larger populations the sweep duration grows: record complete sweep duration and retention lag, test 10× roots, and reject the design if bounded servicing cannot keep up. Record exclusive advisory-lock hold time and step-acceptance latency alongside sweep throughput. Compare read work and WAL as well as root updates; moving churn to another table is not sufficient.

Migration safety: preserve function signatures/return types, root IDs, indexes, and old application behavior. New function definitions must work while old binaries call either compact entrypoint. Create state before replacing functions. Use a migration lock timeout and retry off peak if necessary; no long backfill of root rows. Application rollback can leave additive state/functions installed. If a function rollback is necessary, use a separately reviewed forward migration restoring the captured prior definitions; never delete capture data to roll back.

Gate: in a static pinned/current-root fixture run several complete sweeps and observe **zero maintenance UPDATEs to retained root rows**, identical retained data and bounded eligibility visits. In mixed fixtures prove eventual eviction after unpin/expiry/revision change, including an eligible root behind thousands of retained roots, concurrent pinning, cursor rollback/restart, empty tables and roots inserted behind the cursor. Test root-only full-page continuation through the real summary wake coordinator, plus mixed direct/scheduled invocation. Verify HTTP capture acceptance → real workers → public outcome remains identical after compaction and settlement. Database-function unit tests may supplement this for lock/cursor states unreachable through HTTP, but cannot replace public-path tests.

## 6. C — Remaining planning-heavy queries

Measured query IDs below are labels for this captured server/schema, not stable application identifiers. Cumulative times are seconds.

| Query ID | Calls | Plan / execute | Source and decision |
| --- | ---: | ---: | --- |
| -1687289925696922947 | 2,903 | 26.29 / 16.69 | `races/models/raceResolutionPostTask.js:607`: completion CTE; candidate queue annotation; preserve lease CAS and receipts |
| 1071297736453479090 | 2,784 | 22.26 / 2.28 | same file:787 readiness; candidate read annotation; no new stale health cache |
| 4282444812282879035 | 1,124 | 19.78 / 4.96 | `steps/services/viewerActiveEventReadBatch.js:11`: already prepared; diagnose custom plans/replanning before altering SQL |
| 6841737838904097609 | 527 | 14.46 / 9.14 | `races/models/race.js:1493`: public discovery; finite parameterized shape variants, preserve capacity filtering before LIMIT |
| 5723303746123343229 | 1,274 | 14.07 / 8.31 | `races/queries/attachRaceViewerState.js:20`: batched viewer overlay, variable IN-list shapes; stabilize binds before admission |
| -5757165851224697633 | 527 | 14.06 / 1.21 | `tournaments/models/tournament.js:246`: discovery; same ordered result/eligibility required |
| -4853610946093832639 | 2,489 | 13.29 / 3.81 | ORM membership read joining races; do not globally prepare arbitrary generated SQL |
| 8848607619802314609 | 1,420 | 12.83 / 1.31 | `races/models/raceResolutionJobV2.js:436`: full-trigger drain; preserve locks/coalescing |
| -8976339683536897065 | 673 | 11.61 / 10.07 | `raceResolutionQueueV2.js:1405`: seeded preparation eligibility; preserve admission ordering |
| 1996760223335283247 | 478 | 10.20 / 0.27 | `steps/jobs/globalEventSummary.js:482`: next deadline, no bind parameters; use existing queue prefix for stable zero-parameter shape after adapter verification |
| 8605791111692563674 | 4,792 | 10.00 / 0.57 | `races/models/raceSnapshotRepairIntent.js:54`: unannotated repair claim UPDATE; candidate queue preparation, preserve 30-second lease CAS |

For each candidate record exact text variants, adapter admission, pool identity, named/custom/generic executions, stats invalidations, calls and plan+execution cost. The source has 21 annotation occurrences, but this is **not** a runtime count of admitted shapes: interpolated variants and multiple pools matter. Do not increase the 128-name budget or change PgBouncer settings as a shortcut.

The viewer-overlay query is already one read for the response, not one query per race. Its `Prisma.join(ids)` varies SQL text with list length. Experiment with a typed array bind (`id = ANY($1::text[])`, viewer bound separately) and a single prepared shape while keeping the existing response-list bounds; test rematch and subscription permissions for different viewers, missing races and completed/active/pending lists. Do not cache viewer state in shared race fragments.

First take post-task completion/readiness and summary-deadline lookup; use the gate in A. Discovery and remaining shapes follow individually. Already-prepared active-event queries can legitimately custom-plan or replan after ANALYZE; cause is not established by their elapsed totals. Retain the indexed lateral and membership gates from the previous correction. No automatic ORM-to-raw rewrite without exact public response/authorization tests.

## 7. D — Notification recovery and delivery

Source: `src/modules/notifications/jobs/notificationCompletenessReconciler.js`, five-minute recovery interval, page size capped at 500, immediate continuation on a full page.

Two retained repair shapes are disproportionately expensive: missing alert/PUSH-outbox recovery (`-3019060856448485391`) ran 12 times / 38.85 s; missing device-snapshot recovery (`5905907237468152565`) ran 9 times / 15.23 s. An output LIMIT does not bound rows inspected before the anti-join. Exact scan plans and rows examined for these UPDATEs were not collected in the hour; broad scanning is a source-supported hypothesis requiring a test plan.

Test-first experiment: mirror the SELECT candidate portions in disposable PostgreSQL 18 with healthy historical populations plus missing records near the end. Capture EXPLAIN ANALYZE BUFFERS there; never execute production UPDATE under EXPLAIN ANALYZE. Increase unrelated/history population 10×. After SELECT experiments, benchmark the complete recovery UPDATE in disposable transactions, including admission-lane contention and actual changed rows. Lower candidate SELECT buffers alone do not prove lower mutation cost. Compare existing query with (a) candidate-first materialization plus indexed lateral probes, and (b) a persisted fair keyset recovery cursor if (a) still rescans all healthy history. Do not choose (b) based on returned-row limits alone: the previous experiment failed that criterion.

Implementation gate: lower buffers/total time across healthy, gap-heavy and sparse-gap distributions, eventual discovery of gaps beyond several healthy pages, and no lost recovery across cursor wrap/restart. If a cursor is necessary, revise this section with its exact schema, recovery-latency bound and mixed-version migration before implementing that option. This is a technical experiment branch, not an unresolved product requirement.

Preserve admission-lane lock ordering, notification type isolation, delivery keys, source revisions, cooldown claims, receipts, terminal statuses and retry/at-most-once distinctions. Recheck candidate eligibility in the mutation transaction; never rearm a task made healthy between page selection and update. Public Inbox and provider-attempt fixtures must show no duplicate delivery and no newly suppressed required message. Keep the durable five-minute recovery fallback.

Bulk outbox/recipient inserts already ran 656 times each (27.33 s and 17.85 s execution); the bulk silent-placement claim ran 1,095 times / 20.27 s. Treat these as volume/index/lock measurements, not an N+1 defect. Trace rows per batch, rows per accepted domain event, duplicate event keys and retries before proposing further coalescing. Do not merge distinct user-visible events because they share a recipient.

## 8. E/F — Race input, queue and publication work

`raceResolutionInputFingerprint.js:30` performs four SELECTs per full fingerprint: race/roster, input versions, effects, event eligibility. Two full fingerprints therefore imply eight SELECTs **when that path executes**. The hour's 19,764 family calls are not a count of 19,764 resolutions. The worker already reuses planning-loaded models, shares source fences with closure validation, and omits names only on the compatible full-source fence. Closure digests still require names.

`getRaceProgress.js` contains HTTP fingerprint A/B validation; `raceResolutionQueueV2.js` validates planning, source/artifact generation, configuration and time boundaries before writes. `computePersistedSnapshot` rereads committed context; it does not rescore the whole race. `stepSample.js:142` uses bounded batched input ranges. Preserve these distinctions.

After approval add a bounded, test-only observer to the normal HTTP/cron/resolution entrypoints. Attribute SELECT/INSERT/UPDATE/DELETE, utility commands, rows, jobs, retries and phase durations to a synthetic request and its downstream generations. Use the existing query-efficiency observer pattern; never log real bind values. Production `sqlCount` is optional instrumentation, not proof that a zero/missing value means no SQL.

Fixture matrix: repeated identical sync; changed sync; one user across several races; disjoint users; same-race bursts; event boundary with unchanged totals; artifact hit/miss; Redis outage; lease expiry; notification repair; settlement. Include thousands of synthetic simultaneous syncs with bounded admission and actual existing worker concurrency. Capture warm/cold source caches separately and repeat under identical fixture state.

Select changes only when attribution proves duplicate work within the same valid snapshot/generation. Reuse already-loaded immutable models inside that scope; keep the independent fresh commit check. A candidate four-read-to-one-read fingerprint envelope must prove identical digest/null/order semantics and bound scanned data; combining parallel reads can alter snapshot semantics and must not weaken the fresh fence. It is not pre-approved solely to reduce round trips.

808 zero-changed resolutions can still advance generations, refresh display boundaries, complete summary obligations or publish durable outcomes. Classify reason and effects before claiming waste. Existing queue enqueue is set-based and suppresses covered input; three independent lanes still need durable recovery. Preserve debounce/deadline behavior and no-lost-wakeup proof before removing empty probes.

Post-task readiness currently has at most a one-second positive cache when explicitly requested, checks claim-probe freshness at 60 seconds, and rejects lag >=30 seconds or expired attempts. Prepare its SQL before introducing more caching. Preserve terminal CAS, lease ownership, publication handoff, failure disposition and receipts; a successful database commit must remain recoverable after process failure.

Acceptance: retained step totals, progress fields and settlement outcomes match baseline under old/new client headers; no missed effects or stale generation commit; no rise in retries/queue lag; selected duplicate path shows explicit before/after SQL+job accounting. If no duplicate is proven, close that item as investigated with no change. Do not invent a whole-app SQL-per-sync ratio from the monitoring totals.

## 9. G — Operational counters

`globalStepEventObservability.js:8` loops over nonzero metric deltas and performs one upsert per metric in callers' existing transaction. At most one SQL statement can replace K per-call metric upserts using a bound JSON recordset and INSERT ON CONFLICT increment, ordered by the producer's existing ordinal to preserve lock order during mixed-binary deployment (alphabetical order would invert the existing scoringQueries → scoringLatencyMs locks). Retain current rounding, nonnegative filtering, bigint values, creation/default timestamps and atomic rollback. Do not buffer across requests or move durable counts into Redis.

This reduces K round trips to one when K>1; it still updates K metric rows. For single-metric calls there may be no benefit, and the measured 10,748 row updates will not disappear from batching alone. Measure call-size distribution before prioritizing. Do not claim that batching eliminates vacuum churn on the 13-row counter table.

The broad `captureOperationalSnapshot` query is behind the scheduler's missing-required-event-days path (`globalStepEventScheduler.js:131` returns early otherwise). It was not found in the retained mapped-query ledger. That mapping has eviction/coverage limits, so absence is not proof of never running; there is no basis to label it a continuous cause of this hour's CPU. Benchmark its history scaling only if future measurements show it material.

Tests: real event enrollment/entitlement paths emit exact counters for success, duplicate, rollback and concurrent updates; supplemental arithmetic tests only where needed for unreachable input edge cases. No changed entitlement/scoring behavior.

## 10. H/J — Trustworthy telemetry and monitoring

`eventSurgeTelemetry.js:118` labels snapshots with floor(actual flush time)-one minute. An early timer at `:59.999` therefore labels the preceding minute and re-arms another near-immediate flush.

Track an explicit interval start and scheduled deadline. If the callback fires before the deadline, re-arm the remaining delay without clearing counts. At/after the deadline, detach the current state synchronously, record actual interval start/end and scheduled deadline, replace the state, then await publication. Delayed event-loop callbacks must not pretend their accumulated counts belong to a precise one-minute interval. Preserve existing fields for log consumers, add explicit actual interval fields and an interval identity, and document first-start/manual-flush partial windows. Consumers must use actual intervals when longer than a minute; no invented split of aggregate counts.

Tests with deterministic clock/timer seams cover `:59.999`, exact boundary, delay across several minutes, startup mid-minute, manual flush, concurrent requests during asynchronous publish, publish failure, and stop. Timer math is suitable for unit tests; also assert a real HTTP request appears exactly once in emitted counts. Emit zero-traffic intervals intentionally once, not as duplicate boundary flushes.

Future observation: managed DB CPU every ~30 seconds, activity every ~10 seconds, completed pg_stat_monitor buckets incrementally, table counters every five minutes. Retain resets, deallocations, coverage gaps and diagnostic application names. Never reset shared statistics. Read raw normalized pg_stat_statements shapes only; do not retain raw unnormalized pg_stat_monitor SQL. Use read-only transactions and local five-second timeouts. Keep collector overhead reported separately and ensure collectors stop at the requested end.

## 11. I — Host pressure and capacity boundary

CPU steal is outside application query execution. Available RAM was 234–457 MiB; end swap use about 769 MiB; zram read/writes were 1,307/1,496 MiB. These establish host contention and active compressed-memory traffic, not exact compression CPU or a guaranteed resize benefit. PgBouncer averaged 3.78% process CPU, already included in the host total.

After application improvements, compare direct managed CPU mode deltas, paging throughput, available RAM, DB sessions, workload and lag under comparable demand. Prepare a provider-support evidence packet with timestamps/plan size and aggregate metrics; sending a ticket or changing capacity requires separate authorization. Investigate persistent steal with DigitalOcean and evaluate memory/CPU capacity only with residual evidence. Do not change work_mem, shared_buffers, connection counts, statistics settings or vacuum settings speculatively. Preserve exactly two production HTTP workers and the existing cron/resolution capacity.

## 12. API, frontend and compatibility contract

There are **no new or changed API contracts**: no request/response JSON or error codes are added or removed. Existing step acceptance/idempotency, progress/bootstrap/discovery, legacy headers, Inbox ordering and error behavior are the contract. Capture representative existing responses in tests rather than inventing a replacement schema in this spec. Internal telemetry fields are additive for operational consumers only.

Frozen iOS/Android apps continue using their current routes and field shapes. No frontend implementation or build is needed for this backend-only scope; no missing-field dependency is introduced. Verify legacy `X-Client-Features` and absent-header behavior through real HTTP. No UI-placement plan or game-balance review is applicable because placement and scoring rules do not change.

## 13. Test-first implementation order and acceptance

1. Record clean baseline and exact source/migration versions in an isolated checkout; preserve unrelated docs and server package-lock changes. Verify dedicated localhost/disposable `_test` DB before any tests. Use PostgreSQL 18 matching production as closely as available plus transaction-mode PgBouncer; never production or staging for tests.
2. Write failing regressions and retain baseline experiments for A, B and H. Implement A and H as independent changes. Implement B with its migration and compatibility/concurrency tests. No index is required in advance by this spec.
3. Write/run C's individual experiments and take proven shapes. Run D's scan experiments before selecting its rewrite; record rejected options as well as wins.
4. Complete E/F path accounting; select only demonstrated duplicate work. Evaluate G using observed per-call metric count. Each selected change needs tests failing before implementation.
5. Existing suites to extend/reuse: `query-efficiency-resolution`, `race-resolution-planning-input-reuse`, `race-resolution-memory-reuse`, `durable-capture-compaction-cadence`, `durable-capture-terminal-cleanup`, `durable-capture-root-budget`, `global-event-capture-fact-reuse`, `race-resolution-post-task-storage`, `summary-notification-cpu`, `centralized-notification-delivery`, `query-efficiency-notification-parent`, `step-intake-legacy-contract`, and read-only progress/cache boundary suites. New performance assertions must execute the real HTTP/worker path. Do not weaken existing assertions. Historical reports contain baseline failures; re-establish them on the actual implementation baseline instead of treating them as current passes or permanent waivers.
6. Run appropriate `npm run test:integration` and `npm run test:unit` checks with the guarded test DB (never bare npm test). Use three matched repetitions per performance distribution, unchanged fixture scale, warmup, worker count, instrumentation and pool config. Reset only disposable fixture state between runs. Compare CPU seconds where available, buffers, WAL, writes, SQL/job counts, queue age and p95 response latency.
7. Required code review after implementation. No performance claim passes on wall time alone when buffers/writes or queue backlog worsen. All correctness tests must pass or failures be explicitly surfaced; no result-changing optimization can ship with unresolved correctness failures.
8. Produce a deployable reviewed result, then obtain fresh production deployment/migration approval per AGENTS.md. Apply additive migration before application changes that need it. Keep previous binaries compatible. Retain normal rollback deployments; no runtime flags. Re-verify prepared support before rollout without changing provider configuration.
9. Following separate deployment approval, perform a comparable hour watch with the same metrics. Show achieved idle CPU versus the 70% target, traffic composition, host steal and paging changes. A quieter hour does not prove optimization. If workload is unmatched, report per-work metrics and leave whole-host savings unproven.

Implementation owner is backend; frontend responsibility is compatibility review only. The spec workflow's later implementation-agent orchestration must not manufacture Flutter edits. All technical experiments have explicit accept/reject gates; no product clarification is needed to finish this planning scope.

## 14. Revision log

- Draft: cross-checked measured families and deployed source, retained precise query IDs and distinguished host CPU from elapsed query time.
- Gap pass 1: incorporated existing query-efficiency and summary-wake fixes; removed assumptions that source loads, bulk outbox writes and zero-changed jobs are inherently duplicate. Added the previously unsuccessful notification cursor experiment and its scan gate.
- Gap pass 2: made retained-root sweep fairness, cursor rollback, old direct compact callers and scheduler busy-loop avoidance explicit; corrected counter batching expectations (round trips, not row updates); added prepared-prefix whitespace, custom-plan invalidation and delayed telemetry windows. Added test DB, old-header, migration and production approval gates.
- Architect review, first pass: required preserving forced direct compaction and making deadline propagation/lock ordering explicit; both incorporated. Also added complete notification UPDATE benchmarks, maintenance lock-hold measurements and root-only wake-coordinator coverage. Architect re-review: APPROVE; no remaining required changes or suggestions. Final editorial pass added the estimated sweep read/call amplification and an explicit total-cost rejection gate.

## Technical references

Prepared plans may remain custom and are invalidated by relevant schema/statistics changes; use session-local evidence and representative distributions: [PostgreSQL 18 PREPARE](https://www.postgresql.org/docs/18/sql-prepare.html). Protocol-level named preparation in transaction pools requires PgBouncer support and consumes a bounded statement working set: [PgBouncer configuration](https://www.pgbouncer.org/config.html#max_prepared_statements). Host/statistics accounting references and retained measurements are linked in the original hour report.
