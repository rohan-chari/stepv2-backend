# Immediate daily/weekly Join: release validation

Implementation and local validation complete. Backend deployed with user authorization on 2026-09-09; see [deployment audit](seeded-immediate-join-deployment-2026-09-09.md). App release builds remain separate.

## Behavior

Join enters the current daily or weekly challenge immediately. Existing capacity
is filled first. When all groups are full, the next caller starts a new group;
later callers fill that group. Scoring starts at the accepted join time, with
crossing step samples apportioned by overlap. Existing automatic enrollment
continues to target the next challenge. Earlier preparation does not close Join.

Daily preparation starts at 23:30 America/New_York; weekly preparation starts
Sunday at 23:15. Nonurgent future preparation yields from 23:50 through 00:10.
Due activation takes precedence and drains bounded batches. Materialization
uses the existing canonical resolution worker and its write fence.

## Recovery corrections covered

- Receipt retries roll back unused race shells before replaying the result.
- Materializers reread reservations under the window lock before writing.
- Pruned historical memberships transfer through an auditable path.
- Interrupted preparation resumes, including automatic scans beyond 500 users.
- Eligibility transition timestamps exclude post-boundary opt-ins from recovery;
  exact accepted enrollment intents retain their original target window.
- Interrupted signup welcome grants retain durable progress and recover later
  without exceeding available slots or granting a second human entitlement.
- Pending prepared groups do not run premature scoring or placement work.
- Discarding a powerup durably queues inventory recovery in the same transaction,
  so unfinished welcome delivery does not depend on an unrelated later step sync.

## Environment and scope

All database tests use dedicated local PostgreSQL 18 on port 55439. Load tests
use isolated databases ending in `_load_test` and a separate local Redis.
No production or staging mutations were performed. Backend baseline for the
comparison is commit `3292872a31fb270773ab729ee00aeedfeb1e5875`.

The synthetic load topology is one HTTP process, two canonical scoring lanes,
post-task and placement workers, sharing a 20-connection pool. It is not the
production two-PM2-worker topology and does not establish production capacity.
The rollover scenario advances a virtual ET clock; PostgreSQL wall time stays
real. SQL instrumentation includes downstream workers. PostgreSQL CPU sums
connection backends and excludes shared background processes. Database counters
can lag; EXPLAIN plans and tuple counters have different meanings.

## Deployment order after authorization

1. Apply the five additive migrations, including nullable welcome progress and
   automatic eligibility transition tracking. No population rewrite is needed.
2. Stop the old coordinator and await its exit before allowing new preparation
   publication. Start the new resolution worker before the new coordinator can
   publish reservation-backed shells. Preserve exactly two production PM2 workers.
3. Verify the additive API contract with existing and current app versions.
4. Build and verify both iOS and Android using their README release configuration
   only after backend verification and release authorization.

Rollback must account for already published reservations and unfinished welcome
progress: an older worker cannot consume the new preparation protocol. Keep a
compatible worker running until outstanding work is drained; do not discard
membership ledgers or progress records. Client rollback alone does not require
removing additive fields or migrations.


## Load evidence handling

The initial rollover fixtures inserted historical samples without the associated
scoring input generation records. The 5,000-user baseline rejected those
incomplete inputs until each account synced. Those initial artifacts are retained
for diagnosis and excluded from comparison. Corrected fixtures initialize the
same durable generation state for both implementations. The corrected baseline
runs (`rollover-baseline-1000-r2.json`, `rollover-baseline-5000-r2.json`) have zero
HTTP, SQL, or worker errors, all expected memberships, and fully drained queues.

| Corrected baseline | 1,000 users | 5,000 users |
| --- | ---: | ---: |
| Midnight SQL calls | 78,974 | 388,133 |
| Step sync p95, ms | 39.84 | 42.07 |
| Transaction p95, ms | 15.58 | 14.93 |
| PostgreSQL backend CPU, ms | 10,290 | 47,570 |

These are local measurements, not production capacity claims. Candidate results
must use the same corrected fixtures and include all downstream work.


## Test evidence

- Flutter analyzer: clean. Full Flutter suite: 3,176 passing tests; focused
  current-Join widget/transport coverage includes iOS and Android behavior.
