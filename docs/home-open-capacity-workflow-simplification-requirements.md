# Home-open capacity workflow simplification requirements

**Status:** Approved for implementation
**Repository:** `stepv2-backend`
**Profile:** existing `home-open` production-shaped capacity profile

## Summary and user story

An operator needs to answer two distinct questions without manually coordinating
the capacity lifecycle:

1. **Scan:** approximately where does the current Home-open bottleneck begin?
2. **Certify:** what is the highest repeatable Home-open arrival rate that meets
   the existing capacity gates, and what conservative operating ceiling follows?

Today the underlying experiment exists, but the operator must repeatedly run
`capacity start`, `load-test:k6:home-open`, and `capacity destroy`, choose unique
run IDs, carry forward the prior passing rate, bracket failures, run three
boundary repetitions, and aggregate reports. The manual surface makes a simple
capacity question slow and error-prone.

The feature adds one backend-owned orchestration command that preserves the
existing safety and evidence contracts while reducing the normal interface to:

```sh
npm run capacity:home -- scan
npm run capacity:home -- certify
npm run capacity:home -- level --rate 24
```

The operator receives one concise terminal summary and one top-level report.
The existing detailed immutable artifacts remain available for diagnosis.

Before requesting confirmation, the command prints a best/worst-case duration
estimate derived from its exact smoke, warm-up, measurement, drain, reset, and
maximum-child policy. During execution it updates the estimate from observed
reset and drain durations. Estimates are labeled estimates, not deadlines.

## Goals

- Make a production-shaped Home capacity scan a single command.
- Make a defensible, repeated Home capacity certification a single command.
- Automatically generate immutable run and level identifiers.
- Automatically select ladder and bracket rates from observed pass/fail results.
- Prepare the selected source revision once per workflow, while restoring clean
  database and Redis state before every measured level.
- Preserve the exact backend, database, Redis, pool, process, outbound-isolation,
  scrub-attestation, generator, and evidence requirements already enforced by
  the `home-open` harness.
- Always emit a useful partial report after a failure, interruption, or cleanup
  problem.
- Continue printing a progress update at least once per minute during load.

## Non-goals

- This does not change the Home API, mobile Home screen, or request graph.
- This does not change production or staging hardware, processes, pool budgets,
  resolution concurrency, queue behavior, or runtime behavior.
- This does not contact production or staging, create a production snapshot, or
  accept production credentials.
- This does not replace the `full-app`, global-event, event-open, or step-sync
  capacity profiles.
- A scan is not a certified maximum and cannot be presented as one.
- This does not infer DAU from Home opens/second. The report may show opens per
  minute and measured concurrent sessions, but not an unsupported user count.
- This does not introduce a feature flag, rollout switch, API endpoint, schema
  migration, or app change.

## Existing system and reuse points

- `scripts/capacity.js` owns guarded lifecycle confirmation and invokes the
  provider hook.
- `scripts/lima-capacity.js` enforces the 7-vCPU/12-GiB containing VM and the
  production-shaped backend 4-vCPU/8-GiB, Postgres 1-vCPU/2-GiB, Redis, and
  overhead allocations. It currently recreates Postgres/Redis during restore
  and installs backend dependencies during every backend start.
- `scripts/k6-home-open.js` owns fixture creation, resolution readiness,
  pool-measurement reset, k6 execution, queue drain, cleanup, verification,
  progress, and immutable per-level artifacts.
- `scripts/k6/home-open.js` owns the open-loop shipped Home session.
- `src/modules/loadTesting/runner.js` owns the current pass/fail gates.
- `docs/capacity-load-runbook.md` is authoritative for existing operational and
  safety rules. This feature shortens its operator path; it does not weaken its
  underlying contracts.

## Operator contract

### Common configuration

All modes require the existing local, uncommitted capacity secrets and approved
configuration. The orchestrator loads `.env.capacity.local` itself using
`dotenv`; the shell no longer needs `set -a`/`source` commands. Missing secrets,
snapshot, attestation, parity overlay, k6, Lima, or Docker fail during preflight
before a measured level begins.

