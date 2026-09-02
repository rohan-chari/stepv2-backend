# Bara load-testing rebuild requirements

**Status:** Approved for implementation  
**Owner:** Backend / performance tooling  
**Primary operator entrypoint:** `./perf`  
**Companion architecture guide:** `performance/README.md`

## Summary and user story

An engineer should be able to run one command and quickly learn how many
complete Home-screen opens per second the current Bara backend safely supports,
why the first confirmed failing rate failed, which subsystem most likely caused
it, and whether a code change improved or degraded performance.

The rebuilt harness will behave like a developer tool rather than a sequence of
manually coordinated infrastructure operations. It will reuse one isolated,
production-shaped performance environment and one versioned sanitized dataset
through a smoke or scan. It will retain the existing production guards,
production-like two-worker topology, realistic Home transaction, fixture
cohorts, and useful result evidence. It will not preserve expensive validation
or evidence ceremony merely because the legacy harness contains it.

The intended interface is:

```bash
./perf smoke
./perf scan
./perf certify
./perf compare main
./perf reset
./perf refresh-data
```

Normal `smoke`, `scan`, `certify`, `compare`, and `reset` commands never require
production access. Only the separately invoked `refresh-data` workflow may read
from production, and that access must be read-only.

## Goals

- Make `./perf smoke` a fast regression check with an immediate PASS/FAIL.
- Make `./perf scan` cheaply locate a passing/failing Home-open boundary.
- Confirm a boundary-defining scan failure so one noisy sample cannot establish
  the failure boundary.
- Make `./perf certify` rigorously verify the boundary found by a scan.
- Make `./perf compare <git-ref>` compare two revisions under the same dataset,
  workload, configuration, and environment fingerprint.
- Measure successful complete Home opens per second, not merely HTTP RPS.
- Distinguish application, PostgreSQL, Redis, host, and background-job pressure.
- Preserve realistic database cardinality and data distribution without
  downloading or scrubbing production for every run.
- Make repeated runs comparable and save concise machine-readable and human
  reports.
- Report a safe operating capacity only after the selected integer candidate
  has actually passed the configured safe-capacity gates.
- Separate the capacity criterion that failed from the subsystem most likely
  responsible for that failure.
- Keep load generation off the system under test for certification and, where
  practical, for local/Lima scans.
- Prevent writes or load traffic against production with technical guards.
- Audit every inherited guard by both risk reduction and runtime cost. Keep
  cheap protections on every command; run expensive confidence checks once per
  workflow or only during certification.

## Non-goals

- This feature does not change any mobile or public API contract.
- This feature does not deploy application code or provision production.
- This feature does not send load to production or run destructive operations
  against a production database.
- It does not promise that Lima CPU units equal cloud-vCPU capacity. Lima is a
  regression and development target; production capacity claims require a
  production-shaped remote target.
- It does not recreate the database, Redis, or VM between ordinary scan levels.
- It does not add Grafana, Prometheus, or another persistent observability stack.
- It does not infer DAU from Home opens per second.
- Phase 1 does not delete the legacy capacity commands. They remain available
  until replacement parity and migration acceptance criteria pass.

## Current architecture

### Commands and orchestration

- `npm run capacity:home -- scan|certify|level` invokes
  `scripts/home-capacity-workflow.js`.
- `scripts/lima-capacity.js` provisions and validates the Lima VM, Postgres,
  Redis, and backend containers; owns production-snapshot restore and scrub
  attestation checks; and labels resources before cleanup.
- `scripts/k6-home-open.js` provisions fixtures, starts metrics collection,
  invokes k6, drains resolution work, evaluates evidence, and writes each
  level's artifacts.
- `scripts/k6/home-open.js` is the real k6 Home-open workload.
- `scripts/capacity-metrics.js` samples the capacity environment.
- `src/modules/loadTesting/runner.js` and
  `src/modules/loadTesting/globalEventReliabilityProfiles.js` evaluate gates.
- `src/modules/loadTesting/homeOpenFixtures.js` builds deterministic Home users
  and topology.

The older `scripts/capacity.js`, `scripts/load-test.js`, event-open scripts, and
the broader `docs/capacity-load-runbook.md` support additional profiles and are
not replaced by the initial Home-focused migration.

### Provisioning and process topology

The current Home workflow creates or validates a 7-CPU, 12-GiB, 160-GiB Lima
VM. Docker runs PostgreSQL 18 with `pg_stat_statements`, Redis, and a backend
container. `scripts/capacity-cluster.js` starts four Node processes:

- HTTP worker 0
- HTTP worker 1
- one resolution process
- one cron process

This mirrors `ecosystem.config.js`, where production has exactly two clustered
HTTP workers plus separately owned resolution and cron work. The capacity
profile also enforces resolution concurrency `2` and role-specific DB pool
budgets of HTTP 10/10, resolution 8, and cron 4.

### Data lifecycle

The current workflow validates a production-derived snapshot, its hash, a scrub
attestation, and production resource metadata. For every smoke, ladder,
bracket, and certification child it deletes and recreates Postgres and Redis,
restores the entire snapshot, deploys Prisma migrations, creates fixtures,
starts the backend, waits for the restored resolution queue to settle, and
finally tears the child down.

This provides certification-grade isolation but makes a scan scale with the number of
levels. Full database restore, migration verification, dependency/container
setup, queue settling, per-child readiness, and cleanup dominate runtime.
Much of this work proves provenance or freshness rather than preventing a
realistic production incident. The rebuild explicitly separates those concerns.

### Complete Home transaction

The shipped mobile flow is defined by `MainShell._loadHomeAndShowResultsInner`
in the frontend. It:

1. persists current step data;
2. starts Home suggestions without making them block the main render;
3. starts the Home race-card and compact race-list reads;
4. after race-card resolution, fetches shop and friends only when the batch did
   not resolve those fields;
5. refreshes `/auth/me?view=shell-v1` except where the app's cold-start auth
   envelope makes that redundant;
6. polls a returned resolution receipt in the background.
7. when step sync returns optional `globalEventSummaryWork`, polls that work in
   the background at 750 ms, 1.5 s, 3 s, then 5-second cadence and refetches
   `/home/race-card` only when the receipt reaches `CREATED`.

The existing k6 script correctly models the current network graph:

```text
POST /steps/sync-v2
  -> retry once for an ambiguous response, or use the legacy write fallback

then concurrently:
  GET /home/race-card?view=shell-v1&homeActiveRaces=1&localDate=...
  GET /races?view=compact-v1
  GET /home/suggested-races

after the race-card response:
  GET /shop/catalog                 only if presentation was unresolved
  GET /friends?view=summary-v1      only if friends were unresolved
  GET /auth/me?view=shell-v1
  GET /assets/manifest              when presentation/auth requires it

after a resolution receipt:
  GET /steps/race-resolution/:jobId?generation=...
  -> on SUCCEEDED refetch Home card, compact races, and auth/me

after an optional global-event-summary receipt:
  GET /home/global-event-summary-work/:workId at 750ms, 1.5s, 3s, then 5s
  -> on CREATED refetch Home card only
```

