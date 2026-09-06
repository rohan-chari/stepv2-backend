# Post-global-event step-sync capacity harness requirements

**Status:** Draft for approval (architect review incorporated)
**Owner:** Backend / performance tooling
**Operator entrypoint:** `./perf global-event-sync <mode>` (proposed)

## Summary and user story

An engineer should be able to run an isolated, production-shaped experiment that answers how
expensive `POST /steps/sync-v2` becomes when it claims eligible `WAITING_SYNC`
`GlobalEventSummaryWork`, how overlapping dependency closures create PostgreSQL lock contention,
and which subsystem limits sustainable throughput. The harness must exercise the public HTTP path,
preserve the exact two HTTP-worker production topology, and produce comparable evidence for later
optimizations without touching production or staging.

## Research basis

- k6 `constant-arrival-rate` is an open-model executor: iterations start at a configured rate
  independently of response time, with `preAllocatedVUs`/`maxVUs` sized to avoid dropped arrivals.
  This is appropriate for synchronized waves and controlled eligible-sync rates.
  [Grafana k6 constant-arrival-rate](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/)
- PostgreSQL exposes active wait categories through `pg_stat_activity.wait_event_type` and
  `wait_event`, which must be sampled alongside CPU and latency.
  [PostgreSQL cumulative statistics](https://www.postgresql.org/docs/current/monitoring-stats.html)
- `SELECT ... FOR UPDATE` creates row-level contention; the harness must measure lock waits rather
  than treating all query time as CPU work.
  [PostgreSQL explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- `pg_stat_statements` provides query-level call, time, row, block, temporary-I/O, and WAL counters;
  snapshots and deltas are more useful than a single cumulative total. Query IDs are stable only
  within the same PostgreSQL major version, so reports include database/version provenance.

## Goals

- Reproduce the confirmed post-global-event capture chain through the real endpoint.
- Compare ordinary and eligible syncs under identical fixture and VM conditions.
- Isolate the effects of race size, race overlap, sample history, eligible-work count, and arrival shape.
- Identify failure reason separately from primary bottleneck.
- Measure CPU, I/O, lock waits, pool pressure, query cost, queue growth, and drain time.
- Keep scans short and repeatable; reserve three-run certification and immutable evidence checks for
  `certify`.
- Reuse existing capacity markers, scrub attestations, topology guards, run IDs, metric samplers,
  queue snapshots, and result-directory conventions.

## Non-goals

- No production or staging traffic, reads, writes, restores, or deploys.
- No public API or mobile-client behavior changes.
- No redesign of summary-capture or race-resolution logic in this harness change.
- No external notification delivery.
- No per-level VM, Redis, or database recreation during a scan.
- No claim that VM CPU units equal production VPS capacity.

## Scope and proposed command surface

Add a `global-event-sync` workflow beside existing capacity workflows:

```text
./perf global-event-sync smoke   # one low-load correctness/telemetry check
./perf global-event-sync scan    # short discovery and boundary experiments
./perf global-event-sync certify # three clean repetitions per selected case
./perf global-event-sync level --profile <name> --rate <n>
```

The command must require an already-prepared capacity VM/database state and use the existing
capacity lifecycle. `smoke` and `scan` may reuse one prepared environment; `certify` may perform
the expensive provenance and immutability checks once per workflow.

## Confirmed application path to measure

The treatment request is `POST /steps/sync-v2` using an idempotency-safe request body and a valid
capacity session. The endpoint calls `recordStepSyncV2` and, when eligible work exists, invokes
`claimEligibleSummaryWork` in `src/modules/steps/services/globalEventSummaryCapture.js`.

The measured phases are:

1. Intake and idempotency reservation (`recordStepSyncV2.js`).
2. Scoring-version dependency lock (`scoringInputVersion.js` and capture service, `FOR UPDATE`).
3. Multi-user `step_samples` read for affected races.
4. Race powerup/effect history read.
5. Capture-artifact construction and durable insert.
6. Summary/reconciliation writes and durable enqueue.
7. Asynchronous race-resolution queue work (`raceResolutionQueueV2.js`).

The control request uses the same public endpoint and payload shape but is assigned to a cohort with
no eligible summary work. The treatment and contention cohorts differ only in fixture references.

## Fixture contract

Create deterministic, run-scoped data through supported application/fixture paths. The fixture
manifest must include exact counts and IDs for:

- One recently ended global multiplier event with global-event race impacts.
- Configurable eligible `WAITING_SYNC` summary-work rows.
- Races with approximately 10, 50, 100, 250, and 500 accepted participants.
- Configurable races per user and participant-overlap percentage, including a high-contention cohort.
- Realistic `step_samples` for every participant, with configurable sample density and retention.
- Race powerup events and both active and expired effects.
- Control users/races with no eligible work.
- Treatment users whose syncs claim eligible work.
- Stable session tokens and idempotency keys; retries must not duplicate step samples, artifacts, or
  domain events.

The fixture builder must use a versioned schema (`global-event-step-sync-fixture-v1`) containing a
seed, exact participant counts per race, deterministic overlap assignment, paired control/treatment
users, sample density/history, and supported powerup/effect types. It must reject combinations that
exceed configured VM/database budgets rather than silently changing counts.

Eligible work is created deterministically, not by waiting for a scheduler: in one fixture transaction
create an ended event with `summaryAttributionVersion = 2`, v2 `PENDING` race impacts and entitlements,
then create `GlobalEventSummaryWork` rows with `status = WAITING_SYNC` and `expiresAt > fixtureNow`.
The pre-traffic census must assert all four predicates (ended event, attribution version 2, waiting
status, unexpired row), the expected eligible count, and the exact event/race/user relationships.
The control cohort must have no matching eligible row.

Every created row ID (including child queue/outbox rows) is recorded in the manifest. Reset and
cleanup are prohibited from deleting whole tables: quiesce the capacity workers, delete only manifest
IDs in foreign-key-safe order, and assert zero remaining run-owned rows and zero external side effects.

External email, push, APNs, FCM, and provider delivery must be disabled and asserted disabled.

The fixture builder must expose a census before traffic begins and a public-path correctness check
after the smoke run. Cleanup deletes only rows stamped with the run ID.

## Traffic profiles

Profiles are independent and composable. All rates, VUs, concurrency, duration, and jitter are
configurable in one versioned config file:

1. `idle-baseline` — health/telemetry only, no sync traffic.
2. `ordinary-sync` — syncs with no eligible work.
3. `eligible-nonoverlap` — eligible syncs with disjoint dependency closures.
4. `eligible-overlap` — eligible syncs sharing dependency users/races.
5. `android-periodic` — compressed 15-minute periodic background waves.
6. `android-synchronized` — same request count, synchronized arrivals.
7. `android-jittered` — same request count, bounded random jitter.
8. `foreground-five-minute` — foreground sync cadence.
9. `expedited-over-periodic` — expedited syncs layered over periodic traffic.
10. `mixed-production` — weighted control/treatment/foreground mix.
11. `event-end-worst-case` — hundreds of eligible rows and high overlap.
12. `drain` — no new requests; measure queue and recovery.

Android compression (for example, 15 minutes represented by 60 seconds) must be recorded in the
manifest with the preserved relative arrival shape and total request count.

## HTTP contract

The k6 client sends the real public request with:

- `POST /steps/sync-v2` and `Content-Type: application/json`;
- a canonical UUID `Idempotency-Key`, deterministically derived from run ID, repeat, user ID, and
  iteration (a duplicate retry reuses the exact same key and body);
- `X-Step-Sync-Intent: home-pull` where the profile models a Home pull;
- the capacity session authentication header used by existing k6 scripts;
- `X-App-Version` at or above the current fine-sample-compatible version; client features include
  `impact_summaries` and `impact_summary_expiry_v1` so the summary-work receipt is returned.

The JSON body is `{ date: "YYYY-MM-DD", steps: <non-negative integer>, samples: [{ periodStart,
periodEnd, steps }, ...] }`, with UTC ISO timestamps and the fixture's configured sample count.
Expected success is HTTP `202` with a valid sync record and optional `globalEventSummaryWork`; 400,
409, 429, 5xx, timeout, or missing receipt in a treatment request are recorded with stable reason
codes. The harness must not reuse keys across users, repeats, or phases.

## Runtime and repetition policy

- `smoke`: one short measured interval after warm-up.
- `scan`: short discovery intervals (default 30–60 seconds per rate), one repetition per normal
  level; if the first candidate failure or an inconsistent boundary appears, run the exact rate
  again before classifying it.
- `certify`: at least three clean repetitions after warm-up for each selected profile/rate.
- Do not recreate VM, Redis, or the database between scan levels. Reset only run-scoped measurement
  epochs and eligible-work state using supported capacity reset paths.
- Record setup, fixture creation, warm-up, measured traffic, drain, and cleanup separately.

The new profile must be registered in `capacity-process.js` and startup wiring must explicitly run the
global-summary/boundary schedulers plus the existing resolution worker while excluding unrelated
fan-outs. The required census is exactly `http:0`, `http:1`, `resolution:0`, and `cron:0`; any extra
capacity process is a failure. Existing `capacityGlobalEventOnly` behavior must not be assumed to
drain summary work unless the scheduler is explicitly enabled for this profile.

## Measurements

Use one UTC run ID and synchronized timestamps across k6, backend logs, VM samples, PostgreSQL
queries, queue snapshots, and artifacts. Sample approximately once per second where practical.

### Backend/VM

Collect total/user/system/I/O-wait CPU, load average, memory/RSS, swap/paging, disk throughput and
IOPS, network throughput, event-loop lag, GC pauses when available, PM2 restarts, and per-role CPU
for exactly HTTP worker 0, HTTP worker 1, resolution, and cron. Record pool active/idle/waiting,
timeouts, and saturation.

### PostgreSQL

Collect database/container CPU and memory, disk latency/throughput/IOPS, active sessions,
transactions, `wait_event_type`/`wait_event`, blocked queries, lock waits, transaction rate,
cache-hit ratio, temporary blocks/files, WAL bytes, checkpoints, tuple/index activity, dead tuples,
autovacuum, queue depth, and oldest-work age.

Take `pg_stat_statements` snapshots immediately before and after each measured phase. Compute
queryid deltas for calls, calls/sec, total/mean execution time, rows, rows/call, shared blocks read/
hit/dirtied, temporary blocks written, WAL bytes, and percentage of measured DB execution time.
Do not call `pg_stat_statements_reset` in a shared capacity instance. Snapshot
`pg_stat_statements_info` reset/deallocation counters before and after each phase; report an explicit
`unavailable` state if the extension is absent, and reject an interval with unexpected counter changes.

### Application and k6

Record offered/completed/dropped iterations, in-flight concurrency, throughput, p50/p90/p95/p99/max
latency, errors/timeouts/retries/conflicts, capture duration, scoring-lock wait, dependency users,
races, sample rows, effect rows, artifacts, summary transitions, race-resolution duration, queue
lag/depth, drain time, retries/rollbacks, and exclusive timings for intake, finalization, artifact
construction, enqueue, resolution, and post-commit work.

## Required analysis

Every report must answer:

- Eligible-sync cost versus ordinary-sync cost.
- Arrival rates at which DB CPU crosses 70%, 85%, and 95%.
- Scaling with participants, races, samples, overlap, and eligible-work count.
- Rows returned per eligible sync and lock-wait versus execution-time split.
- Synchronized versus jittered equal-volume waves.
- Dominant contributor: sample reads, scoring locks, powerup history, artifact writes, or resolution.
- Recovery time after traffic stops and effect of resolution backlog.
- Whether HTTP latency/queue growth is CPU, I/O, lock, or pool limited.
- Maximum sustainable eligible-sync rate under configured headroom.

For scan evaluation, DB CPU threshold crossings are defined as the first one-second sample at or
above 70%, 85%, and 95% sustained for three consecutive samples. Endpoint-specific p95/p99, error,
lock-wait, pool, queue, and timeout thresholds are versioned in the config. A rate passes only when
all hard and capacity gates pass; certification requires three clean repetitions and a majority pass.
If multiple gates fail, `failureReason = multiple` and the report lists all failed gates in stable
precedence order: correctness, timeout/error, latency, lock/pool, queue, DB/host resource. Missing
telemetry is `unknown`/unavailable, never a pass.

Rank SQL by interval execution time and map normalized statements/queryids to source file/function
using a checked-in mapping table; unmapped SQL is reported as `unknown`, never silently omitted.

## Result contract and artifacts

Each run writes an immutable `results/<run-id>/` directory containing:

- `manifest.json` (parameters, topology, commit hashes, config, fixture census, compression ratio).
- Raw k6 output and one-second VM/database samples.
- Pre/post `pg_stat_statements` snapshots and interval deltas (JSON/CSV).
- Queue snapshots and backend logs filtered by run ID.
- `summary.json`, `report.md`, and aligned charts for request rate, HTTP latency, backend CPU, DB CPU,
  query time, lock waits, disk I/O, and queue depth.

Artifacts redact credentials and session tokens. They include k6 image/config versions, SHA-256
checksums for evidence files, and measured UTC clock drift between k6, backend, VM, and database.

Machine-readable summary must distinguish:

```json
{
  "profile": "eligible-overlap",
  "highestPassingRate": 20,
  "firstFailingRate": 25,
  "failureReason": "db_cpu_threshold",
  "primaryBottleneck": "postgres",
  "safeCapacity": { "testedRate": 20, "status": "measured" }
}
```

`failureReason` is the violated capacity criterion (`db_cpu_threshold`, `home_p95_threshold`,
`http_error_rate`, `lock_wait_threshold`, `queue_growth`, `timeout`, `multiple`, `unknown`, etc.).
`primaryBottleneck` is the inferred subsystem (`postgres`, `db_pool`, `redis`, `queue`, `node`,
`generator`, `multiple`, `inconclusive`). A threshold violation is never itself labeled a bottleneck.

## Correctness and safety acceptance checks

Through the public HTTP path, prove that:

- sync responses are valid and idempotent retries persist samples once;
- eligible work transitions correctly;
- each capture artifact and summary is created once;
- summary values and race resolution are correct;
- controls do not enter capture while treatment does;
- no external provider is called;
- all requests bind to the capacity run ID and disposable database.

Before fixture creation, traffic, or cleanup, enforce the existing production/staging/public-host
rejectors, capacity database marker, scrub attestation, `CAPACITY_MODE`, outbound-disabled state,
and exact 2/1/1 process topology with 10/10/8/4 role pools. Never run integration tests against
production; use the dedicated integration database.

Queue evidence is scoped to manifest race/work IDs and reports summary-work and race-resolution
queues separately. If scoping is impossible, the run must first prove the entire capacity queue is
empty and then treat any foreign row as a contaminated run.

## Implementation path (tests first)

1. Explore and reuse `lifecycle.js`, `safety.js`, `fixtures.js`, `contract.js`, `runner.js`,
   `metricsProcess.js`, `globalEventReliability*`, existing k6 scripts, and capacity result helpers.
2. Add failing integration tests using the real HTTP server, dedicated integration database, local
   Redis database 15, and a separate run with `REDIS_URL` unset. Cover fixture eligibility predicates,
   control/treatment transitions, duplicate retries, concurrent overlapping syncs, summary/resolution
   drain, and cleanup after failure.
3. Add failing unit/contract tests for nested command parsing and lifecycle guards; profile parameters,
   arrival-shape compression/jitter, summary schema, SQL-delta analysis, bottleneck mapping, exact
   topology, and every production/staging/public-target rejection.
4. Implement run-scoped fixture creation and cleanup.
5. Implement k6 profiles and synchronized run-ID headers/log context.
6. Implement phase timers, VM/PostgreSQL/pool/queue samplers, and pg_stat interval export.
7. Implement evaluator, SQL-source mapping, charts, `summary.json`, and `report.md`.
8. Run focused tests, then backend unit and dedicated integration suites.
9. Run one low-load smoke only on the isolated capacity VM; present evidence and commands.
10. Run `code-reviewer` before implementation is considered complete. No large scan/certification run
    starts without explicit operator authorization.

## Acceptance criteria

- No production, staging, or public database/API target is accepted by any command path.
- Smoke proves control/treatment correctness and emits complete telemetry.
- Scan reuses prepared state, records every phase, and distinguishes CPU, I/O, locks, and pool waits.
- Synchronized and jittered profiles have equal request counts and documented compression.
- `pg_stat_statements` deltas and source mappings are present or explicitly report unavailable.
- Results are immutable, run-ID bound, and contain aligned JSON/CSV/Markdown evidence.
- Eligible fixtures are proven v2/ended/WAITING_SYNC/unexpired before traffic; cleanup is manifest-
  scoped and leaves no run-owned rows.
- The real summary and resolution schedulers are wired for the profile and no extra process exists.
- Failure reason and primary bottleneck are separate stable fields.
- The report answers every required analysis question or marks it unavailable with the reason.
- Existing production topology and safety guards remain unchanged.

## Revision log

- Draft 1: introduced a dedicated post-global-event step-sync workflow instead of overloading the
  existing notification-reliability profile; defined fixture cohorts, open-model traffic, phase
  telemetry, SQL deltas, correctness, and safety boundaries.
- Gap pass 1: made public-path correctness and idempotency explicit; added exact topology/pool
  requirements, synchronized-vs-jittered equal-volume comparison, run-scoped cleanup, and unmapped
  SQL handling.
- Gap pass 2: separated scan from certification repetition/provenance cost; added counter-stability
  checks, compressed Android-wave disclosure, and a stable failure-reason/bottleneck contract.
- Architect review: required explicit v2 eligible-work creation and census, deterministic fixture
  matrix, manifest-scoped cleanup, scheduler/topology wiring, exact sync HTTP contract, queue-scoped
  evidence, no shared-statistics reset, deterministic evaluator thresholds/voting, real-HTTP
  integration coverage, and artifact redaction/checksums/clock-drift provenance.