The checked-out source tree is the system under test. By default it must be a
clean checkout of `main` whose `HEAD` equals local `main`. An explicit
`--expect-commit <sha>` may validate another already-checked-out clean commit for a
diagnostic run. The command never performs `git fetch`, `git pull`, checkout,
deployment, or any network mutation.

`--expect-commit` is descriptive validation, not source mutation: it must equal the
current `HEAD`. Testing another revision requires the operator to check it out
before invoking the workflow. Untracked files outside ignored result/secrets
paths and any tracked modification fail preflight because the capacity claim
must bind to reproducible executed source.

After preflight, the orchestrator creates a read-only immutable source bundle
only from the confirmed tracked `HEAD`. Run-local ignored configuration,
secrets, snapshot, and attestation remain separate explicitly validated inputs
and can never enter the source bundle. It rejects symlinks escaping the repository and hashes the
canonical path, mode, length, and bytes of every member into a full bundle hash.
Every child backend container executes this bundle, never the live checkout.
The bundle is reverified before each child, so concurrent edits after
confirmation cannot change code during the workflow.

Each child environment is constructed from explicit capacity and parsed parity
allowlists; it never inherits the operator shell wholesale. Reports record all
non-secret effective values and HMAC-only fingerprints of required secret
inputs so changed inputs cannot be mixed without exposing secrets.

Every invocation creates a workflow ID such as
`home-20260901t204405-52ac28a`. Every level derives a unique immutable run ID,
for example `home-20260901t204405-52ac28a-scan-r20`. Existing artifacts are
never overwritten.

Before confirmation, the orchestrator writes an immutable workflow manifest
containing the workflow ID, selected mode, commit/source hash, snapshot and
attestation hashes, approved resource manifest, rate policy, timing policy, and
maximum possible child-run count. Confirmation prints and binds to the
workflow-manifest hash. After confirmation, child run IDs must be deterministic
descendants of that workflow and must satisfy the confirmed policy. Changing a
bound input invalidates confirmation and requires a new workflow. This replaces
per-level confirmation without creating a general confirmation bypass.

Common overrides are deliberately narrow:

```text
--config <path>       default docs/capacity-load.config.json
--expect-commit <sha> default current clean main HEAD
--start-rate <n>      optional first scan/certify rate
--max-rate <n>        integer 2..500 budget; never a measured failure
--from-scan <path>    certify from an exactly compatible completed scan
```

There is no safety bypass, production target option, arbitrary base URL,
arbitrary database name, or non-interactive confirmation bypass.

By default, `reset-data` cleanup deletes all restored database volumes, Redis state,
fixtures, run credentials, and running containers, then retains the stopped,
empty approved Lima VM plus dependency cache for future speed. Retained cache
contains no database or application secrets and remains content-addressed to
the preparation binding. A separate explicit low-level `delete-vm` maintenance
action deletes that shell/cache; normal workflows never do so.

### `scan`

`scan` provides a provisional capacity range for development and bottleneck
work. It performs:

1. guarded preflight and one exact interactive confirmation bound to the
   immutable workflow manifest, commit/source hash, snapshot hash, scrub
   attestation, resource manifest, timing/rate policy, and child-run limit;
2. one environment preparation for the selected commit;
3. one smoke level;
4. short adaptive ladder levels until the first failure or `--max-rate`;
5. optional short bracketing until the pass/fail gap is within 10% or two Home
   opens/second, whichever is larger;
6. a partial/final scan report;
7. reset all data/services and stop the retained empty VM.

A scan uses a 30-second warm-up and 120-second measured window per non-smoke
level. Smoke offers 1 Home open/second for 60 seconds. These scan timings must
be tagged in evidence and cannot satisfy certification rules.