The new harness must reuse this transaction code and its response-dependent
fan-out. The primary completion metric remains the point at which required
Home data is usable. Suggestions and resolution settlement remain separately
reported diagnostics when they do not block visible Home completion.
Global-event-summary settlement is likewise bounded, measured, and reported
without blocking visible Home completion. This current-client/current-backend
profile requires `/home/suggested-races`; a 404 is a workload contract failure
and does not trigger the obsolete `/races/featured`, `/races/public`, and
`/tournaments/public` compatibility fan-out.

The primary workload is explicitly versioned as `authenticated-home-reveal-v1`:
an already-authenticated user reveals or resumes Home, persists steps, and
performs the full Home refresh including `/auth/me`. This matches the existing
k6 behavior and the common foreground/resume path. It is not labeled a full
application cold start. The Flutter cold-start path may satisfy auth before
Home and skip the duplicate `_refreshMe`; a future `cold-app-launch-v1` profile
must model that distinct end-to-end sequence rather than silently changing the
primary workload. Workload name and cohort weight are required in config,
manifest, summary, and report, and parity tests cover every conditional graph
supported by the current-client/current-backend workload contract.

### Existing observability and evidence

Useful existing pieces include:

- open-loop k6 `constant-arrival-rate` execution;
- complete-session counters and p50/p95/p99 latency;
- per-endpoint latency, status, retry, fallback, dropped-arrival, scheduling,
  and network-error measurements;
- backend health and database-pool telemetry, including Node event-loop data;
- container CPU/memory and resolution queue lag/depth samples;
- source, dataset, schema, migration, resource, topology, and environment
  fingerprints;
- immutable JSON artifacts and partial failure/cleanup evidence;
- outbound-provider disabling and production-host rejection.

The current artifacts are diagnostic but fragmented. They do not yet provide
one stable `summary.json` and `report.md` that clearly identify measured safe
capacity, the confirmed failure boundary, the failed capacity criterion, Top
SQL, and the first saturated subsystem.

## Target architecture

```text
host or dedicated load generator
             |
             | k6 constant-arrival-rate Home sessions
             v
reusable performance target (local/Lima initially, remote later)
  +-- Node HTTP worker 0
  +-- Node HTTP worker 1
  +-- Node resolution worker
  +-- Node cron worker (normal mode only)
  +-- PostgreSQL + pg_stat_statements
  +-- Redis
  +-- structured metrics sampler
             |
             v
performance/results/<run-id>/{summary.json,report.md,raw evidence}
```

The scan orchestration state machine is:

```text
cheap safety guard -> prepare/reuse once -> validate once -> health check
                  -> targeted reset -> warmup -> reset metrics
                  -> measure -> collect -> evaluate -> next level/report
```

For a scan, only targeted reset through evaluate repeats in the same
environment. A full baseline restore, service recreation, source verification,
schema validation, and sanitization validation are not part of each level.

## Validation tiers and cost budget

Every inherited safety, validation, and evidence step must be classified before
reuse. A step with no documented failure it prevents, or whose failure is
already prevented by a cheaper invariant, is removed from the normal path.

### Tier A — cheap incident-prevention guards, always on

These run before traffic or mutation and should complete in seconds:

- reject production/staging/public API hostnames and known production IPs;
- reject production DB hostnames and database names;
- require a durable disposable/performance DB marker before reset or writes;
- require capacity-mode outbound providers to be disabled;
- require owned resource labels before destructive cleanup;
- validate that the requested command/target/config is syntactically safe;
- prove k6's resolved target is the same approved performance target checked by
  preflight, protecting against DNS/redirect mistakes.

These protections remain mandatory in smoke, scan, certify, compare, and reset.
They protect production directly and do not require recreating an environment.

### Tier B — workflow validation, once per smoke/scan

Run at workflow startup, cache the result in the run manifest, and do not repeat
at ladder levels:

- application SHA and harness/config fingerprint from persisted markers;
- dataset ID/hash and last successful sanitization status from persisted
  baseline metadata;
- schema/migration compatibility and expected extension/index census;
- exact process topology and two HTTP workers;
- target hardware/runtime fingerprint;
- test-user cohort/token readiness;
- Postgres/Redis/backend health;
- metric collector capability checks.

A level rechecks only liveness and process restart counters. If a process
restarted or the environment binding changed, the scan stops instead of
silently rebuilding and continuing.

Tier B must not re-read/hash the full dump, rebuild or byte-verify a source
bundle, reinstall dependencies, or restore Postgres when persisted markers
already match. Full byte validation belongs to dataset creation/certification.

### Tier C — certification-grade validation/evidence

Reserve these for `certify`, `compare`, dataset refresh, provider rehearsals, or
explicit diagnostics:

- fresh environment construction when required by certification policy;
- repeated source-bundle byte verification;
- exhaustive schema/migration evidence capture;
- full sanitization attestations and detailed row-count proof;
- immutable append-only event journals;
- per-repeat/level topology and provenance bundles;
- certification-grade cleanup attestations;
- repeated baseline restoration where a certification protocol specifically
  requires it.

Certification should still avoid repeating a costly check when a once-per-
certification binding proves the same invariant. "Certification-grade" does
not mean "repeat everything blindly."

### Runtime accounting

Every workflow reports setup, reset, settle, cache preparation, liveness,
warmup, metric reset, measurement, collection, evaluation, report-write, and
cleanup durations separately. Scan acceptance includes ceremony budgets:

- all-inclusive per-level non-warmup/non-measurement ceremony target: <= 15 sec,
  including targeted reset, settling/draining, cache preparation, liveness,
  metric reset, collection, evaluation, and report writes;
- settling/draining has a configured finite sub-budget; failure to settle is a
  measured level failure and cannot extend the workflow indefinitely;
- no VM, database, Redis, or backend recreation between ordinary levels;
- no snapshot download, full restore, migration deploy, dependency install,
  sanitization scan, or source-bundle rebuild between levels;
- diagnostics collection must be bounded and may not extend a level by minutes.

If the 15-second target cannot be met, the report names the slow operation and
the implementation must either optimize it or explicitly document why the
measurement cannot be trustworthy without it.

Warmup is separately bounded and centrally configured by mode:

- smoke default: 30 seconds;
- scan default: 15 seconds per measured rate, configurable from 15 through a
  maximum normal default of 30 seconds;
- certify default: 60 seconds.

Every level records configured and actual warmup duration. Exceeding the budget
is prominently reported as a runtime-budget warning with the excess and cause;
it cannot silently lengthen a scan. In warm-cache mode, the full fixture cohort
is represented by a bounded configured cache-only cohort prewarm once at
workflow startup; it uses GET-only Home reads and cannot enqueue step-sync or
resolution work. Per-level warmup only stabilizes the new
arrival rate and refreshes normal TTLs before measurement epochs are reset. It
must not recreate or clear Redis, recreate services, restore PostgreSQL, rebuild
fixtures, or repeat environment preparation. Cold-cache behavior remains an
explicit separate mode.

