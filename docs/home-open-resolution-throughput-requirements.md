# Home-open resolution throughput requirements

## Summary and user story

The production-shaped Home test keeps visible requests fast at ten opens per
second, but complete sessions miss their 15-second settlement contract when the
two-lane resolution queue falls behind. Operators need durable, low-cardinality
phase evidence before choosing any production queue change. The optimization
recorded below is deferred and is not implemented by this capacity changeset.

## Scope

- Emit one versioned, identifier-free event per claimed attempt for commit,
  superseded discard, fence loss, and failed/requeued work.
- Record queue age at claim, claim-to-outcome duration, effective concurrency,
  bounded outcome/plan/count fields, mutually exclusive top-level phases,
  nested drill-down phases, and unattributed duration.
- Retain one immutable raw backend JSONL artifact and one derived aggregate on
  successful, failed, nonzero, and interrupted capacity runs.
- Give each failed k6 session exactly one closed-enum primary reason.
- Reproduce production's two HTTP workers, dedicated resolution/cron workers,
  role DB pools, hardware caps, and resolution concurrency `2`.
- Preserve pre-change evidence for a separately reviewed future optimization.

## Non-goals

- No deploy, production write, schema/API/frontend change, flag, extra worker,
  concurrency increase, user data in logs, or speculative refactor.

## API, data model, frontend, and compatibility

No public contract, migration, or frontend change. Frozen iOS/Android clients
observe identical endpoints, payloads, ordering, and asynchronous semantics.

## Implementation path

1. Complete the existing phase timer in
   `src/modules/races/jobs/raceResolutionQueueV2.js`. Top-level phases must be
   mutually exclusive; nested drill-downs are reported separately and never
   double-counted. Every claim must reconcile to exactly one terminal event.
2. In `scripts/k6/home-open.js`, assign one failure reason in this precedence:
   critical HTTP/payload, manifest, suggested-race, terminal resolution failure,
   replay validation, resolution nonterminal at deadline, other deadline expiry.
   Reason counters must sum exactly to failed sessions.
3. In `scripts/k6-home-open.js`, copy backend logs before cleanup in normal and
   signal/error paths. Aggregate attempts, cumulative top-level time share,
   p50/p95/p99 by phase/plan/outcome, queue arrivals/claims/completions, and lane
   utilization. Bind run ID, source hash, snapshot/scrub hashes, and window.
4. Make the live resolution readiness response attest its parsed/clamped
   effective concurrency and PID. Fail before fixtures/load unless concurrency
   is `2`; bind both values to telemetry and the immutable report.
5. Run the exact unoptimized 5/sec warm-up plus 10/sec/10-minute measurement.
6. Record the measured dominant phase and any proposed code/query change here.
   Keep that proposal outside this capacity-testing changeset.

## Tests-first plan

- Every claimed terminal outcome emits once with bounded fields; attempts and
  events reconcile and unattributed time is finite.
- Nested drill-down timings do not add to top-level cumulative time.
- Failure-reason counters are mutually exclusive and reconcile to failures.
- Capacity startup rejects unset/one-lane concurrency, and live readiness
  attests two lanes and a stable resolution PID.
- SIGINT and nonzero exits preserve logs before fixture/VM cleanup.
- Optimization tests prove identical output, fence-first lease validation,
  ascending participant lock/write order, retry/supersede behavior, and durable
  Postgres queue semantics. Existing assertions remain unchanged.

## Acceptance criteria

- Pre-change evidence identifies the dominant phase by attempts, cumulative
  time share, p50/p95/p99, queue flow, and lane utilization.
- Capacity evidence is complete and internally reconciled on passing and
  failing runs; it does not claim an optimization has shipped.
- Backend unit and safe integration suites pass and review has no unresolved
  correctness or compatibility finding.
- Any future runtime optimization requires its own tests, review, capacity
  acceptance run, commit, and explicit deployment approval.

## Measured bottleneck and deferred proposal

The pre-change run `homeopen-l10-c2diag-20260901a` produced 6,000 critical Home
renders with zero HTTP errors, but only 2,843 sessions settled. All 3,157
failures were `resolution_not_settled`. The worker completed only 898 coalesced
attempts; their core work was fast (p50 24 ms, p95 116 ms), while queue age was
p50 5.159 s and p95 320.259 s. Every attempt used the dependency-closure plan.

The limiter is the deliberate follow-up floor in
`RaceResolutionJobV2.recordSuccess`: even when a newer generation arrived while
the worker was running, it requeues that generation with the full production
30-second `RACE_RESOLVE_DEBOUNCE_MS`. This exceeds the 15-second Home settlement
contract by construction and lets continuously active races age for minutes.

The deferred proposal would keep the configured 30-second floor for a fully
settled generation, but uses `min(caller-supplied-or-configured debounce, 5s)`
only for an already-superseded follow-up generation. This preserves existing
1-second and explicit zero-delay callers. The existing generation check,
lease-token fence, single SQL update,
state transition, and durable queue row remain unchanged. This does not add a
flag or increase worker concurrency. A separate implementation would need to prove the
superseded row is claimable at five seconds while a settled row retains the
configured 30-second floor.

## Revision log

- Gap pass 1: required interruption-safe artifacts, exclusive failure reasons,
  and a pre-optimization evidence run.
- Gap pass 2: prohibited identifiers, concurrency changes, speculative work,
  and required exact session, drain, and cleanup reconciliation.
- Architect review 1: required reconciled mutually-exclusive timing phases,
  runtime concurrency attestation, and a second review of the measured fix.
- Architect review 2: approved the measured direction and required the
  superseded cap to preserve shorter/zero callers plus focused coverage for
  30s→5s, 1s→1s, 0→0, settled 30s, and stale leases.
- Capacity-only revision: deferred the five-second runtime change and removed
  it from the implementation and integration suite.
