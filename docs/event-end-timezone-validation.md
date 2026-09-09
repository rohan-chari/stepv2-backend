# Event-end draining and timezone validation

Status: implementation, review and fresh-database v4 validation complete.
Backend deployment was subsequently authorized and is recorded in the deployment audit. Requirements: [approved spec](event-end-drain-timezone-requirements.md).

## What changed

- Event ends drain in bounded, paced batches in the existing cron process,
  reusing the race-resolution queue. No new process or release toggle.
- The latest valid reported timezone replaces the 48-hour policy. Eligible
  future events and existing pending notifications change together. Started
  events, admitted notifications and overlapping/past replacement windows stay
  protected. Large future cohorts paginate in one bounded transaction.
- Redis caches committed timezone state with invalidation and stale-fill
  protection; outages fall back to PostgreSQL. Unchanged requests avoid timezone
  SQL. The app refreshes the timezone it sends, coalesces concurrent native reads
  and retains its last usable timezone if the native lookup temporarily fails.
- Additive migration adds durable event-end retry metadata and a partial index.
  Old app endpoints/response shapes and the two-PM2-worker topology are preserved.

## Tests and review

- Frontend: 7 new real HTTP transport assertions red before implementation,
  then 7 green; 90 relevant regressions passed; Flutter analysis clean. Shared
  iOS/Android behavior covered. No native dependencies/configuration/UI changes;
  no build/upload needed for this source validation.
- Backend: tests first, then 25 focused assertions green, covering immediate
  timezone and return travel, zero-candidate enrollment races, fresh eligibility
  clocks, more than 1,000 due ends, durable poison retries, transient contention,
  shutdown/tick coalescing, Redis outage, 105 future windows, and stale notification
  revisions in both real delivery lanes.
- Independent source/harness review: SHIP after fixing notification retry
  spinning, overlapping maintenance starvation, future pagination and DST fixtures.
- Exact final migration applied successfully via Prisma on fresh local PG18
  and PG16 paths. PG18 enrollment integration suite: 9 passed.
- Broader PG18 integration: 134/137 passed. All three failures reproduced on
  unchanged baseline: STEP_SYNC priority IMMEDIATE vs COALESCE; FULL vs
  DEPENDENCY_CLOSURE; and display-artifact boundary work absent. Final full unit suite: 3,366/3,370 passed. Four existing
  unit failures also reproduce on baseline (three old raw-query test doubles,
  one race-write inventory drift). No assertions were weakened.
- Deploy separately using the spec's nonrolling cutover: drain every old HTTP/
  race-join/cron writer and its transactions before starting the two existing
  workers on the new revision. Existing generation metadata cannot enforce
  this revision boundary; a brief maintenance window is required.

## Source and isolation

Baseline: `83d749484bab807fb2da10088d4bf3be6dc50387`, detached checkout with its
own original generated Prisma client. Candidate implementation hashes are in
`docs/evidence/event-load-final-candidate-source-hashes.json`.

Each final run uses a new database cloned from a migration-only template.
Baseline has its original migrations; candidate adds the event-end retry migration.
The harness requires loopback PostgreSQL 18, port 55439, a `_test` name and no
existing users. Synthetic summary completion receipts are explicitly cleared
before measurement. Redis is dedicated on port 56379, with a per-process cache
namespace. No production data, external push sender or staging service is used.

Local host: 10 logical CPUs, 16 GiB memory. PostgreSQL shared_buffers 256 MiB,
max_connections 48, max_parallel_workers_per_gather 0, track_io_timing enabled,
pg_stat_statements preloaded. The app uses one all-role process, a 20-connection
pool, two resolution loops, and the actual summary scheduler. This differs from
production CPU capacity/process layout and cannot certify million-user capacity.

## Workloads and interpretation

Deterministic users/request identities; two race memberships per user; a due
event and a future event. Every user initially syncs, then requests rotate
60% sync / 20% auth / 20% race progress. Ten percent report travel. Samples
contain 100 raw steps before the event, 60 inside its 2x window and 1 after it,
for an expected participant score of 221.

- **Paced:** production scheduler on both roots, fixed observation window.
  Report CPU/latency together with completed work and backlog.
- **Completion:** baseline legacy maintenance advances without minute sleeps;
  candidate uses its actual paced scheduler. This compares each architecture's
  completed-cohort cost, not identical scheduling cadence. After ends drain,
  a measured follow-up HTTP sync corrects the final sample from 1 to 2 steps
  for every user (162 raw / 222 scored). This supplies the fresh observation
  required for summary capture. Both initial and follow-up requests must be
  accepted; ends, race jobs, summaries and scores must all finish correctly.
  Recovery has a deadline; any remaining work is an incomplete result.

Measurements include request status/latency, backlog, sampled lock waiters,
database writes/transactions/deadlocks, pg_stat_statements calls/WAL/buffers,
and per-PID PostgreSQL CPU increments sampled about every 200 ms. CPU is a
lower-bound estimate: short-lived processes and final unsampled tails can be
missed. SQL execution time is not CPU time. Stats are flushed on every pool
connection before/after the workload; fixture preparation precedes reset.
Generation-owner leases are renewed throughout measurement. Shared-host noise
and sampling prevent precise production extrapolation.

