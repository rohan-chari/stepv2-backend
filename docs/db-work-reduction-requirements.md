# Database work reduction — development specification

Status: implementation approved; local validation in progress. Final pinned-statistics benchmarks retain the proposed index (see implementation decision below). User requested individual research/specifications for all four issues. This document does not authorize production deployment.

## Summary and user story

As Bara usage grows, the backend must handle more simultaneous syncs and scheduled work on existing infrastructure while preserving exactly the same steps, event opportunities, timed effects, standings and balances. Reduce confirmed unnecessary queries/rows and measure actual host impact rather than assuming that fewer statements equal proportionally less CPU.

## Individual researched development specs

| Workstream | Selected development path | Main validation |
|---|---|---|
| [1. Parent maintenance](db-parent-maintenance-requirements.md) | Partial event_id index plus bounded keyset parent query | Same lifecycle row set, substantially lower mostly-drained work with measured pending-heavy/WAL tradeoffs |
| [2. Enrollment discovery](db-enrollment-discovery-requirements.md) | One bounded active cohort per multi-parent round; skip empty writes; resumable fair scheduler | Fewer cohort scans/transactions, all eligible pairs reached, identical durable obligations |
| [3. Historical cache](db-historical-cache-requirements.md) | Attributed telemetry, fitting-prefix admission and shared initial proof; conditional coverage prototype | Lower actual source/round-trip work, exact live/settled totals, unchanged memory bounds |
| [4. Deadline polling](db-deadline-polling-requirements.md) | One combined advisory discovery; existing authoritative drains; coalesced wakes | Three empty commands become one; no expiry/recovery latency or correctness regression |

Each linked spec is independently reviewable and records source paths, research, implementation order, schema/API impact, tests, acceptance and rollback. The fourth issue is lower expected benefit, not omitted.

## Evidence and limitations

Baseline source reviewed: backend 17c8983. [Investigation](db-two-hour-followup-20260913.md) and its read-plan evidence distinguish the two-hour 04:39–06:40 UTC capture from newer probes/cache counters. Captured average idle CPU 64.59%, below user's 70% target; statement deltas approximately 406,993 calls. Statement execution includes waits/nested work and excludes untracked planning; do not translate into CPU percentages or HTTP counts. Collector gaps, new entries and evictions are documented.

Global-event discovery query families together account for about 6.9% of captured executor elapsed and the sampled history query about 7.7%; no one proven cause explains all host CPU. Compressed-swap traffic and 12.29% average system CPU merit matched observation alongside improvements. Memory sizing/autovacuum settings, analytics work discovered by other investigations and server capacity changes are not silently added to these four fixes. Capture memory/zram to assess whether those require a separate spec.

## Scope and permanent invariants

- Zero intended change to credited steps, event draw/schedule/eligibility, durations, payout/coin sources, notification obligation identity or settlement. This is a required parity outcome, not an observed result of unimplemented code.
- PostgreSQL remains source of truth; Redis cached raw rows and wakes never become durable authorization. Every new bounded loop/query has failure/retry/restart behavior.
- Preserve old writer behavior, defensive missing fields and old/current HTTP contracts. No new endpoint/parameter/JSON response field or app capability. API change inventory: NONE across all four specs; existing status/error cases remain unchanged.
- iOS and Android both receive improvements through the existing backend. No UI/screens/loading/error states change, no native builds/uploads and no UI-placement work. Manual UI-placement plan: not applicable.
- No feature flag, rollout percentage, temporary environment toggle, capacity increase or staging start. Keep exactly two HTTP workers and existing dedicated worker/pool budgets.

## Development and dependency order

After user approval of this spec:

1. Pin baseline/test commands and isolated test DB/Redis; protect unrelated dirty files. Add failing integration/structural performance cases before implementation. Tests of preserved behavior may already pass baseline; the new savings/regression case must fail for the right reason.
2. Implement parent index as its own unit; benchmark actual emitted SQL and boundary writes. Can be reviewed independently.
3. Implement cache measurement A independently, enabling comparable observations after a separately authorized deployment. Local fixtures can investigate B1/B2 concurrently, but evidence gates determine production eligibility. Coverage C requires its additional gate/review; do not delay other work waiting for speculative coverage changes.
4. Implement shared enrollment discovery/controller with preserved writer and fairness tests. Keep it separate from parent-index work for attributable benchmark comparisons.
5. Implement deadline discovery/coalescing and run burst/recovery latency tests.
6. Integrate selected validated cache improvements; record rejected candidates rather than changing policy merely to complete a checklist.
7. Combined code-reviewer review and targeted full-system replay, including a 1,000-user synchronized input/wake burst and the larger enrollment fixture. Measure total HTTP→worker→publication/notification work, not only the query edited.

