# Shared bounded global-event enrollment discovery

Status: architecture-reviewed development spec; awaiting user implementation approval. Part of db-work-reduction-requirements.md. Research baseline 17c8983.

## Summary and research

As a racer, I receive the same scheduled local-event entitlement even when many races/users become eligible together. Reduce repeat active-cohort discovery and empty transactions without changing eligibility or the instant a local window becomes too late to enroll.

Current globalStepEventEntitlement.js:450–615 rebuilds a materialized active-user cohort per parent/page. globalStepEventScheduler.js:83–107 processes these sequentially with a five-second budget. Captured: 519 discovery calls, 25.55 seconds, 1.38 million shared hits, 1,008 returned candidate rows. A fresh empty-result plan loaded 2,619 participant rows over 166 races to deduplicate 1,009 users. Current writes are already batched; do not reintroduce per-user queries.

## Scope and design

### Batch discovery

Add a model-layer `discoverEnrollmentPages(parents)` helper in `src/modules/steps/models/globalStepEventEntitlement.js`, exported through the established model interface with optional injected database client, capped at eight `{eventId,afterUserId}` inputs and 500 missing candidates per parent. Reject excess inputs rather than silently truncate. Use one parameterized SQL statement:

- One MATERIALIZED active_users CTE with the current active race, accepted participant, unfinished and non-forfeited predicates and distinct user IDs.
- A bounded parent input relation and one LATERAL missing-candidate page per parent: that parent's cursor, event/user NOT EXISTS anti-join, user-ID order, THEN LIMIT 500. Applying LIMIT before the anti-join is forbidden.
- Join user fields only after candidate selection. Return explicit empty pages as well as populated pages; output capped at 4,000 candidate rows. Do not load the full cohort into JS or Redis. No persisted membership cache.

Internal return: `[{eventId,candidates:[{id,timezone,globalEventTimezone}],nextCursor,exhausted}]`; nextCursor is last candidate or prior cursor, exhaustion is candidate count <500. A page of 500 must be followed to establish exhaustion even if it creates zero rows. Maintain the existing single-parent API as a delegate to the same discovery/writer logic, not a second algorithm.

