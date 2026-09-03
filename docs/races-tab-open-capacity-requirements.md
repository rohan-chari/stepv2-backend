# Races-tab open capacity requirements

## Summary and user story

Add a `races-tab-open` workload to the existing `./perf` harness so an operator
can measure how many authenticated users per second can reveal and refresh the Races tab on
the production-sized capacity VM. One iteration represents one real navigation
to the Races tab, not a weighted bag of unrelated Races endpoints.

The first use is a warm-cache baseline and capacity ladder. Home has already
populated the client-side race list in this normal entry state, so the tab is
usable immediately while its core data refreshes. The result measures that
refresh, background health, and PostgreSQL, Node, Redis, DB-pool, event-loop,
and queue resources. It must not label refresh latency as visibility latency.

## Source-of-truth client behavior

The current mobile client defines the workload:

1. A Races-tab reveal calls `_refreshRacesTab()` from the page-change handler.
2. Overlapping refreshes in one client are coalesced.
3. Existing race data remains rendered while the client awaits
   `_fetchRacesCore()`, including any device-local pending
   result acknowledgement replay, followed by
   `GET /races?view=compact-v1`.
4. Once the core request completes, it starts
   `GET /races/discovery-summary` without awaiting it.
5. It conditionally refreshes shared friends data when the loaded list is empty
   or its client timestamp is older than 60 seconds.

The baseline cohort has no pending device-local acknowledgements. A future
explicit `pending-acks` variant may cover that behavior; it must not be mixed
silently into the baseline.

## Scope

- Add workload selection to `./perf smoke` and `./perf scan`, with
  `home-open` remaining the backward-compatible default.
- Add an authenticated `races-tab-open` k6 session and fixture profile.
- Reuse the existing prepared Lima environment, disposable marked database,
  two HTTP workers, one resolution worker at concurrency two, cron companion,
  Redis, metrics collection, scan state machine, runtime accounting, and
  report locations.
- Generate one core request and one background discovery request per tab open.
- Model the conditional `GET /friends?view=summary-v1` branch from fixture
  client state. The ordinary baseline represents a Races reveal within 60
  seconds of Home loading: users with a non-empty loaded list do not refetch;
  users with zero friends do, matching the current `_friendsSteps.isEmpty`
  condition. The zero-friends share comes from the versioned production-shaped
  fixture distribution, not an invented probability.
- Gate successful core-refresh completion on the core request. Track discovery and conditional
  friends completion/error/latency separately and fail a rate if background
  requests are dropped, incomplete, or exceed their configured error gate.
- Report endpoint request counts so the generated fan-out is auditable.
- Preserve the scan rules already approved: short discovery levels, first
  failure confirmation, boundary narrowing, explicitly measured safe-rate
  candidate, and one-time environment preparation/prewarm.

## Non-goals

- Race-detail opens, messages, progress polling, powerup activity, race joins,
  race creation, pull-to-refresh bursts, and Home traffic.
- Treating every user as having a stale friends cache. That becomes a separately
  named `stale-friends` scenario if it is needed after the ordinary baseline.
- A cold/empty-client Races screen, which must be a separately named scenario.
- Production traffic or production database writes.
- Recreating PostgreSQL, Redis, backend processes, or fixtures per level.
- Changing any application endpoint or mobile behavior.
- Certification-grade endurance evidence in the initial smoke/scan.

## Operator contract and configuration

Commands:

```text
./perf smoke --workload=races-tab-open
./perf scan --workload=races-tab-open
./perf scan --workload=races-tab-open --rates=5,10,15,20,25,30
```

`performance/config/default.json` gains centrally configured workload entries.
The selected workload is recorded in the immutable manifest, `summary.json`,
and `report.md`. Changing it invalidates prepared workload fixtures but must not
weaken environment ownership or production-isolation checks.

Initial thresholds mirror the established interactive screen contract unless
measured production behavior justifies a versioned change:

- core Races-tab p95 <= 1000 ms;
- core Races-tab p99 <= 2000 ms;
- HTTP error rate < 0.1% (exactly 0.1% fails, matching the evaluator);
- zero network errors, incomplete core transactions, or dropped arrivals;
- zero incomplete required background discovery requests;
- zero incomplete selected background friends requests;
- zero worker restarts or DB connection exhaustion;
- existing numeric queue/resource safety gates once available.

Warmup, measurement duration, runtime budget, headroom policy, failure
confirmation, and narrowing remain shared central scan settings. The workload
must not introduce per-level setup or full-cache prewarming.

## Session contract

Each virtual user is assigned one fixture identity per iteration and sends the
same production client identity/capability headers used by the current app.

