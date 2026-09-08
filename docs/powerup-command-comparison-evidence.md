# Powerup queue comparison: local screening, 2026-09-08

The tested queue is not an efficiency improvement over direct execution. Keep
the narrower-lock implementation; do not adopt this queue prototype from these
results. Shared reads/batched writes remain a possible optimization, but this
experiment does not establish a benefit from queueing all powerup usage.

## Measured comparison

A is unchanged release **3b241ff**; B is narrower locks **9b2cfb8**. C adds an
ordered durable queue; D adds limited shared race/roster reads and bulk feed
writes. Two HTTP processes, one resolution process, pools 10/10/8, shared worker
budget three, real HTTP handlers, local PostgreSQL 16 and Redis, identical
fixture sizes and offered traffic. No artificial lock hold was introduced.

Each screening run lasts 30 seconds. All arms accept 480 real step-sync uploads
at 16/s. Powerups use a twelve-type mix plus a separately measured final Outage.
The following table excludes Outage and drain from CPU/SQL and latency. CPU is
local PostgreSQL process CPU seconds, not app CPU or production utilization.

### One 2,000-player weekly race, eight powerup uses/s

| Arm | Successful / offered | HTTP p95 ms | Step-sync p95 ms | DB CPU seconds | SQL statements |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 211 / 240 | 41.9 | 29.8 | 4.45 | 21,735 |
| B | 211 / 240 | 50.5 | 31.7 | 4.50 | 22,546 |
| C | 212 / 240 | 4117.2 | 26.1 | 5.88 | 46,517 |
| D | 212 / 240 | 1492.0 | 24.4 | 5.38 | 37,972 |

### 100 twenty-player races, 32 powerup uses/s

| Arm | Successful / offered | HTTP p95 ms | Step-sync p95 ms | DB CPU seconds | SQL statements |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 844 / 960 | 27.5 | 22.3 | 9.91 | 80,877 |
| B | 845 / 960 | 28.7 | 21.9 | 10.12 | 82,936 |
| C | 845 / 960 | 219.8 | 20.8 | 12.56 | 120,559 |
| D | 845 / 960 | 220.0 | 21.5 | 12.50 | 122,454 |

Successful-response-only p95 values are also retained in the JSON. All remaining
responses above were gameplay rejections (400/409); there were no 5xx, client
15-second deadline misses, lost/unissued requests, or forced application stops.
Slight successful-count differences are consistent with random targeting and
execution order: offered workloads match, but these are not identical
accepted-work replays. In the small-race B/C/D comparison, all three successfully
apply 845 uses.

The small-race queues use approximately **24% more DB CPU** than B and **45–48%
more SQL**, while p95 grows from 29 ms to 220 ms. Weekly D uses about **20% more
DB CPU** and **68% more SQL** than B, despite substantial improvement over C.
These are observations from one screening run per arm/scenario, not confidence
intervals or production capacity forecasts. A and B are close enough here that
these runs do not establish a general uncontended speedup from narrower locks;
prior lock-contention regression evidence remains a separate result.

## Why the queue lost

In the weekly screening, C's p95 time from HTTP send to handler instrumentation
was 4,088 ms; D's was 1,460 ms. The p95 remainder after that instrumentation was
63 ms and 101 ms respectively. These are separate distributions, not additive
phase percentiles or exact commit/lock timings. They locate most added delay
before ordinary command evaluation, consistent with scheduling/fence waits.

D averaged **1.39 commands per batch** in the large race, recording 61 shared-read
hits and 60 feed rows through its bulk path. Across small races, occupancy was
**1.00**, with zero shared-read hits. Its 240 feed rows there were one-command
bulk-path writes, not proof of cross-command batching savings. Durable admission,
claiming, terminal persistence, post tasks, and HTTP result polling every 20 ms
all contribute database work. Merely moving the existing handlers behind a
queue did not amortize those costs.