The default ladder is `2, 5, 10, 20, 30, 40, 60, 80, 100`, followed by the
existing `150, 225, 340, 500` extension when necessary. If the first tested
rate fails, the orchestrator tests lower positive integer rates until it either
finds a pass or reports that smoke is the only passing evidence.

Output terminology is restricted to:

```text
Provisional passing rate
First observed failing rate
Likely capacity range
Observed bottleneck
```

It must not print `maximum`, `supported ceiling`, or `certified` for scan data.

### `certify`

`certify` establishes the highest repeatable tested Home-open rate under the
existing gates and records the remaining observed or unobserved failure bound.
It performs the same preflight and smoke, then:

1. runs the adaptive ladder;
2. brackets the highest pass and lowest failure;
3. selects the highest candidate within the existing gap rule;
4. restores clean state and runs that rate three times using the existing
   120-second warm-up, 600-second measurement, and drain behavior;
5. if any repeat fails, moves to the next lower proven passing integer rate and
   begins a new set of three repeats—failed and successful repeats are never
   mixed;
6. invokes the existing aggregation logic for the three matching immutable
   boundary reports;
7. prints the highest certified tested rate and 70% operating ceiling when a
   failure bound was observed, or `at least <max-rate>/sec` with no ceiling when
   no failure was observed.

The discovery ladder may use the scan-length timing to locate the boundary
quickly, but a rate is not certified until three full-length boundary repeats
pass. Short discovery passes may select candidates; they are not themselves
supporting certification evidence.

`--from-scan <workflow-result.json>` may skip discovery only when the scan completed
successfully and its commit, executed source hash, profile/report versions,
snapshot and scrub-attestation hashes, parity overlay, approved/live resource
manifest, process/pool topology, timing policy, and rate bounds exactly match
the certification preflight. The certification workflow records and hashes the
source scan but uses fresh child run IDs and clean state for all boundary
repeats. Any mismatch fails before confirmation and instructs the operator to
run certification discovery normally.

### `level`

`level --rate <positive integer>` runs one isolated diagnostic level after
preflight and smoke. Its default timing is the scan timing. Supplying
`--certification-length` uses the certification warm-up and measurement but
still produces a single-level diagnostic report, not a certified maximum.

## Environment lifecycle and reset contract

The main time reduction comes from separating **environment preparation** from
**level reset**.

### Prepare once per workflow

Preparation:

- verifies and, if needed, resizes the Lima VM;
- acquires an exclusive OS/provider-instance lock before inspecting or mutating
  the shared Lima instance; a second workflow fails before confirmation;
- validates the instance, config path, and every generated Docker name against
  fixed capacity-only prefixes and length/character bounds;
- creates a dependency image/cache from the immutable bundle, bound to its hash,
  lockfile hash, Node image, and Prisma schema/generator inputs;
- performs `npm ci --ignore-scripts`, `prisma generate`, and migration
  compatibility validation once for that preparation binding;
- verifies the approved hardware/resource manifest;
- verifies the snapshot hash and scrub attestation;
- never reuses a dependency binding after any bound input changes.

Preparation is outside measured windows. Cache reuse is an operator speedup,
not part of the capacity result. The report records whether the binding was a
cache hit and records its content hashes.

### Reset before every level

Every smoke, ladder, bracket, and boundary level receives a unique run ID and:

1. stops the prior backend container;
2. verifies Docker labels bind every prior container/volume to this confirmed
   workflow/child before deleting it; deletion errors are fatal;
3. proves the prior Postgres volume no longer exists, then creates a uniquely
   child-bound labeled volume and Postgres container with approved limits;
4. restores and verifies the approved scrubbed snapshot;
5. runs `prisma migrate deploy` against that newly restored disposable database
   outside measurement and records the applied migration set and schema hash;
6. creates a unique child-bound labeled Redis container every time, proves its
   key census is exactly zero before backend startup, and never uses flush as a
   substitute for freshness;
7. starts a fresh, uniquely labeled backend container from the immutable source
   bundle and allowlisted environment with the new run ID, exact two-HTTP plus
   resolution plus cron census, cached dependency binding, and safe capacity
   environment;