PostgreSQL evaluates a materialized CTE once per statement; it can also restrict pushdown, so the actual plan must be benchmarked. [PostgreSQL 18 WITH documentation](https://www.postgresql.org/docs/18/queries-with.html).

### Preserve the writer

Extract the existing per-parent candidate-writing portion without changing transaction scope. Empty candidates return `{created:0}` before opening a transaction: no enrollment lock, generation query, zero-valued counter upsert or scheduled-event operation. Nonempty candidates retain sequential per-parent transactions, global enrollment lock, authoritative user/timezone reread and decisionNow AFTER lock acquisition, strict future-start eligibility, unique event/user identity, generation readiness, immutable facts, scheduled outbox/receipt coupling and current invalidation.

Do not batch parents into one larger transaction or parallelize writers. Discovery is advisory and may become stale; preserve current boundary/membership revalidation contracts, not a new cached authorization. Dedicated late-join paths remain unchanged. Missing generation readiness does not suppress entitlement creation when current behavior creates it without generation-two obligations.

### Bounded scheduler and fairness

Refactor globalStepEventScheduler.js controller, keeping one owner and current overlap/shutdown semantics. `buildMaybeStartGlobalEvent` must construct its local tick once in stable scope, not on every invocation.

- Maintenance parent discovery uses eight-row keyset pages ordered by `(starts_at,id)` with the unchanged eligibility predicate; the tie-breaker makes equal starts deterministic. Index lookup spec remains independently useful. Query target event days separately with a fixed two-day IN lookup; never infer target-day absence from one truncated maintenance page.
- Keep two bounded lanes: a fresh-head pass requested each minute and a retained tail sweep. Each lane holds at most eight parents with user cursors plus one parent-list cursor (maximum 16 parent states). Head pass visits each parent once at null user cursor, then advances its parent page even if that first user page is full; tail sweep resumes missing-candidate pages independently. Alternate one bounded discovery/write round from each runnable lane; never drain an entire long tail before serving head work. Minute requests coalesce without resetting an unfinished head pass.
- Where head and tail currently reference the same parent/cursor, share the same discovered page and successful write, advancing both lanes. On a new/completed sweep, seed the corresponding tail state from the head result: exhausted head page needs no duplicate tail discovery; a full page supplies the next candidate cursor. Preserve the existing logical page observations for the small fully completed fixtures. Sharing is limited to the resident 16-parent state, not an unbounded map of all parents.
- One slice retains the existing five-second materialization budget. Check stop/budget before discovery and BEFORE EACH parent write. Discard an unwritten discovered page if needed; advance cursors only after successful write. Advance by candidate, not created count; rollback/conflict does not advance. All writes remain sequential.
- Expose one stable local controller: `runMinuteMaintenance({isStopped})` performs existing once-per-minute parent creation/audit/retention and requests head work; `runEnrollmentSlice({isStopped})` performs only bounded lane work and returns `{more,retryAfterMs}` (250 ms when more). `buildMaybeStartGlobalEvent` receives this instance rather than recreating it. Retain the existing public full-tick wrapper for callers/tests, delegating to the same controller, not duplicate SQL.
- Existing scheduleGlobalStepEvents owns one timer and three independent pending deadlines: minute, end-drain retry, enrollment retry. Never overwrite one with another: schedule the earliest due deadline; on each wake service due boundary work before minute maintenance and enrollment. Preserve any unserved lane and its deadline, coalesce duplicate requests, and schedule a future turn rather than recursive execution. `run(false)` is no longer implicitly synonymous with end-drain-only: dispatch by pending deadlines. On failure retain the applicable request with bounded retry; an enrollment failure cannot discard an end retry. Preserve independent start-boundary drain ownership and existing periodic end-drain behavior.
- A fresh-head pass completes after all bounded parent pages; subsequent minute request restarts it from the head. Tail sweep completes when all per-parent missing pages are exhausted; reset for the next sweep. New low-ID candidates have the fresh-head lane even while a tail is unfinished. A parent becoming pending behind a parent cursor is revisited in the next head pass. Record lane ages, pending minutes and per-parent service gaps. Record scheduling budget separately from actual slice duration: an in-flight transaction may outlast five seconds. Record those overruns and boundary-service latency; do not cancel a valid transaction merely because the admission budget expired.
- Restart discards advisory state and replays from the head; durable identities prevent duplicate obligations. Parent disappearance exhausts that entry. Nonadvancing cursors are errors with bounded retry, not infinite loops. Stop suppresses all pending deadlines, cancels timer, awaits active work, and prohibits another write after the current write completes.

Fairness acceptance must exercise an unfinished sweep across minute ticks. Under the specified 10,000-user/17-parent test load, including a long zero-created tail in the first eight parents, all eligible missing pairs must be visited and a lower-ID newcomer in a later parent reached through the head lane, with a target fresh-head revisit <=60 seconds. This is a benchmark gate, not a guarantee under arbitrarily overloaded infrastructure. If this gate fails, revise the bounded sweep algorithm before shipping; do not silently lengthen entitlement admission delays.

## API, storage, frontend, compatibility

No public endpoint, JSON field, status, capability header, schedule policy, timezone fallback, multiplier, prize or coin changes. Entitlements and obligations remain PostgreSQL source of truth. No new table, migration, Redis key or configuration flag for batching; optional parent index is covered separately. Old/new scheduler processes converge under existing constraints and lock order. Frozen iOS/Android clients keep working and need no binary or UI change. No UI-placement test plan applies.

## Tests first

Extend test/integration/global-event-enrollment-query.test.js, fixtures/enrollment-query/harness.cjs, local-global-step-event-entitlements.test.js and global-event-reliability.test.js through exported scheduler entrypoints/real worker controller, real DB and HTTP progress. Never shortcut the behavior by importing a private SQL helper in integration tests.

- Multiple parents with different existing users; duplicate race memberships and every excluded state; 0/499/500/501/>1000 candidates; exact-size terminal page.
- Full zero-created page of elapsed/exact-start timezones followed by future-zone candidates; cursor advances by candidate, not write count.
- More than eight parents; five-second budget before first/second writer; continuation survives minute tick; target-day query remains accurate despite truncated page; lower-ID newcomer after completed and during unfinished sweep.
- Restart/retry and two competing schedulers; rollback preserves cursor and atomic entitlement/outbox obligations; old and new producers retain current conflict-and-retry behavior.
- Timezone change and crossing startsAt between discovery/write, generation unavailable, Redis unset, concurrent membership/end changes.
- Empty discovery causes zero writer transaction/counter calls. Preserve semantic counters: zero increments removed, successful counts unchanged.
- Run start/end boundary lifecycle and HTTP progress with legacy/current headers; same event, totals and opportunities; no duplicate scheduled obligations. Shutdown with pending continuation emits no late work.

Protected tests: existing assertions at enrollment-query.test.js:68–107 and :172 retain their guarantees. The harness may mechanically project batched SQL parameters into the same logical per-parent page observations so cursor/value assertions remain unchanged; add separate actual physical SQL counters to prove batching. Do not keep a fake production legacy-query path merely to satisfy tests. If any assertion cannot be preserved mechanically, surface it before modifying it.

## Benchmark and acceptance

Baseline/candidate on identical dedicated PostgreSQL 18 *_test fixtures: observed 166 races/1009 distinct users/five parents; five fully enrolled parents; 10,000 users/17 parents; >eight parents with long zero-created first-page tails; heavy historical rows; zero-created pages; concurrent sync/boundary work. Record actual active-cohort plan loops, buffers, discovery rows/queries, user rereads, transaction/lock durations, entitlement/counter/outbox writes and downstream jobs.

Targets: observed five-parent first round builds cohort once rather than five times (80% fewer cohort evaluations for that round); empty parent pages cause zero write transactions. Target >=50% lower aggregate discovery buffers on five-parent fully-enrolled fixture without a complete-tick or boundary p95 regression >5% across repeated runs. These are proposed local acceptance thresholds, not production CPU promises. Count extra target-day/page reads and continuations; fewer statements alone is insufficient. Investigate timeouts/spills instead of raising budgets to make tests pass.

Backend developer owns these changes after approval; code-reviewer required. Relevant integration suites + npm run test:unit; test URLs verified before services load. Flutter analyze in overall checklist; no native builds. Deploy backend only after separate authorization; no staging start/capacity changes. Rollback code; no entitlement deletion or cursor migration required.

## Revision log

- Draft: one cohort per bounded multi-parent round; empty transactions removed; existing authoritative writer retained.
- Gap pass 1: added bounded parent pagination, independent two-day target lookup and resumption only after successful writes.
- Gap pass 2: preserved null-start after completed sweeps, zero-created-page advancement, public tests and fixed a potential boundary-drain starvation by priority at yields.
- Architect review: required changes incorporated—model placement pinned, separate bounded fresh-head/tail lanes, explicit merged deadline controller, stop-before-write checks and >eight-parent starvation tests. Final re-review: APPROVE.
