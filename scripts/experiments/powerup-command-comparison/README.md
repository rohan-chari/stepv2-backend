# Local powerup command comparison

This is an isolated experiment, not an application startup path or a production
queue release. Its schema installer refuses non-local databases and databases
without the `_test` suffix. The load runner additionally requires PostgreSQL
port 55445 and Redis port 16389, and refuses checkouts containing `.env`.
The runner deletes fixtures and flushes this dedicated Redis instance.

## Arms

| Arm | Source | Execution |
| --- | --- | --- |
| A | `3b241ff` | Original direct HTTP command |
| B | `9b2cfb8` | Direct HTTP command with narrower participant locks |
| C | Experimental checkout based on B | Durable ordered per-race queue, one command per transaction |
| D | Same experimental checkout | C plus shared race/roster reads and deferred bulk feed inserts for eligible self effects |

D batches Compression Socks, Mirror, Umbrella, Decoy, Stealth Mode and Runner's
High. All other types use single-command boundaries. Effects are inserted
immediately so the next command can observe them. Silent shields remain silent;
the experiment does not create feed events for them merely to show batching.
This is not an implementation of shared evaluation/bulk writes for every type.

## Setup and execution

Create clean detached checkouts for A and B with their existing dependencies.
The experimental checkout uses the same Prisma schema and dependency versions.
Create a disposable PostgreSQL 16 cluster bound to `127.0.0.1:55445`, configured
with UTC timezone, and a database named `steps_powerup_queue_load_test`. Apply
the existing migrations. Start a disposable Redis on `127.0.0.1:16389` without
persistence. Do not reuse a production/staging URL or a shared Redis service.

Set `DATABASE_URL` and `REDIS_URL` to those instances, then run from the
experimental checkout:

```sh
node scripts/experiments/powerup-command-comparison/load.js \
  --source-root /tmp/powerup-baseline-checkout --arm A \
  --profile weekly --rate 8 --sync-rate 16 --seconds 30 \
  --pg-pid <dedicated-postmaster-pid> --drain-ms 15000 \
  --output artifacts/powerup-command-comparison/A-weekly-8-1
node scripts/experiments/powerup-command-comparison/summarize.js
```

Use the experimental checkout as `--source-root` for C/D. Run arms sequentially;
pause other local integration/load tests during measured runs. Stop only the
PostgreSQL, Redis and application processes created for this experiment.

Each run uses two HTTP processes with pools of ten, one resolution process with
a pool of eight, and the existing shared core/post work budget of three. The
real resolution, post-task and placement workers run in every arm. C/D add
three command polling loops sharing that same work budget. Other production
cron/notification services are not started. No application `.env` is loaded.

The fixture has 2,000 memberships: one 2,000-player race or 100 twenty-player
races with overlapping users. Forty percent start with a reproducible defense
allocation. The sustained mix contains twelve types; a separate end-of-load
Outage probe avoids jamming most of the workload and miscounting cheap
rejections as an efficiency win. Real step sync HTTP requests update existing
historical samples. No artificial participant lock hold is used.

## Evidence and interpretation

Each result retains every response, offered/unissued request accounting, process
query/CPU/pool samples, queue occupancy, worker logs, database CPU deltas,
source revisions and hashes. Load, Outage and drain are separate phases.
`loadDbCpu` and `processLoadEnd - processStart` measure the offered workload plus
completion of its requests. The longer overall window additionally includes
Outage and drain. Always compare CPU seconds alongside latency and accepted
counts; utilization falls artificially if a failed drain simply waits longer.

Database CPU is the sum of positive CPU-time deltas from the dedicated
PostgreSQL parent and its children, sampled every second with `ps`. It excludes
unknown CPU before a newly observed process's first sample and can miss a
short-lived process entirely. It is a local lower-bound measurement, not
managed-production CPU, and the application is on the same host as PostgreSQL.
Application query counters exclude fixture/observer SQL; database CPU includes
the observer's identical sampling queries. No SQL-row count or exact commit,
pool-wait or lock-wait latency claim is made from these counters.

The load check verifies terminal transport/inventory consistency, stored raw
steps, bonus transfers, total steps and sampled public progress. It checks
storage before public reads. Historical samples precede new timed effects,
making the arithmetic independently predictable: this is an accounting check,
not comprehensive timed-effect/defense parity. Separate integration tests replay
controlled C/D command sequences and recorded randomness through the unchanged
baseline HTTP path, comparing responses and persisted gameplay state.

Any failed drain or post-task failure remains a failed check. A successful
accounting subset does not turn that run green. Experimental performance results
cannot justify a production recommendation while correctness gates remain open.