8. waits for resolution startup readiness and restored queue quiescence;
9. creates fresh fixtures and starts a fresh pool-measurement epoch;
10. runs the level and retains the existing queue-drain and cleanup validation.

Each child report stamps the Postgres container/volume identity and labels,
restore hash, scrub verification, migration set/schema identity, Redis
container identity and zero-key census, backend identities, immutable source
bundle hash, and effective non-secret environment hash.

The VM may remain running across levels because its cgroup/resource manifest is
re-read and stamped for every level. Application, database, cache, fixture,
queue, metric, and run-bound state may not cross levels.

The lifecycle state model gains a workflow parent record and per-level child
records. Existing standalone `capacity start/status/stop/destroy` behavior
remains backward-compatible. Workflow cleanup may act only on children listed
in the confirmed parent record. A child may transition once through
prepared/restored/started/stopped/destroyed or failed/interrupted terminal
states; invalid or repeated destructive transitions fail closed.

The confirmed manifest is written once with exclusive-create semantics and is
never amended. Planned/started/completed/failed/cleanup transitions are
sequenced, hash-linked immutable event files. One immutable terminal report is
derived from that journal. Recovery rejects a missing sequence, duplicate
sequence, broken prior-event hash, altered event, or child outside the confirmed
policy. The mutable `latest.json` pointer is never part of this journal.

The provider lock records owner PID, process start identity, workflow ID, and
instance. A lock is stale only after positive proof that the owning process no
longer exists with that start identity and no labeled workflow resources are
running. Stale-lock recovery is journaled and still performs all ownership
checks; age alone never breaks a lock.

If reset or cleanup cannot prove isolation, that level fails closed and the
workflow stops. The orchestrator must not silently retry a failed measured
level under the same run ID.

## Adaptive ladder rules

The exact discovery algorithm is:

```text
require 2 <= startRate <= maxRate <= 500; defaults are 2 and 500
run smoke at 1/sec; any smoke failure aborts without a capacity range
initial = sorted unique [startRate,
  every value in (2,5,10,20,30,40,60,80,100,150,225,340,500)
    strictly above startRate and at or below maxRate,
  maxRate]
low = 1                 # smoke-proven only
high = unknown
for rate in initial:
  run discovery(rate)
  if pass: low = rate
  else: high = rate; break
if high is known:
  while high - low > max(2, ceil(low * 0.10)):
    rate = floor((low + high) / 2)
    if rate <= low: break
    run discovery(rate)
    if pass: low = rate
    else: high = rate
else:
  result = "at least maxRate/sec provisionally observed"
result bracket = high known ? [low, high] : [low, unknown]
```

Thus a first discovery failure searches downward by the same deterministic
midpoint rule between the passing smoke rate and that failure; there is no
separate ad hoc lower-rate sequence. Rates outside the confirmed bounds are
impossible. Midpoints always round down.

For certification, candidate rates are all discovery passes including 1,
sorted descending. Run repeats 1, 2, and 3 at the first candidate. Abort that
candidate immediately on its first failed repeat and move to the next lower
candidate; never reuse a prior repeat or mix candidates. The first candidate
with three passes is the highest certified tested rate. If no candidate passes
three times, certification fails without a ceiling. When `--from-scan` is used,
its exactly compatible passing candidates supply this ordered list, but the
certification workflow still runs its own smoke and fresh boundary children.

Let `I` be the count of the fully constructed initial list and
`B = ceil(log2(maxRate - 1))`. Discovery has a conservative bound
`D = I + B`. A normal scan confirms at most `1 + D` children. A certification
with discovery confirms at most `1 + D + 3 * (1 + D)` children; certification
from a scan confirms at most `1 + 3 * P`, where `P` is that validated scan's
passing-candidate count. These are deliberately conservative even though a
failed certification candidate aborts before all three possible repeats.

