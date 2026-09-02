# Local capacity-load runbook

This is the disposable, local workflow for requests such as:

> Simulate 5,000 DAU at 3 RPS.

It never uses production credentials or sends production traffic. It restores a
scrubbed production database dump into a local Postgres container, runs the
selected backend commit from the local checkout, generates synthetic users and
tokens, runs the full-app endpoint mix, records infrastructure metrics, and
destroys the environment.

## What is already implemented

- Lima VM target matching the approved VPS shape: Basic, 4 vCPUs, 8 GB RAM,
  160 GB disk.
- Postgres target matching the approved database shape: Basic, 1 vCPU, 2 GB
  RAM, 30 GiB disk, 47 max connections, 10 GiB autoscale at 80%.
- Disposable Postgres 18 container inside Lima.
- Production dump restore plus scrub attestation. Device tokens are deleted
  and sensitive string columns are replaced with synthetic values.
- Run-bound local secrets, database marker, private-host/database checks,
  outbound push/cloud credentials disabled, and production database targets
  categorically rejected.
- Exact start confirmation bound to both the run id and snapshot SHA-256.
- Two Node HTTP workers sharing port 3000, plus dedicated resolution and cron
  processes on loopback ports 3010 and 3011. The required `role-budget`
  profile is exact: HTTP 10 + HTTP 10 + resolution 8 + cron 4 = 32 total.
- Redis 7.0.15 inside Lima, bound to loopback with password authentication,
  100 MB max memory, `allkeys-lru`, and persistence disabled.
- Synthetic fixture creation, signed run-only auth tokens, disposable writes,
  deterministic idempotency keys, and cleanup verification.
- `full-app` endpoint profile covering Home, Races, Race Details, step sync,
  current/legacy variants, and race-resolution polling.
- Open-loop request scheduling: offered RPS is launched against wall-clock
  intervals with concurrent requests allowed up to the configured limit.
- Per-endpoint request counts, errors, p50/p95/p99 latency, backend CPU/memory,
  Postgres CPU/memory, application-pool utilization, pool waiters, and pool wait
  times.
- Reports saved under `results/<run-id>.{txt,json,metrics.json}`.
- Explicit destroy operation that removes the Lima VM and its database.

## One run

1. Copy `docs/capacity-load.config.example.json` to a local config file.
2. Set only the run-specific values:

   - `run_id`: unique lowercase id, for example `load-20260821j`
   - `users`: requested DAU/fixture-user count
   - `arrival_rate`: offered requests per second
   - `duration`: usually `5m`
   - `concurrency`: normally equal to `users`, bounded by the load contract

3. Load the local, uncommitted secrets:

   ```sh
   set -a
   source .env.capacity.local
   set +a
   ```

4. Start the capacity environment:

   ```sh
   npm run capacity -- start --config docs/capacity-load.config.json
   ```

   The command restores/scrubs when needed, prints the VPS and Postgres
   manifest, and waits for the exact confirmation. Confirm the run id and the
   snapshot hash shown by the command. Do not use a bypass flag.

5. Run the load:

   ```sh
   npm run load-test -- run --config docs/capacity-load.config.json
   ```

6. Read the three files under `results/` for the run id.

7. Destroy immediately after collecting results:

   ```sh
   npm run capacity -- destroy --config docs/capacity-load.config.json
   ```

## Interpretation rules

- `arrival_rate` is the sustained open-loop offer. It is not the same as the
  report's current aggregate `achieved` value: that value currently includes
  coverage traffic and post-run race-resolution polling. Use the sustained
  request count separately when comparing capacity runs.
- Health sampling rotates fresh connections across the two HTTP workers and
  also samples the resolution and cron roles, preserving the exact 10/10/8/4
  process census in the metrics artifact.
- The local target uses the same Redis and dedicated resolution/cron process
  topology as production. The queue remains database-backed, and all local
  containers are destroyed after the run.
