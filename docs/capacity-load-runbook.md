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
  processes on loopback ports 3010 and 3011. Each process has a 20-connection
  application pool, matching the production PM2 topology.
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
- Pool metrics are currently observed through the worker that answers the
  health sample. The configured pool is 20 per worker and 40 total; the report
  does not yet emit a combined two-worker pool series.
- The local target uses the same Redis and dedicated resolution/cron process
  topology as production. The queue remains database-backed, and all local
  containers are destroyed after the run.
- A cleanup warning such as `baseline integrity changed during synthetic
  cleanup` means background cron/resolution work changed baseline rows during
  the run. The load report is written before cleanup, and destroying the VM
  removes all synthetic data. Treat it as a fixture-cleanup observability issue,
  not as a request error.
- Do not increase the application pool solely because it waits. Check Postgres
  CPU, slow queries, lock/wait data, and query plans first.

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

## Not yet automated

The workflow is reusable but not literally natural-language instant. A person
still has to edit the run config, confirm the printed manifest, and start the
load command. The following are the next useful automation items:

1. Add a small command that accepts `run-id`, users, RPS, duration, and config
   path, writes a local run config, starts, runs, captures reports, and destroys
   in one guarded flow.
2. Split sustained traffic, coverage traffic, and queue-drain traffic in the
   result schema so achieved RPS is directly comparable to offered RPS.
3. Aggregate health/pool telemetry from both workers and label samples by
   `NODE_APP_INSTANCE`.
4. Add Postgres slow-query capture and `EXPLAIN (ANALYZE, BUFFERS)` collection
   for the database-heavy endpoint set.