1. Start `races_tab_sessions_started`; fixture state represents Home having
   already populated client-side races and friends.
2. Send `GET /races?view=compact-v1`.
3. Require HTTP 200, `contract == "race-list-compact-v1"`, and valid `active`,
   `pending`, and `completed` lists.
4. Record `races_tab_core_refresh_ms`; only then record
   `races_tab_sessions_core_refresh_complete`.
5. Send `GET /races/discovery-summary` and validate the current supported
   response contract even when core failed, matching the client's caught-error
   flow. Discovery and the selected friends request start concurrently. A 404
   is a contract failure for this current-backend profile rather than silently
   changing to the legacy four-request fan-out. A 200 records every branch's
   `resolved` state; an unresolved branch is incomplete background work. Every
   generated request must finish within the bounded iteration deadline.
6. If the fixture identity has zero friends, send
   `GET /friends?view=summary-v1` in parallel with discovery, matching the
   ordinary fresh-client-cache branch described above.
7. Record per-endpoint latency, status, completion, and response bytes.

The k6 arrival rate means complete Races-tab reveals started per second. It is
not endpoint RPS. With default fan-out, `10/sec` means approximately ten core
requests and ten discovery requests per second.
The additional friends RPS equals the measured zero-friends cohort share times
the tab-open rate.

Each endpoint uses the mobile client's 15-second timeout. The overall iteration
deadline is 31 seconds: one core timeout window, one parallel background timeout
window, and one second of scheduler allowance. Graceful stop is 32 seconds.
VU allocation is derived from rate times this deadline with bounded overhead.
Every attempt must offer and start exactly `rate * measurementSeconds` sessions,
record scheduler lag and quota drift, prevent concurrent reuse of one fixture
identity, and reconcile every request plus the background tail.

## Fixtures, cache, and reset

Reuse authenticated synthetic/sanitized capacity users, but materialize a
versioned joint distribution of active, pending, completed, invited, zero-race,
tournament, team-race, review-opportunity, payout-double, and zero-friends
states. Lock the platform/capability mix. Inputs include a source timestamp and
content hash, are identifier-free and deterministic, and appear in fixture
evidence. Users are interleaved so early rate prefixes do not overrepresent one
bucket. Fixture races remain away from start/end, invite-expiry, and
payout-expiry boundaries for the maximum scan duration. Verify the distribution
before and after the scan so cron cannot silently change later levels.

The workload is read-only for the baseline. Its reset plan must prove that no
endpoint in the baseline mutates durable user/race state. If source inspection
or integration evidence finds a write, add only its run-owned selectors to the
existing targeted reset; do not add per-level database restoration.

This is a steady-state warm refresh, not a claim that every request is a cache
hit. Initial prewarm uses the same representative identity pool and warms only
the core route needed to represent Home's preceding race-list load; it does not
warm discovery. Per-level warmup uses the upcoming level's bounded identity
pool only to maintain the declared natural 15/30/300-second fragment TTL state;
it never clears Redis or rebuilds data. The report records observed race-list
cache sources (Redis hit, PostgreSQL miss/bypass, and other outcomes) against a
centrally configured, versioned target mix calibrated from identifier-free
production telemetry. Until that calibration exists, smoke and diagnostic
scans may run but safe capacity is unavailable. Cold cache is separate.

## Result contract and report

The existing versioned summary receives workload-neutral screen fields plus a
`racesTabOpen` section containing:

- started and core-refresh-complete sessions;
- core p50/p95/p99 latency and response bytes;
- discovery started/completed/error counts and p95/p99 latency;
- conditional friends started/completed/error counts and p95/p99 latency;
- the fixture zero-friends share that selected the branch;
- request counts by endpoint;
- observed endpoint RPS, scheduler lag/quota drift, and race-list cache-source
  mix versus its configured target;
- incomplete background work and iteration-deadline timeouts;
- fixture cohort distribution.

The additive summary schema becomes `bara-perf-summary-v3`. Existing Home fields
remain unchanged. Each `levels[]` row gains `racesTabOpen`. Workload-neutral
capacity fields are `highestPassingRate`, `firstFailingRate`,
`calculatedHeadroomTarget`, `safeCapacityCandidateTested`,
`safeOperatingRate`, and `safeOperatingRateUnit` (here,
`races_tab_opens_per_second`). `safeHomeOpensPerSecond` remains Home-only.