- A cleanup warning such as `baseline integrity changed during synthetic
  cleanup` means background cron/resolution work changed baseline rows during
  the run. The cleanup artifact identifies every changed integrity table with
  its before/after count and checksum. It is not a request error, but it fails a
  `home-open` candidate and blocks escalation; destroy the disposable run after
  retaining the evidence.
- Do not increase the application pool solely because it waits. Check Postgres
  CPU, slow queries, lock/wait data, and query plans first.

## Home-open capacity ladder

`home-open` measures complete authenticated Home opens per second. It is not
the older request-weighted `home` profile. Each session persists steps first,
then reproduces the shipped Home dependency graph and parallelism, including
response-dependent presentation and friends fallbacks, Me-triggered and
presentation-triggered asset manifests, and bounded resolution polling.

The containing Lima VM is 7 vCPU/12 GiB. Inside it, cgroups retain the measured
production-shaped allocations: backend 4 vCPU/8 GiB, Postgres 1 vCPU/2 GiB,
Redis 1 vCPU/256 MiB, and 1 vCPU/~1.75 GiB reserved for the guest, container
runtime, and one-second monitoring. k6 runs on the host outside that envelope.
The restore hook does not trust an existing Lima instance: it stops and edits
any resource drift, starts it, then re-reads and stamps the actual 7-vCPU,
12-GiB, configured-disk census into the run provenance.

Every smoke, candidate, and boundary repeat requires a unique run id and a
newly restored/scrubbed disposable state. Never overwrite a prior artifact.
Load `.env.capacity.local`, then run the smoke:

```sh
npm run capacity -- start --config docs/capacity-load.config.json \
  --profile home-open --run-id <smoke-run-id>
CAPACITY_MODE=true CAPACITY_OUTBOUND_DISABLED=true \
  npm run load-test:k6:home-open -- --config docs/capacity-load.config.json \
  --run-id <smoke-run-id> --mode smoke
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile home-open --run-id <smoke-run-id>
```

Smoke is fixed at 1 Home open/second for 120 seconds. Do not start the ladder
unless its fixture topology, exact process census, session accounting,
telemetry, queue drain, cleanup, and every gate pass.

k6 can invoke a constant-arrival-rate iteration on the exact duration boundary.
The script applies an exact per-scenario quota using k6's cross-VU-unique local
scenario iteration index before observer or backend work. Such executor-only
iterations are reported as `quotaRejected`; raw executor iterations minus that
counter must equal the exact configured arrivals. They never count as offered
Home opens and do not weaken the zero dropped-iteration gate.

Before fixture baseline capture or any smoke, warm-up, or measured session is
offered, the harness polls the dedicated resolution process until the actual
worker reports both its intentional 60-second startup quiet period and old-queue
handoff check complete. It then requires two consecutive observations in which
every restored V2 resolution job is succeeded at its latest generation. This
keeps restored-snapshot work outside both the cleanup baseline and load window.
The boot/drain wait stays outside metrics; the measured queue gate remains
unchanged at p95 at most 30 seconds, including for smoke.

After resolution readiness, restored-queue quiescence, and fixture creation, the harness starts an idempotent,
run-bound DB-pool measurement epoch on both HTTP workers, the resolution
process, and the cron process. Metrics and k6 start only after the exact
four-process reset census succeeds. Every health sample must retain the same
process PID, measurement id, generation, and start timestamp; a missing,
restarted, or re-reset process fails closed. This excludes startup checkout
samples without changing the measured p99 checkout-wait gate of 50 ms.

For each initial rate `2 5 10 20 30 40 60 80 100`, use the previous passing
rate as `<lower-rate>`, choose a fresh run id, and run:

```sh
npm run capacity -- start --config docs/capacity-load.config.json \
  --profile home-open --run-id <candidate-run-id>
CAPACITY_MODE=true CAPACITY_OUTBOUND_DISABLED=true \
  npm run load-test:k6:home-open -- --config docs/capacity-load.config.json \
  --run-id <candidate-run-id> --mode level --rate <candidate-rate> \
  --warmup-rate <lower-rate>
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile home-open --run-id <candidate-run-id>
```