## Superseded exploratory evidence

Exploratory artifacts from harness versions 1–3 were marked SUPERSEDED and
archived outside the committed final evidence. Version 1
had nondeterministic user assignment, incomplete CPU/stat accounting and an
unrepresentative summary recovery cadence. Later repeated runs reused IDs while
the general test reset retained standalone `job_runs` completion receipts,
causing artificial duplicate-key retries. Their before/after CPU and backlog
comparisons are discarded. Version 4 uses fresh databases per run, corrected
accounting and the actual candidate scheduler. Only v4 results belong in the
final comparison below.

## Reproduction

Prepare migration-only baseline/candidate templates, then clone a new database
for each run. Apply pg_stat_statements and the local settings above. Run pairs
sequentially on the same host with the same harness/settings.

```sh
DATABASE_URL=postgresql://LOCAL_USER@127.0.0.1:55439/FRESH_BASELINE_test \
node scripts/perf/event-end-timezone-load.js --root=BASELINE_CHECKOUT \
  --users=1000 --races=20 --requests=2000 --concurrency=24 \
  --duration=30 --mode=equal-work --recovery=180 \
  --label=baseline-83d7494 --output=NEW_BASELINE_RESULT.json
```

Use the candidate checkout and a different fresh database/output for its run.
Large paced case: 5,000 users, 100 races, 10,000 requests, 60 seconds, mode paced.
The harness refuses overwriting evidence and erases synthetic fixtures only
after its local/test/fresh-database guards pass.

## Final v4 results

### Completed cohort: 1,000 users / 20 races

Both versions accepted all 2,000 initial requests and all 1,000 follow-up syncs,
created 1,000 summaries / 2,000 capture artifacts, finished all 20 race jobs,
and gave every participant the expected 222 steps. No deadlocks.

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Measured completion time | 48.09s | 48.70s |
| Sampled PostgreSQL CPU (lower bound) | 33.63s | 34.04s |
| SQL calls including downstream | 415,928 | 415,714 |
| Recorded WAL bytes | 186,183,622 | 187,217,748 |
| Initial sync p95 | 160.7ms | 164.4ms |
| Follow-up sync p95 | 74.2ms | 81.6ms |
| Maximum sampled lock waiters | 4 | 6 |
| Database rollbacks | 0 | 1 |

Total work is essentially unchanged in this single pair. This does not support
a claim of reduced database CPU per fully processed cohort. The end scheduler
change controls when work advances; it does not remove the existing summary/
scoring work. Baseline minute sleeps are removed only in this completion case.

### Large paced burst: 5,000 users / 100 races

Both versions accepted all 10,000 requests (8,000 sync / 1,000 auth / 1,000
progress), and all users had correct 221-step participant totals. No deadlocks.

| Measurement | Baseline | Candidate |
| --- | ---: | ---: |
| Pending event ends after approximately 60s | 4,800 | 0 |
| All ends completed | Not within window | 10.56s |
| Sampled PostgreSQL CPU (lower bound) | 32.70s | 71.74s |
| SQL calls including downstream | 224,510 | 563,398 |
| Recorded WAL bytes | 168,875,829 | 428,583,040 |
| Sync p95 | 80.3ms | 170.6ms |
| Auth/timezone p95 | 35.1ms | 31.7ms |
| Race progress p95 | 52.2ms | 44.0ms |
| Maximum sampled lock waiters | 1 | 6 |
| Database rollbacks | 0 | 11 |
| Completed summaries | 100 | 165 |
| Pending race jobs | 86 | 10 |

The candidate advances substantially more work in the same minute. That costs
more database CPU/WAL and increases sync latency under this burst. Both runs
leave summary work pending; 4,118 candidate summaries were queued, 708 awaited
fresh sync and 9 awaited races. This is a throughput/reliability improvement,
not proof of lower CPU spikes. The completed-cohort pair shows essentially
unchanged total cost. Further savings must reduce the existing downstream
scoring/summary work; merely draining faster does not create capacity.

Across the final pairs, all 26,000 HTTP requests succeeded. Supplementary outcome
checks found no incorrect summary totals or capture deltas: 120 extra race steps
across two races per summary, 60 attributed steps per capture artifact. See
`docs/evidence/event-load-v4-outcomes.json`. The final evidence is one pair per
workload on a shared local host; it is not a production capacity guarantee.

### Delivery status and limits

Frontend commit: `00c749e` (request timezone refresh). Backend implementation and
raw v4 evidence were prepared on the matching review branch. The backend was
subsequently [deployed to production](event-end-timezone-production-deploy-2026-09-09.md);
the frontend app change remains unreleased.
The older 48-hour pure helper remains only for compatibility tests/internal
callers; production auth and persisted enrollment use the immediate policy.

Cache invalidation failure can require the 60-second cache TTL to recover.
Transaction contention/timeouts preserve prior durable state and retry on a
later request/pass. The migration is additive; old app HTTP contracts remain
compatible. The required nonrolling release sequence is documented in the spec.