Prepared-environment startup target is <= 60 seconds before warmup. The fast
path is binding-dependent:

- unchanged VM, code, and dataset: reuse everything and verify persisted
  markers/liveness only;
- code changed: rebuild/restart only the backend processes/image;
- dataset changed: restore only PostgreSQL, then apply targeted fixture setup;
- hardware/provider mismatch: recreate or resize only the target VM;
- Redis is recreated only for a corrupted/incompatible service, never simply
  because a new scan began.

Each operation is timed. Tests assert the selected invalidator triggers only
its required operation, and any startup-budget miss is named in the report.

For an already-prepared environment, `./perf scan` targets completion within 15
minutes. At more than 20 minutes it emits a prominent runtime-budget warning;
this is diagnostic rather than automatically a capacity failure. The report
must explain elapsed time using these non-overlapping categories:

- environment preparation;
- workflow validation;
- initial cohort prewarm;
- targeted resets;
- settling/draining;
- per-level warmups;
- measured load;
- failure confirmation;
- boundary narrowing;
- metrics collection;
- report generation;
- cleanup.

Normal scan discovery measurements default to 60 seconds. Longer stability
windows belong to certification unless an evidence-backed config revision
documents why a longer discovery interval is required.

With an already-prepared target, five initial discovery rates through the first
failure, one confirmation, approximately three narrowing rates, 15-second
warmups, and ordinary per-level overhead below its 15-second ceiling, the
expected normal scan is approximately 12-15 minutes. Fewer/more ladder,
confirmation, narrowing, or safe-candidate executions adjust that total and are
visible in the runtime breakdown.

## Repository layout and implementation map

The implementation should converge on:

```text
perf                         executable entrypoint
performance/README.md               operator and architecture guide
performance/config/default.json     shared defaults and thresholds
performance/config/smoke.json       smoke durations/rate overrides
performance/config/scan.json        ladder and narrowing policy
performance/config/certify.json     repeat and duration policy
performance/data/baseline.json      metadata only; never snapshot bytes or PII
performance/lib/cli.js              argument parsing and command dispatch
performance/lib/config.js           layered config validation
performance/lib/environment.js      provider-neutral lifecycle contract
performance/lib/reset.js            targeted reset and cache handling
performance/lib/evaluate.js         pass/fail, boundary, and headroom policy
performance/lib/metrics.js          collection/reset coordination
performance/lib/report.js           deterministic report and summary generation
performance/providers/lima.js       reusable Lima target adapter
performance/providers/remote.js     later remote target adapter
performance/workloads/home-open.js  orchestrator adapter for existing k6 workload
performance/results/<run-id>/       ignored run artifacts
```

JavaScript is preferred because the backend, existing harness, tests, and
report logic are already Node-based. The top-level executable stays a small
wrapper; it must not introduce a large CLI framework.

During migration, modules should be extracted from the existing scripts rather
than duplicated. `scripts/k6/home-open.js`, fixture creation, safety checks,
metrics primitives, and proven lifecycle helpers remain authoritative until
their replacements have parity tests.

## CLI contract

```bash
./perf smoke [--target=lima] [--background=normal|off] [--cache=warm|cold]
./perf scan [--target=lima] [--rates=2,5,10,...] [--background=normal|off] [--cache=warm|cold]
./perf certify [--from-scan=PATH | --pass-rate=N --fail-rate=M | --rate=N] [--target=lima]
./perf compare <git-ref> [--target=lima]
./perf reset [--target=lima]
./perf refresh-data
```

`--keep-running` may be supported for smoke and scan. Unknown options, invalid
combinations, arbitrary base URLs, arbitrary database URLs, and production-like
hostnames fail before any mutation or traffic.

Commands print concise live progress and the final report path. They require no
Codex decisions while running.

### Initial validation-cost inventory

Exact timing will be recorded by the first implementation rehearsal; the
current disposition is fixed now so an unmeasured step cannot default back into
every ladder level.

| Existing step | Failure prevented | Current cost class | New cadence | Reuse invalidator / disposition |
|---|---|---:|---|---|
| Reject production API/DB target | Production load or writes | milliseconds | every command | Always keep; config/target change |
| Disposable DB marker | Destructive reset on wrong DB | milliseconds | every mutation | Always keep; connection change |
| Resource ownership labels | Delete unrelated resources | milliseconds-seconds | destructive cleanup only | Always keep |
| Outbound-provider disable check | Push/email/cloud side effects | milliseconds | process start and health identity | Always keep |
| VM hardware fingerprint | Invalid comparison target | seconds | workflow startup | Recheck only on provider/hardware change |
| Source SHA/config marker | Wrong code measured | milliseconds | workflow startup | Backend rebuild on code/config change |
| Full source-bundle construction/byte verification | Mid-run source drift | seconds-minutes | certify/compare only | Remove from scan fast path |
| Dependency install/image build | Missing/incompatible runtime deps | minutes | cache miss only | Lockfile/runtime/build-input change |
| Snapshot dump hashing | Corrupt/wrong dataset | seconds-minutes | refresh/certify; marker read in scan | Dataset metadata/hash change |
| Full sanitization attestation | Private data leakage | seconds-minutes | refresh-data; verify status marker in scan | Dataset/scrubber change |
| Full PostgreSQL restore | Dirty/wrong baseline | minutes | dataset change or explicit recovery | Never between scan levels |
| Prisma migration deploy/schema census | Schema/code mismatch | seconds-minutes | dataset or code/schema change | Persist verified schema marker |
| PostgreSQL recreation | Corrupt/incompatible service | minutes | exceptional recovery | Never routine scan setup/level |
| Redis recreation/zero census | Cold cache/isolation | seconds | exceptional recovery | Use namespaced targeted cache reset |
| Backend recreation | Fresh process/provenance | seconds-minutes | code/config change | Keep process across scan levels |
| Exact process census | Wrong two-worker/background topology | seconds | workflow startup | Level checks only restart counters/liveness |
| Fixture provisioning | Controlled realistic users | seconds-minutes | dataset/cohort change | Targeted reset run-owned state |
| Exhaustive mutation/table audit | Unknown Home writes | potentially minutes | development, refresh, certify | Bounded run-row checks in scan |
| Restored queue quiescence | Historical backlog contaminates result | seconds-minutes | workflow startup | Per-level settle has finite budget |
| Queue drain | Cross-level run work | seconds-minutes | bounded per level | Fail level when sub-budget expires |
| Per-level warmup | Stabilize arrival rate/refresh TTLs | 15-30 seconds | every measured scan rate | Centrally bounded; no full prewarm/setup |
| `pg_stat_statements` reset | Per-level SQL attribution | milliseconds | every level | Keep |
| Metrics sampling/export | Bottleneck diagnosis | seconds | every level | Bound inside ceremony budget |
| Immutable child journal/provenance forest | Forensic certification | seconds plus complexity | certify only | Compact scan summary instead |
| Top-level atomic summary/report | Useful non-corrupt result | milliseconds | every workflow | Keep |