Workflow roles after approval: backend-developer owns backend contract/migrations/implementation; frontend-developer performs compatibility audit and Flutter analyze/relevant existing frontend verification against the locked unchanged contract, with no unsolicited Dart/UI changes. They are not implementation agents for this research turn. Code-reviewer must review final code; game-analyst has supplied invariants and reviews any deviation. No frontend code is justified merely to make backend policy effective.

## Shared benchmark protocol

All mutable fixtures and EXPLAIN ANALYZE of mutation paths run only on a dedicated verified local/disposable *_test PostgreSQL database, isolated Redis and synthetic data. Production follow-up is read-only with explicit BEGIN READ ONLY/SET LOCAL timeouts. Never prod integration tests or forced synthetic load.

Pin source version, fixture seed, PostgreSQL version, settings, cache state, process topology and workload. Alternate baseline/candidate runs and distinguish warm/cold results. Record median/p95 and spread over repeated runs, actual root buffers/rows/cohort loops, SQL SELECT/INSERT/UPDATE/DELETE and BEGIN/COMMIT counts, planning/execution time where available, WAL/index bytes, Redis requests/bytes/memory, worker p95, due-age and complete downstream jobs. Keep query counts separate from HTTP requests and unique business actions. Do not enable new production tracing/configuration without separate approval.

Per-spec numeric targets are proposed engineering acceptance thresholds, not product odds or measured savings. Tests require exact persisted/API outcomes; performance gates use repeated comparisons, not flaky single-duration assertions. A speedup that increases total DB/Redis work or loses durability does not pass.

A post-deployment comparison requires similarly sized traffic/race/event cohorts over two hours, matched midnight boundaries where relevant, and monitoring overhead reported. Seventy percent idle is the user's observation target, not a promised improvement or a release flag. Do not infer that this window predicts peak capacity.

## Verification and deployment

Relevant npm run test:integration suites and npm run test:unit (never npm test), existing assertions protected; reproduce baseline failures instead of weakening them. Flutter analyze must be clean before implementation is called done. No tests/builds required merely to author these docs; this turn runs no application tests.

Production authorization is separate and in the moment. Before any deployment: reviewed exact diff, green required checks, migration rehearsal and concrete runbook/rollback. Parent index standalone concurrent migration precedes code reload; verify definition/validity/readiness/bookkeeping. Other specs have no schema change. No changes require a carrying app release. A/B observed comparisons must not deploy competing behavior flags. Application rollback retains additive index; v2 cache format rollback ignores newer keys until expiry.

## Definition of done

All selected workstreams meet their tests and benchmark gates; every excluded conditional candidate has recorded evidence/reason; architecture and code reviews complete; old/current HTTP and scoring/settlement parity demonstrated; production readiness distinguished from deployment; measured reductions and remaining uncertainties reported. Do not call 'all issues fixed' after instrumentation alone or claim all residual cache misses are bugs. Unknown cache causes must receive an attributed result, not an invented remedy.

## Revision log

- Individual research: two architecture research tracks covered events and historical reads; primary agent traced scheduler/polling. Game analyst required zero economic/scoring delta and supplied public-path edge cases; all four drafts incorporate them.
- Fresh-eyes gap pass 1: separated exact query counters from HTTP/CPU, chose a single concurrent-index migration path, bounded parent and metadata state, separated index/batching/cache/polling deployments.
- Fresh-eyes gap pass 2: preserved protected page assertions through logical harness observations, added continuation/shutdown/fresh-head gates, rejected stale initial proof reuse, preserved Redis-unset and old-writer fallbacks.
- Formal architecture reviews: parent-index APPROVE; enrollment APPROVE after bounded independent head/tail lanes and explicit timer arbitration; cache A/B APPROVE with coverage C conditional on further evidence/review; polling APPROVE after exclusion-saturation traversal and awaited serialized recovery. All required changes incorporated and re-reviewed.
- Final pass: added slice-overrun telemetry and deadline extension across traversal-cursor test. No user-policy questions remain; benchmark outcomes are explicit development gates, not missing requirements. No code, schema, production setting or app artifact changed in this specification turn.

## Final implementation decision — index retained

Final experiments explicitly ANALYZE every participating table, including global_step_events. Earlier exploratory runs omitted parent-table statistics and their cheap69-buffer plans are not causal/acceptance evidence. With pinned statistics, current and10×mostly-drained fixtures used16,127/155,214root accesses without the index and55with it. The 252k pending-heavy fixture had equal median root accesses (9508 without/9508 with); one variable-plan pair used 7527/9571 (+27%), which is not the fixture median; controlled start-boundary WAL increased~7%, while latency stayed inside the declared5%gate. The index is retained because the observed production workload is mostly-drained and its read saving dominates that measured write tradeoff. No universal workload/CPU improvement is claimed. Monitor backlog mix after a separately authorized release. The sole migration remains the approved standalone concurrent index; no flags or forced planner controls.
