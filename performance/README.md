# Bara performance testing

The operator entrypoint is intentionally small:

```bash
./perf smoke
./perf smoke --workload=races-tab-open
./perf scan
./perf scan --workload=races-tab-open --rates=5,10,15,20,25,30
./perf scan --rates=5,10,15,20 --cache=warm --background=normal
./perf reset
```

`smoke` is first-run ready from a clean committed/immutable checkout. `scan`
orchestration is implemented, but remains provisional until the full Home
mutation audit and numeric queue/resource safety baselines are complete; until
then it cannot report a safe operating capacity. `certify`, `compare`, and
`refresh-data` remain disabled until their later implementation phases are
completed, and never silently fall back to a weaker mode.

The complete requirements and migration design are in
[`docs/load-testing-rebuild-requirements.md`](../docs/load-testing-rebuild-requirements.md).

## What a scan does

The tool sends k6 open-loop arrival traffic from the host to a reusable,
production-shaped Lima target. The default `home-open` workload represents one
complete Home opening. `--workload=races-tab-open` represents one real Races-tab
reveal: the compact race list refresh completes first, then discovery and the
fixture-selected zero-friends branch run in the background. The configured rate
is screen opens per second, not total endpoint RPS.

The ordinary Races baseline fixes the reveal five seconds after Home. That is
outside the friends repository's one-second duplicate-read reuse window but
inside its 60-second freshness window, so zero-friends users make the same
conditional friends request as the shipped app. The report records this cache
age, the fixture's measured zero-friends share, request counts by endpoint, and
discovery/friends latency from endpoint-tagged measurement HTTP metrics.

Races profile `2.0.0` materializes and validates the complete API-backed page
shape: ordinary active/pending/invited/completed and team rows, favorites,
placements/privacy display, inventory/effects, and every reachable tournament
render state. Each measured response is compared with its fixture identity's
captured normalized projection. `CANCELLED` tournaments are explicitly not a
measured variant because the current `GET /races` query excludes them.

The environment is prepared once. PostgreSQL, Redis, the two HTTP workers, the
resolution worker, and cron worker stay alive across every ladder level. Test
users are provisioned once and a guarded targeted reset restores only their
run-owned mutable state between levels. No ladder level restores PostgreSQL,
recreates Redis, rebuilds the backend, or rebuilds fixtures.

The default `workload.scoreShape` is `production`. Fixture scores and ten-minute
sync increments are deterministically sampled from identifier-free percentiles
computed once from the sanitized snapshot, and placement baselines are seeded
consistently with those scores. Use `placement-churn` only for the explicit
worst-case scenario where racers begin tied and large syncs cause race-wide
placement movement; it is not the normal Home capacity profile.

Warm scans prewarm a bounded representative cohort once with GET-only core
reads (10 opens/sec, at most 300 users by default), then use a bounded
stabilization warmup at each rate. Initial prewarm never calls step sync or
feeds resolution queues. Cold scans perform non-cache-filling health checks, clear
only the performance-owned Redis prefix, verify it is empty, reset metrics,
and immediately measure.

Before each Races measurement, the harness deletes only the exact race-list
keys for that attempt's measurement identities and establishes the centrally
configured hot-30/hot-15/expired-300 cohort. The shipped default is explicitly
diagnostic and uncalibrated; a scan remains useful, but safe capacity stays
unavailable until `raceListTargetMix` is replaced with measured calibration.
Warmup identities are disjoint, and cache evidence is accepted only when its
run, attempt, and measurement phase match.

Race-list source evidence counts logical reads rather than every cache fragment
or write. The compact bounded route therefore reports one PostgreSQL `bounded`
read per core request in validated capacity mode; Redis fragment hits are
collapsed to one logical hit. Ordinary production samples successful bounded
reads at 1 in 100 so this diagnostic does not create material hot-path log
pressure.

The scan uses 60-second discovery measurements, confirms the first failure,
narrows the pass/fail boundary, and explicitly measures the rounded 80%
headroom candidate before calling it safe. Results are written to:

```text
performance/results/<run-id>/summary.json
performance/results/<run-id>/report.md
performance/results/<run-id>/races-tab-mismatches.json
```

For Races profile `2.0.0`, every attempt runs long enough to start at least 300
tab reveals. Stabilization and measurement use disjoint identity pools sized
from the 31-second deadline. Rates above the profile's 76/sec identity ceiling,
fixture files above 64 MiB, incomplete 28-variant coverage, projection
mismatches, or unhealthy generator evidence fail closed.

## Safety and local inputs

Normal commands refuse arbitrary targets. Traffic must resolve only to the
loopback Lima endpoint, the writable database must be the marked disposable
capacity database, and outbound providers remain disabled. Normal smoke and
scan commands never read production. They use the existing local sanitized
snapshot metadata and secrets in `.env.capacity.local` plus the checked local
production-parity overlay.

The initial preparation can restore and scrub the approved snapshot once. An
unchanged prepared environment is reused across Home and Races workloads;
workload fixtures are regenerated and cleaned up per run. If environment-
relevant code, dataset, hardware, topology, parity, or provider binding changes,
the command stops with an explicit `./perf reset` instruction instead of
guessing or mutating unrelated resources.

`./perf reset` is destructive only inside the environment whose persisted
state, resource labels, workflow ancestry, and live provider lock all prove
ownership. It does not accept a URL, database name, or container name from the
operator.

## Current limits

- Background `normal` is enabled for the first run. `background=off` fails
  closed until its distinct process topology and metrics census land.
- Scan refuses to label a rate safe while queue/resource safety gates remain
  `baseline-required`, and its targeted reset still needs the exhaustive Home
  mutation audit before scan can be treated as complete.
- SIGINT/SIGTERM is observed at operation boundaries; an active k6 process may
  need to exit before cleanup begins.
- Lima results are regression/capacity evidence, not production certification.
- Certification, revision comparison, and production snapshot refresh are
  separate later phases and are currently rejected by the CLI.