### Smoke

- Reuse the prepared target and selected sanitized dataset.
- Perform targeted reset, health checks, and configured warmup.
- Default to 5 Home opens/second, a 30-second warmup, and a 2-minute measured
  interval, with exact values owned by config.
- Produce an unambiguous PASS/FAIL without searching for capacity.
- Target completion time after an already-prepared environment: under 5
  minutes, excluding a one-time dependency/image build.

### Scan

- Default ladder: `5,10,15,20,25,30` Home opens/second. A lower start remains a
  config/CLI option for unusually constrained targets.
- Reuse the same services and database throughout the scan.
- Before every warm-cache level: settle, apply targeted reset, preserve the
  established warm cache, run bounded stabilization warmup, then reset
  k6/application/query metrics and measure.
- Before every cold-cache level: settle, apply targeted reset, perform only
  non-cache-filling health/stabilization checks, clear the performance-owned
  cache prefix, verify its relevant key census is empty, reset measurement
  epochs, and begin traffic immediately. Cold mode must not run a request-
  generating warmup after the final clear.
- Use a centrally configured 60-second default measurement and bounded
  15-30-second per-level warmup.
- Run one repetition per normal discovery level. When a rate first fails and
  would define or replace the upper failing boundary, immediately run the exact
  rate once more:
  - `FAIL, FAIL` classifies the rate `FAIL` and confirms the boundary;
  - `FAIL, PASS` marks it `UNSTABLE` and triggers one deciding repetition;
  - two failures out of three classify it `FAIL`;
  - two passes out of three classify it `PASS` and scanning continues upward or
    narrows against the existing confirmed failure.
- A later result at a boundary-defining rate that conflicts with that rate's
  prior classification uses the same maximum-three-run majority rule. Do not
  run three repetitions at ordinary passing levels.
- Generate one workflow manifest plus compact per-level summaries. Do not write
  certification-grade immutable evidence bundles or append-only lifecycle
  journals for each discovery level.
- Stop the discovery ladder after the highest known pass and first confirmed
  failure are identified.
- Narrow between them using integer midpoint/binary search until adjacent or
  until the configured resolution is met. Any narrowing failure that would
  replace the upper boundary is confirmed using the same state machine.
- After boundary narrowing, calculate and, if necessary, explicitly measure the
  safe-capacity candidate using the policy below.
- A scan is provisional evidence, never a certified maximum.

### Certify

- Prefer `--from-scan=PATH`, which supplies both the highest pass and first
  failing boundary. Alternatively accept explicit `--pass-rate=N
  --fail-rate=M` with `M > N`.
- `--rate=N` is a candidate-only stability certification: it runs the configured
  repeats but cannot claim a certified boundary or safe capacity because no
  failing bound was supplied.
- Verify that commit, harness revision, dataset, target fingerprint, topology,
  config, background mode, cache mode, and workload contract match.
- Use longer configured warmup and measurement periods.
- Run the highest passing candidate three times and the first failing boundary
  three times by default.
- A candidate passes only if every required repeat passes. Failed and passing
  repeats from different bindings cannot be combined.
- The safe-capacity label still requires measured safe-candidate evidence; a
  mathematically derived value alone is insufficient even when the boundary
  itself is certified.
- Certify runs the selected safe candidate for the configured three repeats as
  well, unless it is identical to another rate whose same-binding three-repeat
  evidence already satisfies every safe-capacity gate. A one-off scan pass
  cannot by itself produce a certified-safe label.
- A fresh target/baseline restore is allowed once before certification, but not
  between every repeat unless mutation analysis proves it necessary.

### Compare

- Create immutable worktrees/builds for the current revision and `<git-ref>`.
- Run the same fixed-rate comparison suite against the same target fingerprint,
  dataset, users, cache/background modes, and config.
- Reset to the same logical baseline between revisions.
- Alternate or randomize revision order when practical to reduce thermal/time
  bias, and record the order.
- Refuse comparison when fingerprints differ materially.
- By default run the same bounded scan policy for both revisions so a capacity
  delta is available when both discover a boundary. A `--rates=` fixed-rate
  comparison reports only common-rate latency/resource/Top-SQL deltas and
  explicitly omits capacity delta unless both sides independently observed a
  passing and failing boundary. Do not claim improvement from incomparable
  runs.

### Reset

`./perf reset` is cheap and idempotent. It may only operate on a database and
containers bearing the performance ownership marker. It resets:

- controlled fixture users to their baseline state;
- test-generated step samples and idempotency records;
- race-resolution jobs, retry rows, and post-task rows created by the run;
- test-generated notifications and queue entries;
- test session/token state;
- metrics epochs and `pg_stat_statements`;
- namespaced Redis keys as directed by cache mode.

The exact table allowlist will be derived from an exhaustive before/after
mutation audit of one complete Home transaction during harness development and
revalidated during dataset refresh/certification. Ordinary levels do not scan
the full database for unexpected mutations: reset runs transactional,
allowlisted deletes/updates and verifies bounded counts/checksums only over
run-owned rows. It must never use a broad truncate or delete against an
unmarked DB.

Deterministic targeted reset within the ceremony budget is a prerequisite for
enabling scan. A one-time restore may recover a dirty target before workflow
startup, but it cannot solve unrecoverable mutations created by earlier ladder
levels. If the mutation audit shows that targeted cleanup cannot restore the
logical baseline, scan setup fails and the run-owned namespace/reset design
must be changed before multi-level scanning is allowed.

### Refresh data

`./perf refresh-data` is the only workflow allowed to read production. It:

1. obtains a consistent snapshot through read-only production credentials;
2. restores it into an isolated, performance-marked database;
3. runs the existing scrubber;
4. removes tokens, credentials, notification destinations, secrets, and PII;
5. runs negative sanitization assertions and representative cardinality checks;
6. saves sanitized dump bytes outside Git;
7. writes non-sensitive `performance/data/baseline.json` metadata.

Metadata records dataset ID, source snapshot time, schema/migration revision,
scrubber version/hash, dump hash, selected table counts/bands, creation time,
and validation status. Normal runs resolve the dump via an ignored local path
or configured artifact store. Snapshot bytes must never enter Git or reports.

## Dataset and fixture contract

The sanitized baseline preserves production-shaped row counts, distributions,
indexes, and planner statistics. It is periodically refreshed rather than
implicitly refreshed by a test.

Deterministic test users are layered onto the baseline and divided into cohorts:

- ordinary user with a small number of active races;
- user with several active/public/private races;
- user with many friends and pending requests;
- ranked participant with notifications and rewards;
- heavier-than-average Home state.

Configuration defines cohort weights and pool size. A run manifest records the
distribution. Users must not all share identical records. Tokens are created
automatically, kept out of reports, rotated with the dataset/run, and removed
by cleanup.

## Cache modes