Stable Races failure reasons include `races_core_p95_threshold`,
`races_core_p99_threshold`, `incomplete_races_core_transactions`,
`incomplete_races_discovery`, `incomplete_races_friends`,
`races_contract_error`, `scheduler_quota_drift`, and
`cache_profile_mismatch`, alongside shared network/resource/worker reasons.
They remain separate from primary bottleneck.

Each rate retains PostgreSQL CPU, Node CPU, Redis CPU, DB-pool wait, event-loop
delay, queue growth, top SQL, failure reason, and primary bottleneck. Failure
reason remains separate from bottleneck.

The human report leads with `Races tab opens/sec`, core-refresh p95/p99, background
health, and resource use. It must explicitly explain that tab-open rate is not
total HTTP RPS.

## API contract, data model, and compatibility

No application API, response shape, schema, or migration changes are allowed.
The harness consumes the existing authenticated endpoints. Older mobile clients
are unaffected because no production application behavior changes. The
workload defaults to the currently deployed request/header contract and stores
its own profile version, so future app behavior requires an explicit workload
version update rather than silently changing historical comparisons.

## Tests-first implementation plan

1. Add failing CLI/config tests for `--workload=races-tab-open`, rejection of
   unknown workloads, backward-compatible Home defaulting, and manifest
   binding.
2. Add failing session-contract tests proving one successful iteration makes
   exactly one core request followed by discovery, measures core refresh completion
   before background completion, and selects the friends branch from fixture
   state rather than randomness.
3. Add failing malformed/error/timeout tests for each response, core failure
   followed by background launch, discovery/friends parallelism, partial
   discovery resolution, and supported-profile 404 rejection; ensure no false
   completed transaction is recorded.
4. Add failing fixture tests for deterministic cohort interleaving, valid auth,
   response materiality, and read-only/reset evidence.
5. Add failing evaluator/report tests for Races-specific metrics, endpoint
   counts, cache mix, scheduler accounting, background incompleteness, stable
   Races failure reasons, bottleneck, workload-neutral rate fields, Home legacy
   compatibility, and explicit tested-safe-rate semantics.
6. Implement workload selection, fixtures, k6 session, normalized evidence,
   and reporting in that order.
7. Run backend unit tests, then only integration tests whose `DATABASE_URL` is
   confirmed to name the dedicated `_test` database.
8. Run `./perf smoke --workload=races-tab-open` on the isolated Lima target.
   Only after a healthy smoke should the operator start the scan ladder.

## Implementation files

- `performance/lib/cli.js`, `performance/lib/config.js`, and
  `performance/lib/main.js`: select and bind the workload.
- `performance/config/default.json`: central Races workload and thresholds.
- `performance/workloads/races-tab-open.js`: fixtures, execution, evidence.
- `scripts/k6/races-tab-open.js`: client-faithful k6 session.
- `src/modules/loadTesting/contract.js` and a focused fixture module: versioned
  endpoint/header and cohort contract.
- `performance/lib/evaluate.js`, `performance/lib/report.js`, and result schema
  tests: workload-neutral screen evaluation plus Races details.
- `test/lib/perf/`, `test/modules/loadTesting/`, and a real HTTP integration
  test: tests listed above.

## Acceptance criteria and definition of done

- One iteration faithfully represents one ordinary Races-tab reveal.
- `10/sec` unambiguously means ten tab reveals started per second.
- Core refresh completion and background completion are distinct metrics.
- Generated endpoint counts reconcile with iteration counts and fixture branch
  membership.
- Scan records app, DB, Redis, pool, event-loop, queue, and SQL evidence for
  every measured level.
- The existing failure-confirmation and tested-safe-capacity algorithms apply
  unchanged.
- Preparation/prewarm happen once; no per-level environment, DB, Redis,
  backend, or fixture recreation is introduced.
- Every production target/write guard remains intact and tests prove it.
- Safe capacity remains unavailable without required resource baselines,
  fixture stability, and cache-profile evidence.
- Relevant unit and `_test` integration suites pass; smoke is healthy before a
  ladder begins.
- No frontend or backend application behavior, API, or schema changes.

## Revision log

- Gap pass 1: separated core refresh completion from non-blocking discovery,
  excluded device-local acknowledgement replay from the ordinary baseline,
  and made endpoint-count reconciliation explicit.
- Gap pass 2: modeled the conditional friends request from fresh client state
  and the production-shaped zero-friends cohort, bounded background completion
  within each iteration, and made workload versioning and prepared-fixture
  invalidation explicit.
- Architect review: corrected warm-tab semantics from visibility to refresh,
  locked compact response/fallback behavior, bounded request and iteration
  deadlines, added scheduler/request reconciliation, expanded fixture/cache
  evidence, and separated Races result fields from legacy Home fields.