Each candidate has a separately tagged 120-second warm-up and 600-second
measurement. After warm-up arrivals stop, the runner leaves a 16-second drain
gap (the 15-second session deadline plus one launch bucket) before measurement,
so warm-up tails cannot overlap or improve/degrade measured evidence. Stop at
the first failure. If 100 passes, continue with 150, 225,
340, and 500 until failure. If 500 passes, report only “at least 500 Home
opens/second”; there is no extrapolated maximum or 70% ceiling.

Bracket between the highest pass and lowest failure until the gap is within
10% or 2 Home opens/second, whichever is larger. Then run the chosen boundary
three times with `--mode boundary --repeat <1|2|3>`, a unique run id, and clean
fixture state each time. The repeatable supported maximum is the highest rate
for which all three pass; its safe operating ceiling is 70%.

Artifacts are grouped by run under
`results/capacity/home-open/<run-id>/<run-id>.home-open.<mode>.<rate>` and include k6 summary, one-second
infrastructure metrics, generator metrics, identifier-free topology, JSON
verification, and text summary. The orchestrator prints a progress record once
per minute with completed/failed sessions, current critical latency and HTTP
error evidence, generator use, and live infrastructure health. Progress reads
k6's live REST `sample` values from the current warmup or measurement submetric;
unavailable counts, rates, or percentiles remain `null` rather than being
reported as zero. The JSON report
also contains every endpoint's status/timeout counts and p50/p95/p99, every
measurement-second's offered/started/dropped/completed/failed accounting, and
average/peak in-flight sessions. Missing or non-finite evidence fails closed.
A host-loopback observer records every measured session start and completion to
calculate true time-weighted average and peak in-flight sessions; the report
stamps its overhead of two synchronous loopback requests per Home open. These
requests are tagged as generator telemetry and excluded from SUT HTTP rates.
Critical and all-settled clocks begin at the open-loop scheduled launch instant,
before the synchronous observer start call, so scheduler and observer delay are
included exactly once in session latency and in the bounded deadline.
A nonzero k6 exit, cleanup drift, process restart/extra identity, incomplete
recovery window, or nonzero exit after artifacts are written means that level
failed and escalation must stop.

A restored production snapshot may contain a currently active global event.
Home fixture setup first samples its aggregate topology, then removes the
complete global-event derived domain from the guarded disposable capacity
database before recording the cleanup baseline. For `home-open` only, the
capacity cron process also omits global-event creation, boundary,
entitlement-reconciliation, and summary ticks so those rows cannot reappear
during a level. The identifier-free topology artifact records the snapshot,
removed, and verified-zero isolation census. Production and staging are never
changed by this isolation.
After synthetic cleanup, the harness performs a second read-only census and
stamps it into both JSON and text reports. Any global-event row (including a
future scheduled row), any active event, any summary-work row, or
missing/non-finite census evidence fails the level; this catches cron or
external contamination that reappears after fixture setup.

To interrupt, press Ctrl-C once, retain every artifact already emitted, then
destroy the exact run immediately:

```sh
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile home-open --run-id <interrupted-run-id>
```

Do not reuse an interrupted or failed run id. This workflow never contacts
production or staging, never creates a production snapshot, and never changes
public API behavior.

After all three immutable boundary repeats pass, build the final ladder report
without starting a VM. Every input must have a unique run id and identical
backend commit, profile version, scrub attestation, source-tree, snapshot,
approved-manifest, and resource provenance:

```sh
npm run load-test:k6:home-open -- --mode aggregate \
  --reports results/capacity/home-open/<run-1>/<repeat-1>.json,results/capacity/home-open/<run-2>/<repeat-2>.json,results/capacity/home-open/<run-3>/<repeat-3>.json \
  --output results/capacity/home-open/home-open-capacity-final.json
```

The final artifact reports the repeatable maximum, 70% safe ceiling (or only
the proved `at least 500/s` lower bound), opens/minute, in-flight sessions,
latency and endpoint/infrastructure bottlenecks, and conversion limitations.

## Global-event deployment gate