- `warm` is the default for smoke and scan and represents steady-state
  production. A bounded representative subset of the configured fixture cohort
  is prewarmed once at workflow startup using GET-only Home reads. Its rate and
  maximum users are centrally configured so it cannot become an unmeasured
  step-sync/queue load stage. Each level uses the same established warm state; it does
  not inherit an accidental cache-shape dependency on which ladder rates ran
  earlier. Per-level warmup refreshes normal TTLs before metrics reset.
- `cold` clears only performance-owned/cache-prefix keys, begins measurement
  from an explicitly empty relevant cache, and is reported as cold-start data.
  Its final prefix clear and empty-census proof occur after non-cache-filling
  stabilization and immediately before metric reset/measurement. It never
  recreates Redis and does not alter the warm-cache path.

Redis is not recreated between scan levels. Reports always name the cache mode
and whether the expected starting key census was verified.

## Background workload modes

- `off`: run the two HTTP workers and required resolution behavior while
  disabling nonessential scheduled jobs through capacity-only process topology,
  never through a production runtime flag.
- `normal`: run the production-equivalent resolution and cron processes with
  the production configuration overlay. This is the default practical-capacity
  mode.
- `stress`: reserved for a later explicit synthetic background workload.

The mechanism must be structurally impossible to enable as a production flag.
Provider process selection and the existing `CAPACITY_MODE` guard are preferred.
Reports compare HTTP-only and normal capacity when both are run. Background SQL
and queue work must be tagged or attributable by process/time window.

## Central configuration and thresholds

All rates, durations, deadlines, topology, cohorts, cache/background modes,
headroom, and thresholds live in versioned config. Environment variables are
reserved for secrets and machine-specific paths.

Configuration also owns smoke/scan/certify warmup durations and bounds, the
60-second scan discovery duration, failure-confirmation/majority policy,
safe-capacity rounding and downward-step policy, prepared-scan 15-minute target,
20-minute warning threshold, and runtime-breakdown categories.

The effective centrally validated configuration is equivalent to:

```json
{
  "smoke": { "rate": 5, "warmupSeconds": 30, "measurementSeconds": 120 },
  "scan": {
    "rates": [5, 10, 15, 20, 25, 30],
    "warmupSeconds": 15,
    "maxNormalWarmupSeconds": 30,
    "measurementSeconds": 60,
    "confirmBoundaryFailure": true,
    "maxAttemptsAtBoundaryRate": 3,
    "classificationPolicy": "majority",
    "preparedRuntimeTargetSeconds": 900,
    "runtimeWarningSeconds": 1200
  },
  "certify": {
    "warmupSeconds": 60,
    "repeats": 3
  },
  "safeCapacity": {
    "headroomFactor": 0.8,
    "rounding": "ceiling",
    "fallbackStepPerSecond": 1,
    "requireMeasuredPass": true
  }
}
```

The certify measurement duration remains centrally configured by the existing
long-duration stability policy; changing it is outside this adjustment.

Initial thresholds retain the existing current-client gates until a baseline
run supplies evidence for changing them:

- complete Home p95 <= 1,000 ms;
- complete Home p99 <= 2,000 ms;
- no incomplete critical Home transactions;
- no dropped measured arrivals;
- no Home network errors;
- SUT HTTP failure rate < 0.1%;
- sync-v2 p95 <= 750 ms and p99 <= 1,500 ms;
- legacy step fallback p95 <= 2,000 ms and p99 <= 5,000 ms.

Threshold classes are:

- **hard failure:** timeouts, incomplete transactions, worker crash/restart,
  dropped arrivals, severe connection exhaustion, invalid/missing evidence;
- **capacity threshold:** user-visible latency, sustained unsafe CPU, pool wait,
  continuously growing queue, or resource saturation;
- **diagnostic warning:** elevated SQL/Redis/queue metrics that did not cross a
  pass/fail gate.

CPU and queue defaults must not be invented before the first instrumented
baseline. The initial implementation records them and labels their thresholds
`baseline-required`; the reviewed baseline then establishes versioned defaults.

The evaluator emits a stable versioned `failureReason` independently of
bottleneck classification. Initial values are:

```text
home_p95_threshold
home_p99_threshold
http_error_rate
network_errors
incomplete_home_transactions
dropped_arrivals
worker_restart
db_connection_exhaustion
queue_growth
resource_safety_threshold
timeout
multiple
unknown
```

If exactly one capacity/hard gate fails, its mapped reason is used. Multiple
distinct reasons produce `multiple`; missing or unrecognized evidence produces
`unknown`. The human report includes the observed value and threshold, not only
the enum. For a confirmed boundary, the reason is aggregated from the failed
attempts that determine its final classification. If those attempts fail for
different gate families, the boundary reason is `multiple`; passing attempts
that made the rate unstable remain visible but do not invent a failure reason.

## Safe operating capacity

Every scan/certification reports the observed boundary and separately derives
and verifies safe operating capacity:

1. Require a highest passing tested rate and first confirmed failing rate. If
   either is absent, omit definitive safe capacity and report `at least N/sec
   tested` where applicable.
2. Multiply the highest passing rate by the configured headroom factor (initial
   proposal: 80%) to produce the decimal mathematical headroom target.
3. Convert the target to a practical positive integer using deterministic
   ceiling rounding (`ceil(target)`), so `19.2/sec` becomes `20/sec`. This
   preserves at least the requested integer throughput; the candidate may never
   exceed the highest passing rate and gains no safety label until measured.
4. If that exact candidate already has valid measured evidence under the same
   run binding, reuse it. Otherwise explicitly run the candidate rate.
5. Label it `safe operating capacity` only if it passes every ordinary capacity
   gate plus configured safe-capacity resource-headroom and bounded-queue gates.
6. If it fails, decrement by the configured integer step (default `1/sec`) and
   measure each candidate until one passes or rate `1/sec` fails. Never skip an
   unmeasured candidate or interpolate upward.
7. If no candidate passes, report safe capacity as unavailable with the failure
   evidence.

The headroom factor, rounding rule, downward step, mathematical target, initial
tested candidate, every fallback candidate, and final measured safe rate are
recorded in config and results. A scan's safe rate is measured/provisional; a
certification's safe rate is certified only when its supporting evidence meets
the configured three-repeat certification policy. The policy is never silently
changed based on a run's outcome.

## Instrumentation

### PostgreSQL

Enable and verify `pg_stat_statements`. Reset it immediately before every
measured level, then capture normalized fingerprint, calls, total and mean
execution time, rows, shared hits/reads, temp blocks, and percentage of captured
DB execution time. Also sample database CPU/memory, active/waiting connections,
locks, long queries, commits/rollbacks, block hit/read behavior, and database
size. The report includes Top SQL for every level and highlights failure-window
queries.

### Node workers

Reuse and extend existing health/database-pool telemetry to record each process
identity independently: CPU, RSS, heap used/total, event-loop delay p50/p95/p99,
event-loop utilization, DB pool waits/errors, and restart/crash count. Process
census must prove exactly `http:0`, `http:1`, `resolution:0`, and, in normal
mode, `cron:0`.