The full adaptive rate sequence need not be known before confirmation, but its
algorithm, start/max bounds, timing, and derived maximum child count are bound.
Each selected rate and its selecting evidence are written as the next immutable
journal event before that child starts.

- A pass/fail decision comes only from the existing verified per-level report,
  not the child process exit code alone.
- Infrastructure/setup failures are classified separately from measured
  capacity failures. They stop the workflow and do not become a lower capacity
  bound.
- `--max-rate` stops exploration and produces `at least N/sec` without a safe
  ceiling when all attempted rates and three certification repeats at N pass;
  it never synthesizes a failure.
- Every certification fallback candidate is lower than the failed candidate
  and backed by a passing compatible discovery level (or the workflow smoke
  for candidate 1).
- No rate is automatically retried merely to turn a failure into a pass.

## Reporting contract

Each workflow writes under:

```text
results/capacity/home-open/workflows/<workflow-id>/
```

It contains:

- `confirmed-manifest.json`: immutable confirmed inputs and policy;
- `events/<sequence>-<event>.json`: hash-linked immutable transition journal;
- `workflow-result.json`: one immutable terminal result derived from the
  confirmed manifest and complete journal, including child artifact paths and
  hashes, cleanup disposition, interruption state, and final classification;
- `summary.txt`: concise human-readable report;
- the existing per-level artifact directories, referenced rather than copied;
- `latest.json` at the workflows directory as an atomic replaceable pointer to
  the most recently completed workflow; this pointer is convenience metadata,
  not capacity evidence.

Terminal progress shows the current phase, rate, elapsed/remaining time,
offered/completed/failed sessions, current p95, HTTP error evidence, backend and
database CPU, pool pressure, resolution queue evidence, and the next planned
action. Unknown evidence remains `unknown`, never zero.

The final scan report includes:

- commit/source/snapshot/resource identity;
- highest provisional pass and first observed failure;
- likely range or measured lower bound;
- p50/p95/p99 Home completion and endpoint breakdown at the boundary;
- HTTP failures, dropped arrivals, generator saturation;
- backend, database, Redis, pool, and resolution queue peaks;
- the exact failed gates and correlated resource/queue pressure, followed by a
  `likely constraint` only when a documented deterministic rule supports it;
  otherwise `inconclusive`;
- elapsed wall time and per-phase timing;
- exact command to run certification from the discovered range.

The final certification report additionally includes:

- three supporting run IDs and artifact hashes;
- highest certified tested rate and, only with an observed failure bound, its
  70% operating ceiling;
- opens/minute and measured average/peak concurrent Home sessions;
- failure boundary when observed;
- no DAU or distinct-user estimate unless a separately versioned production
  traffic conversion artifact is explicitly supplied and disclosed.

Certification aggregation extends the existing
`aggregateHomeOpenLadder` contract instead of defining parallel pass logic. It
requires certification-only provenance, exact 120-second warm-up and
600-second measurement, repeats exactly 1/2/3, one rate, and identical
commit/source-bundle, profile/report, snapshot/scrub, parity, resource,
topology, effective-environment, and migration bindings. With no measured
failure at the confirmed max rate, it reports only `at least N/sec` and no 70%
ceiling. With a failure bracket, it reports the `highest certified tested
rate`, a 70% operating ceiling for that tested rate, and the unresolved
  `[pass, fail]` bracket. Even adjacent rates are labeled measured support and
  failure bounds rather than an eternal or universally exact hardware maximum.

Likely-constraint rules are deliberately conservative and versioned with the
report schema. Examples include generator saturation only when generator CPU,
dropped iterations, or observer overhead fail their existing gates; database
pool pressure only when checkout wait/waiters fail while database evidence is
complete; resolution throughput only when resolution queue lag/backlog fails
and claim/terminal evidence reconciles; and HTTP/backend saturation only when
backend CPU or event-loop evidence fails without an upstream generator failure.
Multiple matching rules produce `multiple correlated constraints`. A slow SQL
statement, high CPU value, or queue delay by itself is diagnostic evidence, not
proof of causality.