The global-event reliability release uses three isolated profiles, not
`full-app`. Each profile must start a newly restored/scrubbed environment with
its own run id, then complete repeats 1, 2, and 3 against that same started
environment. Command-line `--profile` and `--run-id` values are authoritative:
the start path passes both into every Lima process, health telemetry proves the
running profile, and the load path refuses a profile that differs from the
started capacity state.

For each profile below, replace `<run-id>` with a unique lowercase safe id:

```sh
npm run capacity -- start --config docs/capacity-load.config.json \
  --profile <profile> --run-id <run-id>

for repeat in 1 2 3; do
  npm run load-test -- run --config docs/capacity-load.config.json \
    --profile <profile> --run-id <run-id> --repeat "$repeat"
done

npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile <profile> --run-id <run-id>
```

Run that sequence for:

1. `event_provisioning_10000`
2. `event_boundary_10000`
3. `event_provider_outage_10000`

Do not reuse a running environment across profiles. Retain, for every run id,
all `repeat-{1,2,3}.{json,txt,metrics.json}` files, all three
`event-repeat-{1,2,3}.json` files, and `event-aggregate.json`. Deployment is
blocked unless every individual repeat and each aggregate gate passes. A
missing percentile, missing eligible schedule/alert/outbox, eligible
cancellation, incomplete target/provider census, failed one-second background
bucket, process/profile mismatch, or missing infrastructure sample fails
closed.

Artifacts are immutable. If any repeat fails after producing an artifact, do
not delete or overwrite it and do not rerun under the same run id. Destroy the
environment, choose a new run id, and repeat all three repetitions for that
profile. Every metrics/evidence file is stamped with run id, profile, and
repeat; aggregation rejects mixed provenance.

Creating the source production snapshot is a production operation and requires
fresh authorization. The dump is restored only into the disposable private
capacity database, scrubbed before the backend starts, never used as a test
target directly, and removed with the capacity environment after evidence is
retained.

## Event-start surge deployment gate

Use the `event-open-surge` profile with `database_pool_profile` fixed to
`role-budget`. It creates 10,000 synthetic East Coast users, three active
races, the real entitlement/domain-event/schedule boundary, deterministic
provider delivery, and a complete app-open session graph. One offered session
performs auth, token registration, activation analytics, exactly one observed
step-upload path in the 18/18/64 legacy-samples/current mix, and all Home,
discovery, race-list, Inbox, progress, and bootstrap reads. Offered and
completed sessions are recorded separately; a dropped session fails the run.

Run each scenario from a newly restored/scrubbed environment and a unique run
id. Never reuse or overwrite an artifact:

```sh
# Sustained: 100 complete sessions/s for five minutes.
npm run capacity -- start --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <sustained-run-id>
npm run load-test -- run --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <sustained-run-id> \
  --users 10000 --arrival-rate 100 --duration 5m --concurrency 1000
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <sustained-run-id>

# Shock: 200 complete sessions/s for one minute.
npm run capacity -- start --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <shock-run-id>
npm run load-test -- run --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <shock-run-id> \
  --users 10000 --arrival-rate 200 --duration 1m --concurrency 1000
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <shock-run-id>
```

The deployment gate uses genuine k6 constant-arrival-rate traffic. The
orchestrator creates the real 10,000-user entitlement fixture in the already
started disposable environment, waits for the boundary, runs the complete app
session graph, injects the selected fault 30 seconds into the wave, writes an
immutable `.fault.json`, and cleans up only its synthetic manifest. It refuses
anything except `CAPACITY_MODE=true`, outbound-disabled
`steps_tracker_capacity`, profile `event-open-surge`, and the `role-budget`
10/10/8/4 pool profile.

Run every command below from the same run-bound shell used to start that
disposable environment. It must still contain `CAPACITY_DB_PASSWORD`, the
started run's random `CAPACITY_DB_MARKER`, `CAPACITY_AUTH_SECRET`, and the
snapshot/scrub secrets; the orchestrator fails closed before loading the
database client if any run-bound guard is absent or mismatched.