### Redis

Sample CPU, memory, connected and blocked clients, operations/sec, keyspace
hits/misses, evictions, and latency. This is intentionally a lightweight
`INFO`/latency sampler sufficient to accept or reject Redis as the bottleneck.

### Host and generator

Sample host CPU, load, memory, swap, disk I/O/utilization, network, and process
CPU breakdown. Record generator CPU, dropped iterations, scheduler lag, and its
host identity separately so generator saturation cannot be blamed on the SUT.

### Queues

For race-resolution and relevant global-event work, capture queue depth, oldest
item age, insert/process rates, processing latency, failures, retries, effective
worker concurrency, and post-level drain behavior. Queue growth is evaluated as
a slope across the measured window, not solely a final count.

## Result contract

Each run has a unique ID and writes ignored artifacts under:

```text
performance/results/<run-id>/
  manifest.json
  summary.json
  report.md
  k6/summary.json
  postgres/top-sql.json
  node/metrics.json
  redis/metrics.json
  host/metrics.json
  queues/metrics.json
  levels/<rate>/...
```

Files are only created when they contain useful evidence. `manifest.json`
records application SHA, harness SHA, dataset ID/hash, Node/Postgres/Redis/k6
versions, OS, CPU, RAM, worker count, target/provider fingerprint, background
mode, cache mode, effective config, and timestamps without secrets.

`summary.json` has a versioned schema and at minimum:

```json
{
  "schema": "bara-perf-summary-v2",
  "runId": "...",
  "mode": "scan",
  "commit": "...",
  "dataset": "prod-sanitized-2026-09-01",
  "backgroundMode": "normal",
  "cacheMode": "warm",
  "highestPassingRate": 24,
  "firstFailingRate": 25,
  "rateClassifications": [
    {
      "rate": 25,
      "state": "FAIL",
      "passes": 0,
      "failures": 2,
      "unstable": false,
      "attempts": [{ "outcome": "FAIL" }, { "outcome": "FAIL" }]
    }
  ],
  "headroomPolicy": 0.8,
  "calculatedHeadroomTarget": 19.2,
  "safeCapacityCandidateTested": 20,
  "safeCapacityCandidates": [
    { "rate": 20, "passedSafeCapacityGates": true }
  ],
  "safeHomeOpensPerSecond": 20,
  "failureReason": "home_p95_threshold",
  "failureReasonDetail": {
    "observed": 1480,
    "threshold": 1000,
    "unit": "ms"
  },
  "primaryBottleneck": "postgres",
  "scanRuntimeSeconds": 778,
  "runtimeBudgetWarning": false,
  "runtimeBreakdownSeconds": {
    "environmentPreparation": 0,
    "workflowValidation": 8,
    "initialPrewarm": 30,
    "targetedResets": 18,
    "settlingDraining": 24,
    "perLevelWarmups": 135,
    "measuredLoad": 300,
    "failureConfirmation": 60,
    "boundaryNarrowing": 180,
    "metricsCollection": 18,
    "reportGeneration": 2,
    "cleanup": 3
  }
}
```

`report.md` begins with what was tested, what passed/failed, safe capacity,
confirmed failure boundary, calculated headroom target, tested safe candidate,
failure reason, primary bottleneck, total runtime, and confidence/limitations.
It records every rate classification (`PASS`, `FAIL`, or `UNSTABLE`), repetition
votes, instability, and actual warmup duration. It then includes the
rate/latency/error table, resource peaks, Top SQL, background impact, queue
behavior, detailed runtime breakdown, warnings, and actionable evidence. Report
generation is deterministic from machine-readable artifacts.

Its opening uses separate sections, for example:

```text
FIRST FAILURE
25 Home opens/sec failed because Home p95 reached 1.48 seconds,
above the configured 1.0-second threshold.

PRIMARY BOTTLENECK
PostgreSQL. DB CPU reached 94%, while both HTTP workers remained
below 55% CPU and event-loop delay remained healthy.
```

## Failure-reason and bottleneck classification

`failureReason` answers why the first failing rate violated the capacity
contract. It is derived directly from failed gates and contains the stable enum,
observed measurement, configured threshold, and explanatory text.

`primaryBottleneck` answers which underlying subsystem most likely caused the
degradation. It is a separate inference and must never be populated merely by
copying the failed threshold.

The evaluator uses explicit, versioned rules and evidence completeness:

- **PostgreSQL:** DB CPU/IO/connection pressure reaches its gate while Node and
  generator remain healthy, with Top SQL accounting for material DB time.
- **Node:** HTTP worker CPU or event-loop delay saturates while DB/Redis remain
  below gates.
- **DB pool/concurrency:** checkout waits/failures grow without underlying DB
  resource saturation.
- **Redis:** latency/CPU/blocked clients/evictions cross gates and correlate with
  Home latency.
- **queue throughput:** backlog and oldest age grow throughout the window and
  processing rate remains below insertion rate.
- **generator:** k6 drops arrivals or scheduler lag/CPU saturates.
- **multiple** or **inconclusive:** used whenever evidence cannot isolate one
  subsystem. The harness must never fabricate certainty.

Stable initial `primaryBottleneck` values are `postgres`, `node`, `db_pool`,
`redis`, `queue`, `generator`, `multiple`, and `inconclusive`.

## Safety requirements

- Refuse `steptracker-api.org`, production/staging aliases, public production
  IPs, and non-loopback targets unless they match an explicitly approved remote
  performance-target record.
- Refuse all destructive DB/reset operations unless the DB name and a durable
  database marker both identify a disposable performance database.
- Disable k6 redirects. Resolve and pin the target before traffic, continuously
  bind requests to a capacity-only health identity containing the expected run
  ID, and abort on redirect, DNS/address drift, or identity mismatch.
- Keep production snapshot credentials usable only by `refresh-data`. Its
  dedicated source connection must verify transaction read-only mode and must
  never be reused as the writable restore/scrub connection. Every restore,
  scrub, fixture, or reset write still requires a different connection whose
  target has the durable performance-DB marker.
- Start runtime children from an explicit environment allowlist with outbound
  push/email/cloud providers disabled.
- Never write snapshot bytes, tokens, passwords, PII, or secret-derived values
  to Git or reports.
- Preserve resource labels and ownership verification for destructive cleanup,
  bounded command timeouts, and a useful partial failure summary. Provider
  locking is retained only around actual shared-provider mutations, not around
  read-only measurement. Atomic writes are required for the top-level manifest,
  summary, and report; append-only journals and immutable per-level artifact
  forests are not required for scan.
- Cleanup may remove only resources whose names and labels match the exact run
  and performance owner.
- No command performs git pull, deploy, Prisma migration against production, or
  production service restart.

## API, data model, frontend, and compatibility

### API contract

No public endpoint is added or changed. Capacity telemetry continues through
the capacity-only health surface and must remain unavailable unless
`CAPACITY_MODE=true` and the request/run identity matches. Existing app request
and response contracts are unchanged.

### Data model and migrations

