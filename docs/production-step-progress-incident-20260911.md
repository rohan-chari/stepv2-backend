# Production step-progress investigation — September 11, 2026 UTC

Read-only investigation at 03:09–03:14 UTC (September 10, 23:09–23:14 EDT).
Runtime: `340b40574fac8f6be75792f00af17c9a2caf745e`.
No deployment, restart, configuration change, queue repair, or production data write.

## Confirmed findings

- Direct managed PostgreSQL metrics: one vCPU / 2 GB; 99.27% busy at 03:10:06 and 98.56% busy at 03:12:34. I/O wait was 0.07% and 0.43%; this is predominantly executing CPU. These are samples, not a historical average.
- Exactly two HTTP workers, one resolution worker and one cron worker online. Staging stopped. Resolution health returned `status: ok`, `redis: ok` despite logged failures.
- Main resolution queue continues completing work. At 03:12:04 it had 1 queued job, 1,639 succeeded, and no running/failed rows. Earlier service telemetry showed about 55 seconds of claimable lag; later observations included an empty queue. This does not establish that all individual projections are correct.
- Resolution logs repeatedly report `POST_TASK_RECEIPT_COLLISION`. A running post-task had an existing successful receipt for the same race/generation, matching dedupe key, snapshot success, and zero intents. Its receipt dated to September 10 at 01:35 UTC. `raceResolutionPostTask.finish` requires an existing receipt's completion timestamp to equal the new completion timestamp, so this observed retry cannot validate the old receipt. The origin of the recreated/reopened task is not established.
- HTTP error logs contain 15-second `P2028` step-sync transaction expirations, including source-bound reads and global-event summary work. These log tails lack per-error timestamps; their exact occurrence times and relationship to the reporting user are not established.

## Reporting user's stored state

The account's latest six retained step-sync responses were complete, with the latest at 01:26:07 UTC. Daily total: 15,029. They return the canonical deferred race-resolution contract. All three active race jobs had succeeded recently, but their participant totals last changed around 01:01 UTC.

| Race | Current box progress | Next threshold | Stored raw high-water |
| --- | ---: | ---: | ---: |
| Daily Challenge | 16,112 | 22,000 | 20,350 |
| Weekly Challenge | 43,079 | 48,000 | 47,317 |
| The Petty Crawl | 30,261 | 36,000 | 34,499 |

Every current box-progress value is 4,238 below its stored raw high-water. Existing award records confirm the daily race already awarded the 20,000 milestone and the custom race the 34,000 milestone before the report. Current progress is below those already-awarded milestones.

Production `getRaceProgress` clamps `next threshold - current box progress` to one 2,000-step interval. Therefore all three rows produce exactly 2,000 remaining, matching the reported symptom. This is a confirmed explanation of the displayed countdown, not proof of what originally made the scoring inputs diverge. Source reconciliation, cached/prepared scoring inputs, and historical progress changes still need a targeted reproduction. No threshold was lowered and no rewards were reissued.

## Interval database work

Unfiltered statement snapshots at 03:11:32.929 and 03:12:18.349 UTC: 9,506 calls and approximately 37.2 seconds accumulated execution time for statements present in both snapshots. This is query execution time including waits, not per-query CPU attribution; newly appearing statements are not included in these matched deltas.

- Statements mentioning durable capture: 5,205 calls / 11.89 seconds, including 699 root-materialization calls (4.50 seconds) and 850 interval-projection inserts (2.03 seconds). Root preparation is called individually by the durable scoring method.
- Notification-related statements: 72 calls / 8.24 seconds. Two completeness-repair statements accounted for 7.92 seconds and roughly 185,377 shared-buffer hits plus 6,902 reads. The normal reconciliation interval is five minutes, with immediate continuation on a full page; this burst should not be extrapolated as a constant per-minute rate.
- Post-task-related statements: 221 calls / 0.76 seconds, including successful work. Evidence does not support attributing the CPU saturation solely to the stuck receipt.
- Bounded step-sample page reads: 17 calls / 1.31 seconds.

One initial aggregate across all historical post-tasks hit the diagnostic five-second timeout; subsequent queue checks used pending-state filters. No EXPLAIN ANALYZE or application mutation function was executed by diagnostics.

## Next work

1. Reproduce the box-progress/high-water divergence through the real old-client sync and race-progress path using a dedicated test database.
2. Reproduce the existing-receipt retry and prepare an idempotent fix preserving receipt identity and delivery deduplication.
3. Measure and reduce durable-capture round trips and notification repair scanning, retaining concurrency and durability guarantees.
4. Obtain fresh deployment/data-repair authorization after fixes and any repair plan are tested and reviewed, as required by AGENTS.md.

