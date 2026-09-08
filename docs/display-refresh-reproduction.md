# Repeated display refresh reproduction

Historical baseline. The implementation experiment and matched-control findings are in [guarded-display-experiment.md](guarded-display-experiment.md). On the experiment branch, the test now asserts guarded reuse and its invalidation cases; the original reproduction remains in commit 3466f77.

Diagnostic against production code `441f307`, September 7, 2026 (EDT). No runtime change or production deployment.

## Result

A real legacy-compatible `GET /races/:id/progress` serves unchanged totals but, after its snapshot is older than 15 seconds, schedules a sole `DISPLAY_REFRESH` that runs the `FULL` resolution plan. Waiting another 16 seconds after that job succeeds reproduces the same full job. Pending-job coalescing therefore cannot remove this repeated work.

| Participants | Fresh read + drain | First stale read + drain | Second stale read + drain |
| --- | ---: | ---: | ---: |
| 10 | 14 | 55 | 55 |
| 100 | 15 | 58 | 56 |

Counts are `pg.Client.query` invocations, including harness job-state lookups and real post-task processing. They are not server statement counts or CPU measurements. Every stale attempt in this fixture used `FULL`, sole `DISPLAY_REFRESH`, and zero participant total/bonus writes. Other writes still occur. Fresh reads produced no worker attempt. Correcting the viewer's source sample through `POST /steps/sync-v2` changed the subsequent public total from 50 to 125.

The fixture uses real local PostgreSQL 18, transaction-pooled PgBouncer with prepared statements enabled, Redis, HTTP handlers, resolution worker, and snapshot/post-task runner. Other participants are synthetic database fixtures; the viewer's intake and all asserted reads go through HTTP. Samples are closed historical intervals, the race is active, and effects are disabled. These two sizes demonstrate repeatability, not a capacity ceiling or representative production scoring cost. Timings include an intentional 50 ms enqueue wait and must not be presented as request latency.

## Source path

- `raceProgressSnapshot.js`: snapshot soft freshness is 15 seconds.
- `getRaceProgress.js`: an old usable snapshot is served while `requestWorkerRefresh` enqueues `DISPLAY_REFRESH`.
- `raceResolutionQueueV2.js`: that reason enters FULL; artifact reuse additionally requires a carried artifact ID.
- `raceResolutionStepSyncScope.js`: pure display refresh is not eligible for the committed step-sync shortcut.

## What a fix must prove

Separate display publication from scoring validity. A stale display can be republished from committed results only when authoritative scoring inputs still match the committed calculation and no scoring time boundary has passed. Preserve queue generation/concurrent-write fencing; fall back to canonical scoring when validity cannot be established.

Inputs include source steps, membership, race state, effects, global events, relevant configuration and scoring timezone. Time can matter without an upload: effect start/expiry, samples crossing the scoring clock, race end, and hour/day boundaries. Merely extending the display TTL, discarding display jobs, or admitting pure display refresh into the committed-step shortcut does not establish safety.

Before runtime implementation, add failing public-path tests for an unchanged refresh avoiding FULL, a simultaneous upload still being applied, membership/effect/event invalidation, and clock boundaries including race completion. The existing effect-expiry suite is a baseline safeguard, not proof that an unimplemented optimization is correct.

## Validation

The two reproduction cases and 15 existing effect-expiry/cache cases passed (17/17, no skips). The latter cover expiry, terminal snapshots, generation ordering and repair/concurrency behavior. The reproduction was then strengthened to explicitly assert no fresh job and sole DISPLAY_REFRESH reasons and rerun. A subsequent helper-only run exposed Redis configuration being captured before its URL was assigned; startup now initializes Redis before importing application modules, and the same assertions were rerun without weakening them.

Use a dedicated localhost database whose name ends `_test`, migrate it to this revision, and provide `DATABASE_URL`, `NODE_ENV=test`, the integration session/referral test secrets, and optional localhost `REDIS_TEST_URL`. Run:

```sh
node --test --test-concurrency=1 --test-force-exit test/integration/display-refresh-reproduction.test.js
```

This file deliberately records current behavior. When changing refresh policy, replace the explicit FULL-reproduction expectation with the reviewed desired contract; retain public response and invalidation coverage.