No production migration is planned. Performance dataset metadata and local
ownership markers live outside production application tables where possible.
Any helper schema created inside the performance DB must use a dedicated
`perf_harness` schema, be installed only after the disposable marker is
verified, and never be added to the production Prisma migration chain.

### Frontend plan

No Flutter changes are required. The existing Home flow is the workload source
of truth. A structural parity test will compare the k6 transaction contract
against the documented frontend requests and fail when the frontend changes
without a workload review.

### Backward compatibility and rollout

There is no customer-facing rollout and no feature flag. Old and current apps
continue using the same backend. Harness changes ship independently and cannot
alter production behavior. If capacity-only telemetry code is extended, it
must default to absent outside `CAPACITY_MODE`, preserving production startup
and responses exactly.

## Implementation phases

### Phase 1 — discovery and migration documentation

- Land this requirements document and `performance/README.md`.
- Capture the current command/data/process/request/metrics/result map.
- Mark old modules and individual safeguards as reuse, refactor, certify-only,
  or retire; record their runtime cost; do not delete them yet.
- Maintain a validation-cost inventory with columns: step, failure prevented,
  measured runtime, tier/cadence, reuse invalidator, and disposition.

### Phase 2 — core CLI

- Add `./perf`, validated layered config, run manifests, production guards, and
  provider interface.
- Implement `smoke` against the reusable Lima environment and reuse the
  existing k6 workload/evaluator initially.
- Build the scan ladder/evaluator seams, but do not route `scan` through the
  legacy per-level restore/recreation lifecycle.
- Implement `PASS`/`FAIL`/`UNSTABLE` rate voting, confirmation of every
  boundary-defining failure, the safe-candidate measurement algorithm, stable
  failure-reason enums, and separate bottleneck inference as pure tested logic.

### Phase 3 — reusable environment and dataset

- Add baseline metadata/validation and `refresh-data`.
- Keep Postgres/Redis/backend running across scan levels.
- Implement mutation audit and targeted `reset`.
- Add explicit warm/cold cache semantics.
- Remove repeated source, schema, snapshot-attestation, sanitization, topology,
  and service-freshness checks from the per-level scan path.
- Only after this phase is complete, enable the end-to-end `./perf scan` command.
- Enforce bounded mode-specific warmups, the 60-second discovery default, the
  15-minute prepared-scan target, and the prominent over-20-minute warning.

### Phase 4 — complete instrumentation

- Add per-level `pg_stat_statements` reset/export.
- Fill gaps in per-worker Node, Redis, host, and queue measurements.
- Add background `off` and `normal` process topologies.

### Phase 5 — deterministic reporting

- Produce `summary.json` and `report.md` for success, capacity failure, setup
  failure, interruption, and cleanup failure.
- Add evidence-aware bottleneck classification.
- Report failure reason separately from primary bottleneck; include instability,
  mathematical headroom target, tested safe candidates, final safe rate, total
  scan runtime, budget warning, and the complete runtime breakdown.

### Phase 6 — certification

- Implement focused long repetitions at passing and failing boundaries.
- Certify the separately calculated safe candidate for three repeats unless
  equivalent same-binding boundary evidence already covers it.
- Validate run-to-run variance and document confidence.

### Phase 7 — comparison

- Implement immutable two-revision builds, identical bindings, reset between
  revisions, and delta reporting.

### Phase 8 — production-shaped remote target

- Add an allowlisted remote provider, preferably the same cloud/server family
  as production, without changing workload or result formats.
- Keep provisioning optional so it cannot block the core local workflow.

## Tests-first plan

Before business logic, add failing tests for:

- CLI parsing, help, invalid options, and exit codes;
- layered config validation and centralized thresholds;
- production API/DB/IP rejection and performance marker enforcement;
- redirect disabling, resolved-target pinning, capacity health identity, and
  abort behavior on redirect/address/identity drift;
- refresh-data read-only source connection separation from marked writable
  restore/scrub targets;
- baseline metadata/hash/sanitization validation;
- deterministic fixture cohorts and automatic token generation;
- Home workload/frontend contract parity and response-dependent fallback graph;
- smoke lifecycle ordering and warmup exclusion;
- prepared-environment fast-path invalidation and startup/per-operation timing;
- scan ladder, early stop, narrowing, and one-run-per-discovery-level behavior;
- failure confirmation (`FAIL/FAIL`), unstable deciding votes (`FAIL/PASS/*`),
  majority classification, and confirmation of narrowing failures that replace
  the upper boundary without repeating ordinary pass levels;
- an all-inclusive per-level ceremony timer, bounded settle failure, and proof
  that expensive lifecycle operations are never called between scan levels;
- targeted reset mutation allowlist, idempotence, and post-reset checksum proof;
- warm and cold Redis semantics;
- background off/normal process census;
- `pg_stat_statements` reset and normalized Top SQL extraction;
- Node/Redis/host/queue metric schema validation;
- hard/capacity/warning evaluation;
- safe-capacity decimal target, ceiling rounding, explicit candidate execution,
  same-binding evidence reuse, decrement-by-one fallback, and refusal to label
  an unmeasured or failed candidate safe;
- stable failure-reason mapping, `multiple`/`unknown` behavior, separate
  bottleneck classification, and inconclusive bottleneck evidence behavior;
- centrally configured warmups, actual-vs-budget recording, warm-mode proof
  that full prewarm/setup does not repeat, and cold-cache separation;
- cold-mode ordering that permits only non-cache-filling stabilization, then
  clears/verifies the owned prefix immediately before metric reset/measurement,
  with no request-generating warmup after the clear;
- 60-second discovery default, prepared-scan total runtime, non-overlapping
  runtime categories, 15-minute target, and over-20-minute warning;
- deterministic `summary.json`/`report.md` generation;
- environment fingerprint equality for compare/certify reuse;
- cleanup ownership and interrupted-run partial reporting.

Integration tests use a disposable `*_test` PostgreSQL database and local Redis,
exercise the public Home endpoints through the actual server, and verify that
two consecutive levels reuse the same environment while reset restores the
controlled baseline. They must never point at production. A provider rehearsal
proves the Lima lifecycle before a real load run.

## Acceptance criteria and definition of done

- `./perf smoke` and `./perf scan` work end-to-end without Codex or manual token
  copying.
- An already-prepared smoke completes in under five minutes.
- Scan restores the baseline at most once and reuses the same Postgres, Redis,
  and backend processes across levels.
- Scan performs expensive source/dataset/schema/sanitization/topology validation
  at most once, and its per-level ceremony meets the configured 15-second
  target or reports the exact exception.
- One k6 iteration matches the current full Home network graph and reports
  complete successful Home opens/sec.
- Scan stops at and narrows the first pass/fail boundary without three repeats
  at every discovery rate. A single failure never establishes or replaces the
  boundary: it is confirmed, inconsistent outcomes become `UNSTABLE`, and at
  most one deciding repetition produces a majority classification.