D genuinely batches only Compression Socks, Mirror, Umbrella, Decoy, Stealth
Mode and Runner's High. Protein Shake, Trail Mix, Shortcut, Outage and other
complex commands are ordered single-command boundaries. Their rules still run
through the canonical handler. These results therefore reject this implementation
as an optimization; they do not prove a more complete shared-state engine could
never help.

## Correctness findings and remaining gates

The 2,000-membership raw-step, bonus-transfer, total-step and inventory accounting
checks passed in all eight screening runs before public progress reads. Every
queue command reached a terminal result, and successful commands completed their
durable response work. No final resolution jobs were failed or still running.

**All eight runs nevertheless fail the full harness check:**

- The weekly runs retain full-scope trigger rows after the 15-second drain:
  A 473, B 159, C 473, D 479. Two earlier low-rate A calibrations also failed
  after 90-second drains. In the baseline source, promotion requires
  `job.full_trigger_seed_only`; retained rows can coexist with a succeeded job
  whose marker is false. Stored arithmetic passing does not prove these rows
  are safe to ignore. This is a separate baseline investigation, not a fix
  silently applied to make queue results green.
- Every arm records terminal snapshot-publication failures with
  `SNAPSHOT_GENERATION_ADVANCED`. Counts vary with scheduling. They are not
  powerup HTTP failures, and these runs do not prove customer-visible stale
  standings, but the required zero-failure publication check is not satisfied.

Functional validation passed **55 dedicated HTTP/storage tests**, **two
15-command unchanged-baseline semantic replays**, and **97 selected existing
command regressions**. The backend agent also ran a 67-test existing-command
selection; these counts overlap and must not be summed. Flutter analyze is clean.
No Dart, iOS or Android implementation/build configuration changed, so no mobile
builds were run. Code review approved local exploratory use only.

The semantic replay covers shield consumption, reflection, Decoy randomness,
Outage/jam/Cleanse ordering, instant bonuses, Quick Rinse and X-Ray. It normalizes
generated IDs and absolute timestamps, and its D replay executes one command at
a time. A separate two-Runner's-High test proves actual shared reads/bulk writes.
Full multi-command batch response/state parity, receipt identity, expiry and
settlement boundaries, cross-race wallet concurrency, and transfers/discards
remain acceptance gaps. The timed-effect portion of the load oracle is limited:
historical samples intentionally predate new effects so arithmetic is independently
predictable. Do not describe it as full gameplay parity.

## Scope of the experiment and reproducibility

This is a bounded first screening, not completion of the planned full acceptance
matrix. The planned isolated/burst cases, 2/8/32-rate by zero/16-sync matrix and
three alternating repetitions were not completed. Expanding the timing matrix
would not make a candidate with failed correctness gates eligible; the measured
queues also failed the basic CPU/latency hypothesis. Earlier calibration runs
are preserved, including failures and runs that may overlap local functional
test activity. Only the eight `screen1-*` runs above were performed after runtime
source froze and other test processes stopped. Their arm order was B/A/D/C for
the weekly race and C/D/A/B for small races.

The measurement code and workload are identical across the screening. A/B's
harness hash differs only because a later cleanup change exits after closing all
owned resources instead of waiting for imported application timers; it occurs
after evidence collection. Runtime queue source hashes match across C/D. CPU
sampling is a lower bound and can miss the initial CPU of newly observed or
short-lived PostgreSQL processes. The host is not production hardware, uses
PostgreSQL 16 rather than production's version, and has no CPU quota matching
production. SQL counters exclude observer SQL, while DB CPU includes identical
observer sampling overhead. The uncompressed originals remain in local artifacts.

- [Harness/setup and measurement definitions](../scripts/experiments/powerup-command-comparison/README.md)
- [Prototype and functional validation](powerup-queue-prototype-validation.md)
- [Machine-readable summary, including failed calibrations](evidence/powerup-command-comparison/summary.json)
- [Environment](evidence/powerup-command-comparison/environment.json)
- [Checksummed raw response/worker evidence and test logs](evidence/powerup-command-comparison/manifest.json)

No production/staging service was started or deployed by this experiment. The
prototype is isolated on an experiment branch and adds no production migration.