## Failure, interruption, and cleanup behavior

- Ctrl-C once stops the active k6 child, captures available backend/queue/
  infrastructure evidence, performs fixture cleanup, stops backend/database/
  Redis, deletes disposable data, writes an interrupted workflow report, and
  stops the retained empty VM.
- A second Ctrl-C may force process termination, but the next invocation must
  detect and offer the exact stale disposable workflow for cleanup before doing
  anything else. It may not delete unrelated Lima instances or result files.
- Automatic resume is out of scope. A stopped/interrupted workflow is immutable
  and cannot contribute to a later certification; after exact stale-resource
  cleanup, the operator starts a new workflow.
- Setup failures, measured capacity failures, generator failures, evidence
  failures, cleanup drift, and operator interruption have distinct result
  classifications.
- Detailed child artifacts remain immutable even when the workflow fails.
- Normal cleanup prints whether `reset-data`, `stop`, and safe cache retention
  succeeded. It never leaves services accepting traffic.

## Runtime model and simplification evidence

The old manual Home discovery schedules 120 seconds of warm-up plus 600 seconds
of measurement per rate, in addition to its drain/reset/readiness overhead, and
repeats dependency installation during guarded starts. The new discovery
schedules 30 plus 120 seconds per rate: 150 instead of 720 seconds, a 79.2%
reduction in scheduled load time per discovery rate. Smoke falls from 120 to 60
seconds. Certification boundary repeats remain exactly 120 plus 600 seconds.

The pre-confirmation duration model is:

```text
prepareUpperBound
+ childCount * resetAndReadinessUpperBound
+ smokeSeconds
+ discoveryChildBound * (30 + 120 + drainUpperBound)
+ certificationChildBound * (120 + 600 + drainUpperBound)
+ terminalCleanupUpperBound
```

Every named upper bound is a finite versioned harness constant displayed in
the manifest and is not operator-overridable; an unbounded wait is prohibited.
The terminal report records
observed prepare, restore/migrate, readiness, load, drain, cleanup, and total
wall time independently. An authorized bounded rehearsal must compare this
model with the current manual workflow, demonstrate dependency preparation
once, confirm the 79.2% discovery scheduled-time reduction, and disclose the
observed reset/readiness/drain overhead. No speed target may weaken a capacity
gate or shorten certification repeats.

## Safety and compatibility

- `target` remains `capacity-vm`, database remains
  `steps_tracker_capacity`, and all bound hosts remain loopback/private.
- Production and staging database URLs and outbound provider credentials remain
  categorically rejected/cleared.
- The capacity parity overlay remains allowlisted and fully injected into the
  backend container. Production configuration is imitated; the production
  `.env` file is never copied or sourced.
- The report identifies snapshot creation time, data age at workflow start, row
  topology, and scrub attestation. It says `production-shaped snapshot`, never
  `exact production database`; scrubbed values, elapsed data age, managed-cloud
  behavior, and running Postgres locally are disclosed limitations.
- Exact process topology remains two HTTP workers, one resolution worker, and
  one cron worker with the approved 10/10/8/4 pool budget.
- Existing app versions see no change because no public route, payload, data,
  or deployed runtime behavior changes.
- No deployment is part of this workflow. The tooling runs only from the local
  backend checkout against the disposable capacity target.

## API contract

There is no HTTP API change. The only new public contract is the local CLI:

```text
npm run capacity:home -- <scan|certify|level> [options]
```

Invalid modes/options, dirty source, unsafe targets, missing prerequisites, or
incompatible artifacts exit nonzero with one actionable error. Measured
capacity failure also exits nonzero after writing the complete workflow report;
a successful scan with a discovered failure exits zero because finding the
range is the expected scan outcome. Certification exits zero only when it
produces a valid certification or a valid `at least <max-rate>/sec` lower bound.

## Data model and migrations

