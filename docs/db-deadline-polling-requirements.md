# Deadline scheduler database-work reduction

Status: architecture-reviewed development spec; awaiting user implementation approval. Part of db-work-reduction-requirements.md. Backend only; research baseline 17c8983.

## Summary and user story

As a racer, timed effects and failed live-display repairs must converge promptly even during step-sync bursts or Redis failure. Reduce empty scheduler database work without changing expiry, scoring, publication, settlement or recovery behavior.

## Research and scope

raceEffectDeadlineScheduler.js:16,76-77,110-136 runs one pass each second and on resolution wakeups. Each pass separately discovers due effects, refresh intents and claims repairs. The captured three statements each ran 7,948 times, together 23,844 calls, only 1.117 seconds executor elapsed. This targets round trips and repeated empty commands; no material CPU saving is proven.

In scope: a combined bounded read-only discovery, conditional existing drains, and lossless burst coalescing. Out: slower periodic polling, new wake message requirements, expiry semantics, queue capacity, repair policy, next-deadline sleeping, adaptive runtime controls. The expired-ACTIVE race repair fix is already deployed and remains protected.

## Implementation design

1. Add `peekDueSchedulerWork({limit=100, afterRaceIds=[], traversalCursor=null, saturated=false})` in raceEffectDeadline.js, exposed alongside existing methods. One parameterized SELECT always returns exactly one result row (empty effects array if none) containing up to 100 due effect_id/race_id pairs in deterministic deadline order plus booleans `refreshDue` and `repairDue` using EXISTS. Apply existing undispatched/deadline/busy-race predicates to effects; refresh uses available_at; repair uses terminal_at, available_at and lease expiry. Database statement time, not process time, determines due work. Keep the five-second busy-race lifetime and 1,000-entry bound, but do not rely on eviction alone for fairness. On saturation, retain a composite `(deadline_at,race_id,effect_id)` traversal cursor and in the same discovery reserve 50 slots for oldest-first head and 50 for keyset tail, deduplicated to <=100 effects. Advance tail from the last inspected tail candidate even after unsuccessful dispatch; wrap on exhaustion, rechecking head every pass. Return internal deadline_at/cursor metadata as needed. Expired exclusions retry normally; newly inserted earlier rows remain eligible to the head half. Saturation mode ends only after a full tail wrap with exclusion usage below the bound. No unbounded remembered IDs. Test an eligible race behind >1,000 busy/inapplicable races and prove it is visited while earlier rows continue retrying.
2. Return an internal object `{effects: [{effect_id,race_id,deadline_at}], refreshDue: boolean, repairDue: boolean, nextTraversalCursor: {deadline_at,race_id,effect_id}|null, tailExhausted: boolean}`. No HTTP field is introduced. Validate unexpected/missing results as an error and retry through periodic scheduling; never interpret malformed discovery as a durable empty state. Preserve injectable existing model interfaces for old internal callers/tests without weakening assertions.
3. Scheduler dispatches discovered effects through the existing per-race transaction and C0 fence. No effect rows are claimed in discovery. Preserve locked revision/deadline/status validation and 100-row cap inside dispatchRace. Concurrent schedulers remain safe through existing fences.
4. Call existing drainProgressRefreshIntents when refreshDue is true OR any effect dispatch succeeded. Call existing drainSnapshotRepairs when repairDue is true OR dispatchedRaces > 0 OR refreshAdmitted > 0. Keep their authoritative discovery/claims and per-row lease checks; do not preclaim repairs before potentially slow effect processing. This deliberately retains some non-empty-path queries to preserve ownership and timing.
5. A false advisory boolean does not acknowledge any record. New rows after discovery remain durable and are found by the unchanged one-second fallback. Redis messages remain best-effort hints. Do not add a shared negative cache or cache these booleans across passes.
6. Replace dropped wake-while-running signals with one pending-wake bit. Many wakes during a pass collapse into at most one scheduled follow-up; a follow-up can set its own pending bit only for newly received signals. Use setImmediate/one scheduled handle to merge same-turn bursts. Do not recursively execute synchronous passes, start overlapping passes, or repeatedly requeue an idle pass without a new signal/timer. A failed pass must release running ownership and allow the next periodic retry.
7. Preserve one-second timer, health once per minute, startup recovery and five-minute census/recovery. Stop cancels scheduled handles, unsubscribes and awaits an in-flight pass; no new pass begins after stopped. Recovery has its own running promise and one pending bit; serialize startup/five-minute recoveries because they share cursors. Stop suppresses pending recovery, then awaits both active pass and active recovery within the existing application shutdown deadline; it does not extend that deadline. Test stop during startup recovery and a five-minute signal during slow recovery.
8. Aggregate fixed-label telemetry: passes by trigger, coalesced wakes, empty/nonempty passes, discovery queries, drains invoked, elapsed distribution and oldest due age. Reuse coordinatedOptimizationMetrics/capacityPhaseMetrics; no identifiers in labels, new DB writes or per-record logging.