```sh
npm run capacity -- start --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <headroom-run-id>
CAPACITY_MODE=true CAPACITY_OUTBOUND_DISABLED=true \
  npm run load-test:k6:event-open -- --config docs/capacity-load.config.json \
  --run-id <headroom-run-id> --scenario headroom --fault baseline
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <headroom-run-id>

npm run capacity -- start --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <redis-run-id>
CAPACITY_MODE=true CAPACITY_OUTBOUND_DISABLED=true \
  npm run load-test:k6:event-open -- --config docs/capacity-load.config.json \
  --run-id <redis-run-id> --scenario sustained --fault redis-outage \
  --headroom-evidence results/<headroom-run-id>.headroom.verification.json
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <redis-run-id>

npm run capacity -- start --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <restart-run-id>
CAPACITY_MODE=true CAPACITY_OUTBOUND_DISABLED=true \
  npm run load-test:k6:event-open -- --config docs/capacity-load.config.json \
  --run-id <restart-run-id> --scenario sustained --fault worker-restart \
  --headroom-evidence results/<headroom-run-id>.headroom.verification.json
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <restart-run-id>

npm run capacity -- start --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <shock-run-id>
CAPACITY_MODE=true CAPACITY_OUTBOUND_DISABLED=true \
  npm run load-test:k6:event-open -- --config docs/capacity-load.config.json \
  --run-id <shock-run-id> --scenario shock --fault baseline \
  --headroom-evidence results/<headroom-run-id>.headroom.verification.json
npm run capacity -- destroy --config docs/capacity-load.config.json \
  --profile event-open-surge --run-id <shock-run-id>
```

The headroom scenario is 140 complete sessions/second for five minutes, which
is the required measured 40% reserve above the 100/session sustained target.
The Redis scenario stops the exact disposable Redis container for 60 seconds
and proves Redis plus backend health recovered; the restart scenario signals
only the disposable backend and proves health returned. Retain each k6 summary,
fixture manifest, database verification report, and fault artifact.

Deployment remains blocked unless all four runs pass their built-in gates:
every offered session completes; interactive p95/p99 are below 500 ms/1 s;
sync-v2 is below 750 ms/1.5 s; legacy steps are below 2 s/5 s; aggregate
5xx/timeout/unexpected rate is below 0.1%; pool wait p99 is below 50 ms with
zero checkout failures; resolution p95 lag is below 30 seconds and drains
within five minutes; and the four process memory/census checks pass. Retain the
`.json`, `.txt`, and `.metrics.json` artifacts plus the event-surge structured
logs. The permanent provider-admission candidate is 6,000 attempts/minute
(100/second, exact 10,000-microsecond spacing); 12,000 production-shaped
device attempts therefore fit the approved two-minute window. Changing that
rate or any 10/10/8/4 pool ceiling is a reviewed code/config change, never a
runtime tuning action.

This workflow does not authorize a production dump, deploy, restart, pool
change, cron stop, or database mutation. Each production operation still
requires fresh explicit authorization.

## Current findings from today

- A single worker at 40 offered RPS only achieved about 13.25 RPS, with the
  20-connection pool saturated and long waits.
- With two workers, 12 offered RPS achieved about 12.94 RPS with no pool
  waiters; 25 offered RPS initially appeared capped near 15 RPS because the
  old scheduler was closed-loop.
- After the open-loop scheduler was installed, 25 offered RPS produced clear
  backend/database saturation: race-progress p95 was about 4.15 seconds,
  database CPU averaged about 78%, peak pool waiters reached 62, and errors
  appeared on race-progress requests.
- The most actionable code hotspots are full progress replay/write-back when
  the cache is unavailable, full participant loading for race-resolution
  ownership checks, inline uploader reconciliation in `sync-v2`, and fat
  active-race bootstrap hydration. See the endpoint code before changing pool
  size.

## Still operator-controlled

Starting and destroying the disposable capacity environment remains an
explicit operator action so snapshot scope and the printed scrub manifest are
confirmed before traffic. Fault timing, recovery checks, and evidence capture
inside a started run are automated by the k6 workflow above.