No application database model or migration changes. Workflow state is local
JSON under the gitignored results directory. Snapshot restores and synthetic
fixture writes remain confined to the disposable capacity database.

## Frontend plan

None. There is no Flutter, iOS, Android, screen, widget, or mobile configuration
change. No UI-placement test plan is required.

## Implementation plan

1. Add tests first for CLI parsing, source/config preflight, deterministic
   rate selection, classifications, interruption, cleanup, and reporting.
2. Extract the reusable single-level Home execution from
   `scripts/k6-home-open.js` without changing its verification or artifact
   contract.
3. Extend the provider lifecycle in `scripts/lima-capacity.js` with explicit
   prepare/reset operations. Keep destructive targets derived from validated,
   run-bound safe names only.
4. Add `scripts/home-capacity-workflow.js` as the orchestrator and export its
   pure planning/reporting functions for structural unit coverage.
5. Add `capacity:home` to `package.json`.
6. Reuse `aggregateHomeOpenLadder` for certification rather than implementing
   a second definition of a passing maximum.
7. Update `docs/capacity-load-runbook.md` so the three one-command modes are the
   primary Home workflow and the low-level commands are a troubleshooting
   appendix.
8. Update the capacity execution provenance bundle to include the orchestrator,
   lifecycle changes, tests/contract version, and this requirements document.
9. Run syntax checks and unit tests. Run integration tests only after confirming
   `DATABASE_URL` names a dedicated `*_test` database.
10. With explicit authorization for a capacity run, execute local preflight,
    smoke, a bounded scan, interruption recovery, and one certification-path
    rehearsal against the disposable environment. Do not start staging or
    contact production.

## Tests-first plan

### Unit/structural tests

- CLI accepts only `scan`, `certify`, and `level`; validates rates and supported
  options; rejects target/database/safety overrides.
- Run IDs are safe, unique, length-bounded, and stable in workflow references.
- Ladder progression, failure stopping, integer bracketing, max-rate lower
  bounds, certification fallback, and three-repeat selection are deterministic.
- Setup/evidence/cleanup/interruption failures cannot be misclassified as
  measured capacity failures.
- Scan artifacts cannot be aggregated as certification evidence.
- Certification requires three full-length passing repeats at the same rate
  and binding.
- Workflow report writes are crash-safe; immutable evidence cannot be
  overwritten; the mutable `latest.json` pointer cannot become evidence.
- One workflow confirmation cannot start an unbound mode, timing policy,
  source/snapshot/resource binding, rate outside its bounds, or more than its
  confirmed maximum child count.
- Environment preparation cache invalidates for source, lockfile, Node image,
  Prisma, migration, parity overlay, or resource-manifest changes.
- Immutable source bundle rejects escaping symlinks, changes after confirmation,
  missing allowlisted inputs, and any child attempt to mount the live checkout.
- Effective child environments contain only allowlisted names; secret changes
  alter fingerprints without storing their values.
- Level reset refuses foreign Redis namespaces, unsafe container/volume names,
  incomplete snapshot restore, scrub mismatch, process drift, and run-ID drift.
- Exclusive provider locking covers concurrent workflows, foreign labeled and
  unlabeled resources, live owners, provably stale owners, and the crash windows
  before/after container or volume creation. Failed deletion cannot be followed
  by reuse as freshness proof.
- Journal verification rejects gaps, duplicate sequences, broken hashes,
  altered events, and unconfirmed children.
- Ctrl-C cleanup targets only the exact validated workflow resources and leaves
  a recoverable partial report.
- Text reports use provisional/certified terminology correctly and never infer
  DAU without a separate conversion artifact.

### Integration tests

- Against a dedicated local `*_test` Postgres and disposable Redis, run the
  public orchestration path with stubbed short timing and prove two levels see
  identical restored baseline state and distinct run IDs/namespaces.
- Prove fixture writes, queue rows, Redis keys, and pool epochs from level one
  are absent before level two begins.
- Prove each restored database receives `prisma migrate deploy`, then stamps the
  expected migration/schema identity; prove each Redis child starts with zero
  keys and a distinct labeled container identity.