## API, data model, frontend and compatibility

No HTTP endpoints, request/response JSON, error status, schema, Redis channel or existing wake payload changes. Existing `{queue:'resolution',workKind:'ordinary'|'full-trigger'}` remains sufficient. Old backend writers and trigger-created repair/deadline records remain discoverable without any new notification. Both frozen iOS and Android clients receive existing API shapes and authoritative timing/score results. No frontend edits, builds, loading/error state changes or UI placement changes. No feature flags.

## Tests first

Add test/integration/race-deadline-scheduler-work.test.js using real HTTP activation, a real background worker process and real test PostgreSQL and local isolated Redis db15. Extend the existing worker harness rather than importing an internal utility to bypass the public lifecycle. Existing race-effect-deadlines.test.js assertions stay intact. Include separate Redis-unset worker runs. Pin the frozen-client X-Client-Features header from existing legacy fixtures as well as current headers; assert effect expiry, slot counts and scores in the actual HTTP response.

- Idle timer runs: capture actual SQL from dedicated worker connection; one discovery SELECT per pass, zero empty repair UPDATEs and no refresh SELECT; minute health/recovery queries counted separately.
- Burst wakes: hundreds of real Redis messages during controlled slow DB work; no overlapping pass, at most one queued follow-up, eventual newly due work, and no unbounded empty loop.
- Redis disabled/disconnected, lost wake and legacy SQL effect extension: one-second polling discovers records; latest effect revision wins; HTTP progress reflects proper active/expired effect and slot count.
- During saturated traversal, extend an effect across the cursor and prove latest-revision rediscovery after wraparound. Two schedulers, duplicate wakes and crash between discovery and dispatch: one delivered revision, no duplicate generation/event reward, rollback leaves durable work pending.
- Rows inserted immediately after a negative discovery: discovered next periodic pass; no permanent negative caching. Exercise refresh and repair triggers independently.
- Busy C0, retry backoff, existing minimum_committed_generation/request UUID/last-timezone semantics, expired repair lease, healthy live-race repair, and expired ACTIVE/pending/completed races keep current behavior.
- Stop during pass and immediately before scheduled follow-up: await shutdown, no new SQL after termination. Pure state-machine timer cases may use unit tests only where public worker tests cannot express ordering precisely; retain real-worker outcome coverage.

Test commands: npm run test:integration with configured suite selection and verified dedicated *_test URL; npm run test:unit (never npm test). Never use production for tests. Frontend validation: flutter analyze required by project done checklist; no native build needed for backend-only work.

## Benchmark and acceptance

Compare baseline and candidate with same synthetic fixture on test DB: 60 idle passes; 100 due effects; >100 due effects across races; refresh-only; repair-only; mixed busy work; 1,000-user sync/wake burst. Count discovery, dispatch, refresh, repair, health, recovery, transactions and downstream worker work separately.

Idle acceptance: 3 discovery/empty-claim commands → 1 read, 66.7% fewer among those commands; no polling interval increase. Busy acceptance: same HTTP outcomes and no lost work; no extra writes/claims merely from discovery. Under an unloaded deterministic timer, an item committed just after a pass must begin discovery on the next one-second timer, allowing explicit test scheduling tolerance. Compare p50/p95 deadline-to-dispatch under matched load; reject >5% repeatable p95 deadline-to-dispatch regression across at least ten paired runs, or any starvation. Do not claim 66.7% total DB or CPU reduction.

Backend developer owns these files and tests; after approval code-reviewer must review. Deploy backend only after separate authorization, retain exactly two HTTP workers and current dedicated workers; staging stays off. Rollback application code; no persistent data rollback required.

## Revision log

- Draft: separated measured call reduction from unproven CPU reduction; selected advisory discovery rather than moving repair claims earlier.
- Gap pass 1: kept repair claims in their existing drain, preserved one-second fallback and protected next-pass work arriving after advisory discovery.
- Gap pass 2: added bounded busy-race state, shutdown/Redis-loss/legacy-writer tests and full downstream accounting; no economic timing changes.
- Architect review: required changes incorporated—bounded head/tail traversal under exclusion saturation, serialized awaited recovery, explicit frozen-client/Redis-db15 tests. Also pinned single-row discovery and exact drain conditions. Final re-review: APPROVE.