- Warmup is excluded from measured metrics, centrally bounded by mode, recorded
  for every level, and warm/cold cache mode is explicit. Warm scan prewarms the
  bounded representative cache cohort once with GET-only traffic and never
  recreates/clears Redis or repeats environment,
  database, or fixture setup between rates.
- Cold scan performs non-cache-filling stabilization first, then clears and
  verifies only the performance-owned prefix immediately before measurement;
  it never request-warms after that clear, recreates Redis, or changes warm-mode
  sequencing.
- Background `off` and `normal` are distinct, verified topologies.
- Reports contain environment binding, capacity table, instability/vote
  evidence, calculated headroom target, tested safe candidate(s), measured safe
  capacity or an evidence-based reason it is unavailable, failure reason,
  primary bottleneck or `inconclusive`, Top SQL, per-worker Node data,
  Redis/host/queue evidence, total/runtime breakdown, warnings, and report path.
- No untested mathematical value is presented as safe capacity. The candidate
  produced by ceiling rounding is explicitly measured when same-binding
  evidence does not already exist; a failure deterministically steps down by
  `1/sec` until a measured safe candidate passes or none remains.
- An already-prepared scan uses 60-second discovery measurements by default,
  targets <= 15 minutes end to end, and emits a prominent warning above 20
  minutes with a complete explanation of where time was spent.
- Safety tests prove that production targets and unmarked DB resets are refused.
- `./perf certify` focuses three configured repetitions on the boundary and
  does not repeat full environment construction per run.
- Candidate-only certification cannot claim safe capacity or a failure boundary.
- A certification cannot label a safe rate certified from a single scan
  measurement; the safe candidate requires three same-binding certification
  passes unless already covered by equivalent boundary repeats.
- `./perf compare main` refuses mismatched bindings and produces deterministic
  performance deltas, omitting capacity delta when its mode did not discover
  both boundaries.
- Two repeated smoke runs and two repeated fixed-rate scan levels on an idle
  target have no unexplained material result variance; the initial acceptance
  band is recorded from real observations rather than invented in advance.
- Relevant unit and disposable integration tests pass; the existing protected
  assertions are not weakened.
- The legacy workflow remains available until smoke, scan, reset, safety,
  evidence, and report parity are verified and the operator approves removal.
- No production traffic, write, deployment, or destructive operation occurs.

## Migration decisions: keep, simplify, retire later

### Keep and refactor

- `scripts/k6/home-open.js` complete open-loop Home transaction.
- Home fixture topology and deterministic user logic.
- snapshot scrubber, attestation, and sanitization validators.
- capacity DB marker and production target guards.
- exact two-HTTP-worker process topology and role DB pool budgets.
- existing event-loop/database-pool and queue telemetry.
- Lima resource ownership labels, locks, timeouts, and safe cleanup.
- once-per-workflow source/dataset/environment fingerprints and partial failure
  summaries. Immutable evidence journals and repeated attestations move to
  certification-only unless a cheaper implementation has negligible cost.

### Simplify

- prepare dependencies and the VM only when the binding changes;
- restore the sanitized baseline once per workflow, not once per level;
- keep Postgres, Redis, and backend processes alive during a scan;
- use targeted reset and explicit cache modes between levels;
- replace per-child confirmation/evidence ceremony with one run manifest plus
  per-level metric epochs;
- write one top-level report instead of requiring manual artifact aggregation;
- use a short fixed scan ladder plus narrowing and reserve repetitions for
  certification.

### Retire after parity

- the Home-specific operator path through `npm run capacity:home`;
- full restore and unique service recreation for every discovery level;
- manual multi-command aggregation of Home reports;
- duplicated config values embedded across k6/orchestrator scripts.

The underlying legacy scripts remain for non-Home profiles unless separately
migrated.

## Risks and mitigations

- **State leakage between levels:** mutation audit, allowlisted targeted reset,
  checksums/counts, unique run namespaces, and periodic full-restore validation.
- **Warm-cache optimism:** explicit cold mode and cache-state evidence.
- **Dataset aging:** dataset IDs, refresh cadence metadata, cardinality drift
  warnings, and periodic manual refresh.
- **Local hardware claims:** label Lima results as regression evidence and
  reserve absolute production certification for a remote production-shaped
  target.
- **Background nondeterminism:** explicit modes, stable startup/settling,
  per-process attribution, and recorded job/queue state.
- **Generator bottleneck:** run k6 outside the target and record generator
  saturation evidence.
- **Harness drift:** record harness SHA/config and reject incomparable runs.
- **Ceremony regrowth:** tests assert that forbidden expensive lifecycle calls
  occur zero times between scan levels, and timing output makes overhead visible.

## Open questions

None block the proposed design. Initial CPU/queue gates and the reproducibility
tolerance intentionally require evidence from the first instrumented baseline;
they will be recorded as a reviewed config revision rather than guessed now.

## Revision log

- **Draft:** Replaced the per-level disposable-child model with a reusable
  environment, persistent sanitized baseline, targeted reset, explicit cache
  and background modes, provider-neutral CLI, full instrumentation, and
  deterministic reports.
- **Fresh-eyes pass 1:** Added the mutation audit, reset checksums, dataset
  aging metadata, generator isolation, no-certainty bottleneck rule, and a
  lifecycle target for smoke.
- **Fresh-eyes pass 2:** Clarified visible Home completion versus non-blocking
  suggestions/resolution settlement; added compare-order bias control,
  background-mode safety, threshold classes, remote-target constraints, and
  explicit legacy retirement gates.
- **User clarification:** Separated cheap incident-prevention guards from
  expensive isolation/provenance evidence. Moved repeated source/schema/data/
  sanitization/service verification and immutable evidence ceremony out of
  scan levels, added an explicit per-level overhead budget, and reserved
  certification-grade evidence for certify/compare/refresh workflows.
- **Architect review:** Made the scan ceremony budget all-inclusive; moved the
  exhaustive mutation audit out of ordinary levels; defined prepared-target
  invalidation and startup limits; prevented the first scan implementation
  from wrapping the legacy child lifecycle; hardened redirect/DNS/refresh-data
  guards; versioned the foreground Home workload; and completed certification
  and comparison boundary contracts.
- **Architect re-review:** Removed the invalid once-per-workflow restore fallback
  for unrecoverable between-level mutation. Deterministic targeted reset is now
  an explicit prerequisite for enabling multi-level scan.
- **Approved adjustment pass:** Required measured safe-capacity candidates with
  deterministic ceiling/downward search; confirmed scan failures with
  `PASS`/`FAIL`/`UNSTABLE` majority voting; bounded mode-specific warmups;
  introduced a 15-minute prepared-scan target and 20-minute warning with full
  runtime accounting; and separated stable failure reasons from inferred
  primary bottlenecks throughout config, schemas, tests, phases, and acceptance
  criteria.
- **Adjustment architect review:** Split warm- and cold-cache level ordering so
  cold measurement cannot be accidentally prewarmed. Cold mode now clears and
  proves only the owned prefix after non-cache-filling stabilization and
  immediately before measurement, without Redis recreation.
