# Bara performance testing

The operator entrypoint is intentionally small:

```bash
./perf smoke
./perf scan
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
production-shaped Lima target. One k6 iteration represents one complete Home
screen opening, including the current mobile client's step sync and conditional
request graph.

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

Warm scans prewarm a bounded representative cohort once with GET-only Home
reads (10 opens/sec, at most 300 users by default), then use a bounded
stabilization warmup at each rate. Initial prewarm never calls step sync or
feeds resolution queues. Cold scans perform non-cache-filling health checks, clear
only the performance-owned Redis prefix, verify it is empty, reset metrics,
and immediately measure.

The scan uses 60-second discovery measurements, confirms the first failure,
narrows the pass/fail boundary, and explicitly measures the rounded 80%
headroom candidate before calling it safe. Results are written to:

```text
performance/results/<run-id>/summary.json
performance/results/<run-id>/report.md
```

## Safety and local inputs

Normal commands refuse arbitrary targets. Traffic must resolve only to the
loopback Lima endpoint, the writable database must be the marked disposable
capacity database, and outbound providers remain disabled. Normal smoke and
scan commands never read production. They use the existing local sanitized
snapshot metadata and secrets in `.env.capacity.local` plus the checked local
production-parity overlay.

The initial preparation can restore and scrub the approved snapshot once. An
unchanged prepared environment is reused. If its code, dataset, hardware, or
workload binding changes, the command stops with an explicit `./perf reset`
instruction instead of guessing or mutating unrelated resources.

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