- Backend seeded integration suite: 115 passing tests across 12 suites,
  exercising real HTTP and the dedicated database.
- Step-only resolution and discard-triggered recovery: 2 focused integration
  regressions pass, with scoring preserved and zero membership probes on pure
  step claims.
- Native release builds and production deployment have not been performed.


The user explicitly authorized removing the obsolete discard timezone test on
2026-09-09. It asserted that a conflicting X-Timezone could not change the
stored timezone during the request; current authentication reconciles that
header before serving progress. The assertion failed identically on the
unchanged baseline. Only that test and its unused date-formatting helper were
removed; production timezone behavior and other discard assertions are intact.


## Final load results and tradeoff

All eight corrected comparison/admission/recovery scenarios passed: baseline
rollover at 1,000/5,000 users; candidate rollover at 1,000/5,000; current admission
with concurrent step sync at 1,000/5,000; and candidate cold recovery at both sizes.
Every scenario has all expected memberships, no overfilled group and no remaining
queue work. Measured midnight/current traffic had zero HTTP, SQL or worker errors.
Normal early preparation has one expected duplicate `job_runs` primary-key claim
per run, from the existing once-per-day retention guard; it is handled normally.

[Committed detailed results and admission EXPLAIN plans](seeded-immediate-join-load-results.json)
include the exact source hashes, SQL counters, database counters, transaction
latencies, HTTP latencies and workload limitations. Raw diagnostic logs remain in
`build/immediate-join-evidence/` locally. Earlier fixture-invalid or failed
contention runs are excluded from the accepted results and retained for diagnosis.

| Normal rollover, 5,000 users | Baseline | Candidate |
| --- | ---: | ---: |
| Observed maximum transaction, ms | 1,292.96 | 153.26 |
| Transaction p95, ms | 14.93 | 15.66 |
| Transaction p99, ms | 25.27 | 26.28 |
| Step-sync p95, ms | 42.07 | 41.15 |
| Midnight SQL calls | 388,133 | 387,799 |
| Midnight PostgreSQL backend CPU, ms | 47,570 | 47,750 |
| Early + midnight SQL calls | 388,133 | 408,127 |
| Early + midnight PostgreSQL backend CPU, ms | 47,570 | 50,500 |

The measured benefit is an approximately 88% reduction in the **observed maximum**
midnight transaction duration. It is not a guaranteed upper bound. Transaction
p95/p99 did not improve. Midnight query count and CPU are effectively flat;
including early preparation, total query count increases about 5.2% and backend
CPU about 6.2%. The implementation trades some total work for bounded preparation,
durable recovery and shorter large transactions around midnight. Do not describe
this as a general database CPU reduction.

Preparation for both windows completed in 11.63 seconds at 1,000 users and 17.09
seconds at 5,000, well within the pre-23:50 schedule. These durations include
worker readiness/draining. The corrected driver invokes the coordinator once at
each scheduled phase, independently draining workers rather than inventing many
cron ticks per second.

Current admission accepted every request at concurrency eight: 200 joins at
1,000 users and 1,000 joins at 5,000 users, plus idempotent replays. Join p95 was
113.91 ms and 92.16 ms respectively. Both sizes created overflow groups for both
seeds and respected all caps. Admission candidate EXPLAIN execution times were
below 0.22 ms at the measured final states; these do not bound all production
queries or contention.

Cold recovery at 5,000 users finished with 10,000 accepted memberships and empty
queues. Observed maximum transaction was 108.03 ms and step-sync p95 41.55 ms.
Cold recovery figures are candidate-only, not a baseline comparison.

## Final checks and handoff

- Full backend unit suite: 3,370 passed. After the contention correction:
  115 seeded integration tests and all 12 write-fence inventory tests passed.
- Remaining discard integration suites after the explicitly authorized obsolete
  test removal: 40/40 passed. No other assertions were weakened or removed.
- Flutter analyzer clean; full suite 3,176 passed. Both platform paths covered.
- Combined source and subsequent admission-lock correction reviewed with no
  remaining blockers. Native release builds and manual device QA remain part
  of the separate authorized app release process.

The frontend spec contains the manual UI-placement checklist under section 13.
The feature branches are `feature/immediate-challenge-join` in both repositories;
changes were kept in isolated worktrees and unrelated main-worktree edits retained.
