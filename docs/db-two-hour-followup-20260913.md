# Two-hour database monitoring follow-up — September 13, 2026

Investigation only. Current local and production HEAD: 17c8983. No application code, production data, indexes, settings, services or capacity changed. Probes used BEGIN READ ONLY and transaction-local five-second statement and one-second lock timeouts. EXPLAIN ANALYZE was limited to SELECTs. No synthetic traffic or tests ran.

## Captured workload

DigitalOcean host samples cover 04:39:51–06:39:51 UTC. Query collector ended 06:40:04 UTC; completed windows total 7,178.902 seconds (the last partial window is absent). CPU sample means: idle 64.59%, user 19.60%, system 12.29%, I/O wait 0.54%, steal 1.00%. Idle was below 70% in 72.6% of samples. Query-rate/non-idle correlation across matched minute windows is 0.35; this does not establish causation.

Recorded statement deltas: 406,993 calls, 611.61 seconds execution elapsed, 4,944,756 returned rows. Calls include instrumentation and possible nested work, not HTTP requests. Stats reset unchanged; eviction counter rose 247→249. New/unmatched or restarted entries contributed 698 calls and 22.83 seconds; collector treated their current counters as deltas, so exact interval attribution is uncertain for these entries. Matching rows account for 406,295 calls. Monitoring queries containing pg_stat_ accounted for 22.72 seconds (3.72% of recorded elapsed); this is not total instrumentation CPU. pg_stat_statements planning tracking and I/O timing remain off in the live probe.

The managed host used compressed swap: zram read bytes increased 1,291,087,872 and write bytes 1,411,694,592 across the capture. Available memory was 324 MiB initially and 383 MiB finally. Low disk wait does not exclude compression/memory overhead. These counters do not quantify compression CPU or prove a resize is needed.

## Global-event maintenance: confirmed repeated discovery

Source: src/modules/steps/jobs/globalStepEventScheduler.js, src/modules/steps/models/globalStepEvent.js, src/modules/steps/services/globalStepEventEntitlement.js.

The minute scheduler loads all future/active or unfinished local parents, then calls materializeEntitlementsForActiveRacers separately for each parent. Each call rebuilds the distinct active-racer cohort before checking missing entitlements. Paging is bounded at 500 candidates with a five-second per-tick materialization budget; discovery restarts on each minute tick. Even an empty candidate result enters a transaction and checks generation/publication/counter paths. Do not equate every returned candidate with a newly created entitlement: timezone/window checks occur afterward.

Capture: parent discovery 120 calls, 16.38 seconds, 2,810,798 shared buffer hits, 519 returned parent rows. Enrollment discovery 519 calls, 25.55 seconds, 1,381,967 hits, 1,008 returned candidate rows. This is consistent with one enrollment discovery per returned parent in this window, not proof of individual request linkage.

Fresh bounded plan: parent lookup returns five future parents, but checks 23 older parent entries, removing approximately 993 entitlement rows per loop. It uses event_id-leading recovery index then filters processed state: 23,424 shared hits and 31.15 ms. Existing pending indexes lead with time, not event_id. A partial event_id index for rows with either unprocessed boundary is a plausible targeted candidate, requiring local benchmark/migration review; no index was created.

Splitting the OR into two correlated EXISTS clauses doubled buffer hits to 46,845 and took 41.47 ms. Gathering pending parent IDs once using existing partial indexes reduced accesses to 10,107 buffers but took 38.18 ms with 118 reads. These single probes are not controlled benchmarks and do not prove a speedup. Do not ship either rewrite based on these results.

Fresh enrollment plan rebuilt 1,009 distinct users from 2,619 participant rows across 166 races, then returned zero candidates. About 2,932 buffers and 9.7–11.1 ms per probe. Sharing bounded cohort discovery across parents could eliminate repeated race/participant scans; missing-entitlement eligibility, authoritative timezone rechecks, sorted locking, per-parent paging/fairness and late joins must remain correct. With five parents the idealized cohort-build count becomes one rather than five, but this is a design estimate, not measured total query/CPU savings.

## Step history: existing optimization is already deployed

Source: raceScoringPrefetch.js → historicalRawSampleCache.js → StepSample.findRowsForUserRanges. The SQL already batches up to 25 user ranges, returns a narrow row shape, and pages at 50,000 rows. Current deployment already shares protected historical raw segments through Redis and reloads recent data; prior research proposing this is superseded by deployment.

Capture: 1,849 calls, 1,491,295 returned rows, 46.81 seconds executor elapsed (about 807 rows and 25.3 ms per call). This is residual work after caching, not evidence all those rows were avoidably historical.

A separate bounded tail of current worker logs contained 47 consecutive telemetry records for one PID. Differences between first/last: 664 hits, 3,169 misses (17.3% hit fraction among these recorded lookups), 164,835 reused rows, 87,472 recent rows read on hits, 869,543 full rows read on misses, one proof-race rejection. This is newer telemetry, not timestamp-aligned with the original capture; the lines lack timestamps. Counters omit entirely bypassed batches, so this is not the overall cache hit rate.

Cache identity includes user, exact requested start, cutoff and historical revision, with a ten-minute TTL. Misses also include ineligible proofs, absent/malformed/oversized entries and budget limits. Current telemetry cannot separate these causes. The useful next measurement is a bounded breakdown of misses and overlapping coverage before changing TTL or coverage reuse. Preserve old-step corrections, removed/moved intervals, cross-cutoff rows, Redis failure fallback and before/after generation checks. Do not claim concurrency is the main cause from one recorded proof-race rejection.

## Worker polling: lower-priority reduction

raceEffectDeadlineScheduler runs every second and on every resolution wakeup, with an in-process overlap guard. Each tick checks due effects, progress refresh intents and snapshot repair intents. The three statements each ran 7,948 times (23,844 total, 5.86% of all captured calls); refresh returned zero rows, deadlines 107 and repair claims 175. Together they recorded 1.117 seconds execution elapsed (0.18% of the total), so high frequency alone does not make them a demonstrated major CPU source. Wakeups help explain exceeding one tick per second; no duplicate-worker conclusion follows.

Coalescing unrelated wakeups, sharing due checks or scheduling the next deadline may reduce round trips/planning, but must preserve expiry latency, durable recovery and timely snapshot repairs. Merely slowing all polling changes behavior. The expired-race repair loop identified in separate earlier research is already fixed in current production; do not present it as an outstanding implementation.

## Recommended order and limits

1. Benchmark a pending-parent lookup index and shared bounded enrollment cohort discovery. Most concrete confirmed repeated-scan opportunity; retain event behavior and old-client responses.
2. Attribute residual raw-cache misses, then target measured avoidable reloads. Existing safe historical reuse must remain intact.
3. Reduce idle polling only with preserved deadlines and recovery, measuring end-to-end host CPU plus planning/round trips.

Global-event queries above account for about 6.9% of recorded execution elapsed; the step query about 7.7%. Neither explains all host CPU. No measured host-CPU saving, capacity multiplier, or guarantee of reaching 70% idle is established. Follow-up implementation requires tests first on a dedicated test DB and code review. Deployment requires fresh authorization.

Evidence: docs/evidence/db-two-hour-followup-20260913/read-plans.jsonl. Original capture remains in production /root/db-observe-20260913T043949Z. Additional SELECT rewrite probe remains /tmp/bara-global-probe2.js on the server. Diagnostic scripts do not load application services or invoke application mutations.
