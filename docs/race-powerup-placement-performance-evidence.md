# Race powerup and placement performance evidence

This is local, non-production evidence for
`race-powerup-and-placement-performance-requirements.md`. No staging or
production mutation was performed. The staging latency/load gates remain
**pending** and require separate deployment authorization.

All database runs below used the dedicated disposable database
`steps-tracker-integration`. Re-run them only after verifying that
`DATABASE_URL` names a `-integration`/`*_test` database.

## Completed local gates

The query-event harness constructs Prisma with `query` events enabled before
loading the application, listens to actual SQL, and drives the public HTTP
Sneaky endpoint plus the production step-sync service over real Postgres:

```sh
DATABASE_URL=postgresql://rohan@localhost:5432/steps-tracker-integration \
  node --test --test-concurrency=1 --test-force-exit \
  test/integration/performance-query-scaling.test.js
```

Observed on 2026-08-13:

| Gate | Small fixture | Large fixture | Result |
| --- | ---: | ---: | --- |
| public HTTP Sneaky SQL statements | 10 candidates: 9 | 300 candidates: 9 | constant |
| bulk step-sync SQL statements | 10 users: 3 | 750 users: 3 | constant |
| step-sync real-storage parity fixture | legacy: 16 | bulk: 4 | identical stored rows/sends; bulk lower |

The public Sneaky count includes authentication and request-context reads, not
only the domain query. The test enables query events only for its dedicated
Prisma process; production does not globally install a per-request query hook.

The 750-participant scheduler fixture and real-storage notification suites are
reproducible with:

```sh
DATABASE_URL=postgresql://rohan@localhost:5432/steps-tracker-integration \
  node --test --test-concurrency=1 --test-force-exit \
  test/integration/placement-performance-cron.test.js \
  test/integration/payout-drop-push-window.test.js \
  test/integration/step-sync-performance-service.test.js
```

Together these cover ties, finished/forfeited rows, null seed, mute, baseline
resync, unchanged baselines, bounded CAS, concurrent total/expiry/baseline
writes, failure isolation, exact team-transition claims, and the actual
visibility/window/cooldown/durable-claim notification path. Scheduler and
step-sync have no public HTTP route, so those tests enter at their production
job/service seams and retain real Postgres.

APNs transport lifecycle and OS shutdown cannot be expressed through an app
HTTP endpoint. `test/services/performanceRuntime.test.js` therefore uses a
fake HTTP/2 transport for reuse, concurrent connect, JWT reuse, timeouts,
GOAWAY/close/error eviction, alternate-host fallback, resolve-once, and close
during pending/active streams. `test/startup/index.test.js` exercises the
production shutdown registration seam for both SIGINT and SIGTERM and verifies
HTTP drain precedes APNs close and process exit.

## Actual disposable-Postgres EXPLAIN ANALYZE output

`performance-query-scaling.test.js` seeds 300 candidates (150 active Stealth
effects and 300 held inventory rows) plus 750 device-token rows, executes the
full production read predicates with `EXPLAIN (ANALYZE, BUFFERS)`, and asserts
that every plan contains buffer and execution timing evidence. PostgreSQL's
very long rendered UUID array filter is omitted below; the checked-in harness
executes it in full.

```text
active effects (300 candidate IDs; 150 matches)
Seq Scan on race_active_effects  (cost=0.75..15.75 rows=1 width=37) (actual time=0.026..0.067 rows=150 loops=1)
  Buffers: shared hit=6
Planning:
  Buffers: shared hit=14
Planning Time: 0.264 ms
Execution Time: 0.087 ms

held inventory (300 candidate IDs; 300 matches)
Sort  (cost=16.01..16.02 rows=1 width=49) (actual time=0.178..0.192 rows=300 loops=1)
  Sort Key: created_at
  Sort Method: quicksort  Memory: 48kB
  Buffers: shared hit=9
  ->  Seq Scan on race_powerups  (cost=0.75..16.00 rows=1 width=49) (actual time=0.024..0.126 rows=300 loops=1)
        Buffers: shared hit=9
Planning:
  Buffers: shared hit=11
Planning Time: 0.246 ms
Execution Time: 0.214 ms

device tokens (750 user IDs; 750 matches)
Seq Scan on device_tokens  (cost=1.88..27.45 rows=689 width=96) (actual time=0.038..0.180 rows=750 loops=1)
  Buffers: shared hit=15
Planning:
  Buffers: shared hit=2
Planning Time: 0.175 ms
Execution Time: 0.199 ms
```

These plans are evidence for the disposable fixture, not a claim about staging
cardinality or latency. Staging before/after p50/p95, cron wall time, connection
headroom, and rollback observation are still pending authorized deployment.