- Prove a child capacity failure yields a successful scan range but a failed
  certification candidate triggers lower-candidate selection.
- Prove setup/evidence failure stops escalation and writes partial evidence.
- Prove interruption stops the active load, cleans fixtures, and produces the
  exact stale-resource cleanup instruction.
- Provider-level disposable smoke proves dependency preparation happens once
  while Postgres, Redis namespace/process, backend processes, and run binding
  are fresh per level.

Existing assertions may not be weakened, skipped, or deleted.

## Acceptance criteria and definition of done

- A normal scan, certification, or single-level diagnostic begins with one
  command and requires at most the existing one safety confirmation.
- Preflight shows a bounded duration estimate before that confirmation.
- Operators never manually create run IDs, carry forward rates, choose bracket
  points, execute boundary repeats, or aggregate reports.
- Scan discovery reduces scheduled per-rate load time from 720 to 150 seconds
  (79.2%), prepares dependencies once, and reports all remaining overhead while
  clearly labeling results provisional.
- Certification retains every current per-level pass/fail gate and requires
  three fresh-state, full-length repeats.
- Dependency installation/generation is performed once per valid preparation
  binding, not once per level.
- Every level proves fresh database, Redis, fixtures, queue, metric epoch,
  process census, and run identity.
- A failure or interruption produces a useful report and deterministic cleanup.
- The final terminal output answers capacity, latency, error, resource, and
  bottleneck questions without requiring the operator to open raw JSON.
- `npm run test:unit` passes.
- Relevant integration tests pass only against a confirmed `*_test` database.
- The code reviewer reports no unresolved correctness or safety issues.
- No frontend builds are required because no frontend code or shared contract
  changes.

## Open product decisions

Resolved:

1. `certify` may accept a prior scan only under exact binding compatibility.
2. Normal cleanup retains a stopped, empty VM and safe content-addressed
   dependency cache, while deleting all database/Redis/run data and credentials.
3. Scan defaults are a 60-second smoke, 30-second warm-up, and 120-second
   measurement, and results remain explicitly provisional.

## Revision log

- **Initial draft:** Split the operator experience into scan, certify, and
  level modes; preserved all existing safety/evidence gates; separated
  prepare-once work from fresh per-level state; prohibited scan results from
  being reported as a certified ceiling.
- **Gap pass 1:** Replaced the underspecified one-confirmation proposal with an
  immutable, hash-bound workflow authorization and bounded deterministic child
  runs; added parent/child lifecycle states and snapshot-fidelity disclosures.
- **Gap pass 2:** Made source selection validation-only, added pre-confirmation
  duration estimates and explicit no-resume semantics, and constrained
  bottleneck language to versioned evidence rules so correlation is not
  reported as proven causality.
- **User interview:** Accepted the recommended compatible-scan reuse, safe
  stopped-VM/cache retention, and 60s/30s/120s scan timing defaults; specified
  exact reuse bindings and credential/data deletion requirements.
- **Architect review:** Required an immutable executed-source bundle and
  allowlisted child environment; exclusive provider locking plus labeled unique
  resources and deletion proof; immutable lifecycle journaling; per-restore
  migrations and fresh Redis; exact adaptive-search/child-bound rules; corrected
  certification/lower-bound aggregation; and measurable runtime acceptance.
  Also adopted clearer `--expect-commit`, `reset-data`/`stop`/`delete-vm`
  terminology and removed the redundant keep-environment option.
- **Post-architect gap pass 1:** Removed remaining claims of an exact/repeatable
  hardware maximum, generalized no-failure lower-bound language to the
  confirmed max rate, and reconciled interruption cleanup with stopped empty-VM
  retention.
- **Post-architect gap pass 2:** Restricted immutable executed source to tracked
  `HEAD` while validating ignored run inputs separately, and made duration
  upper bounds fixed versioned harness constants rather than mutable operator
  configuration.