The three findings are concurrent; a single common root cause has not been proven. Investigation is not a completed remediation.


## Remediation deployed (2026-09-11 UTC)

User explicitly authorized incident fixes and production deployment. Final verified runtime: `5f67302ad9e000cc2c5303118c477649f2812d4e` at 03:40 UTC. Deployment used the production safe-reload wrapper, preserving two HTTP workers, one resolution worker, one cron worker, staging stopped, and aggregate configured database pool budget 32. Both HTTP health checks returned status/Redis OK. No schema, dependency, environment, API-contract, or native binary changes.

- Receipt claim/finish repair (`b7f4e83`): recheck claim eligibility after concurrent updates and preserve the original completion timestamp when reconciling an existing receipt. The formerly stuck task is succeeded and retains its original 2026-09-10 01:35:04.521 receipt timestamp. No duplicate delivery was introduced.
- Durable interval projection batching (`dcda122`, deployed via `b1881e1`): persist bounded derived projections in a set, in stable conflict-key order, before advancing the checkpoint. The HTTP regression fixture reduced projection writes from 32 to at most 4 with unchanged attributed steps.
- Canonical box-input guard (`5f67302`): when current box progress differs from raw high-water, use the canonical calculation path instead of the legacy committed fast path. HTTP regression proves a 5,000-to-1,000 correction stays at 1,000 after a legacy queued sync, and another 100 steps increases box progress and race total by 100 without reissuing rewards or moving the consumed cursor.

Concurrent race-open caching changes deployed by another session were preserved. CPU changes cannot be attributed solely to these incident patches.

## Live verification and remaining incident scope

At 03:38 UTC all three affected active races had succeeded resolution state and no last error. Award records include the daily 20,000-step box and custom 34,000-step box. This does not prove every historical milestone was awarded: consumed/forfeited milestones must not be blindly reissued.

At 03:40 UTC the filtered pending-queue query showed 37 queued resolution jobs, oldest approximately 55 seconds, and no pending/failed post tasks. The managed CPU sample at approximately 03:39:48 was 21.21% idle (78.79% non-idle), versus approximately 99% non-idle before fixes. The next sample was 88.05% non-idle. These are short observations, not proof of sustained recovery. A full historical queue aggregate timed out and was replaced with a pending-state query.

The affected account's received daily totals oscillated between approximately 20,350 and 13,532–15,029 before settling. Stored current box progress remains 4,238 below its previous high-water across the active races. Existing consumed thresholds are preserved; the 2,000-remaining clamp can still appear until current eligible progress catches up. The deployed guard prevents the legacy path from replacing corrected progress with an old peak, but does not establish the device-side cause or independently resolve that countdown. No production box threshold reset, synthetic steps, or duplicate award grant was performed.

The user requested a 500-coin support gift. The existing idempotent, ledgered manual award script applied it once using a dedicated support reference; confirmed balance changed from 753 to 1,253. No email was sent. A draft explicitly avoids claiming full recovery.

## Validation

Tests ran only against a dedicated local test database. New regression tests were observed failing for the intended reason before implementation. Required code review approved all three changes; economy review approved preserving valid consumed cursors and rejected positive-delta farming/reset approaches.

- Receipt/storage lifecycle: 23/23 passed; real HTTP queue efficiency: 5/5 passed.
- Interval projection/reuse suite: 10/10 passed, including after merging concurrent production changes.
- New box regression and existing pure committed path: 2/2 passed.
- Configured unit suite: 3,397 passed and two worktree-environment failures; both affected suites passed after local symlink/config setup was corrected.
- Wider capture suite: 49/50 passed; historical cleanup failure reproduced on unchanged baseline.
- Wider queue/scoring suites: 76/93 passed. Targeted baseline runs reproduced the relevant existing lock/closure/fallback/fixture failures. Lease and watchdog timing behavior remains a verification limitation; no existing assertions were removed, skipped, or weakened.
- Referral catch-up audit was dry-run and reported no missing race activity or review ownership work.
- Flutter/native checks were not run because no mobile code changed. Existing iOS and Android API shapes are preserved.

Follow-up remains: monitor sustained database load and queue age; investigate the upstream step-total oscillation using client evidence; reconcile any claimed missing box against award and forfeiture provenance before changing durable rewards.
