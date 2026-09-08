# Empty post-task production verification — 2026-09-07

Deployed 057ac94c075620df28f59dbb07610614f1b962f2 after explicit user approval.
Used the serialized PM2 safe reload wrapper. No migrations or dependencies
changed. Production package-lock checksum preserved. Two HTTP workers, one
cron worker, one resolution worker; staging stopped; concurrency 3 and aggregate
pool budget 32. Referral ledger dry-run: both missing counts zero. Public and
local health returned OK, including Redis.

## Five-minute observation

Waited for initial restart backlog to recover. Statement window approximately
23:41:35–23:46:37 UTC, 301.782 seconds. Eleven managed-database CPU samples,
approximately 30 seconds apart. Both finite monitors exited successfully.

- Average idle 15.75%, non-idle 84.25%, versus previous idle 16.11%.
  The 70% idle goal is not met; no meaningful overall CPU improvement demonstrated.
- Mean CPU user 49.83%, system 23.43%, steal 5.89%. Non-idle includes steal
  and other categories and must not be equated to SQL CPU consumption.
- 68,263 tracked statements, 226.20/s, versus 71,127 and 235.5/s previously.
  Workload differs: 888 post-task insertions versus 1,000 previously.
- Standalone snapshot completion calls 187 versus 1,002 previously. Priority
  snapshot processing still uses this statement. No intent-list or intent
  recovery-update calls appeared in the measured delta.
- Aggregate statement execution 272.51 seconds; elapsed execution includes
  waits and is not per-query CPU attribution. Planning tracking is disabled.
- Sampled queue size 0–8, oldest queued request at most 17.13 seconds;
  no expired leases. Final health: one future queued job, one running job,
  zero overdue queued jobs and zero expired leases.
- All process IDs and restart counters remained stable. Bounded recent log
  tail showed 310 commits and three superseded commits, no error outcome.
  This is not a full-window throughput count.
- No long active application query at final check. The pghoard WAL sender
  was waiting on WalSenderMain.

An additional recent-post-task census exceeded its five-second read-only
statement timeout and was canceled, without retry. This extra diagnostic ran
inside the observation window and may have contributed load; do not treat the
window as a controlled benchmark. Main monitoring completed without errors.

## Largest statements by aggregate execution

| Statement | Calls | Execution seconds |
|---|---:|---:|
| Batched overlapping step-sample range lookup | 378 | 12.58 |
| Race queue insertion/upsert | 827 | 10.29 |
| Combined post-task completion/receipt | 895 | 9.03 |
| Post-task insertion | 888 | 7.89 |
| Scoring-input version insertion/upsert | 167 | 7.24 |
| Notification schedule repair candidate lookup | 1 | 6.94 |
| Post-task claim | 1,548 | 6.80 |

The top step-range lookup is in src/modules/steps/models/stepSample.js. Its
378 calls average approximately 33.3 ms. Next investigation should inspect
its query plan and repeated overlapping ranges, alongside queue bookkeeping.
No single measured statement accounts for most aggregate execution time.

Evidence: /tmp/post-task-deploy.log, /tmp/post-task-cpu-5min.jsonl,
/tmp/post-task-queries-5min.jsonl, /tmp/post-task-5min-analysis.json,
/tmp/post-task-health-start.jsonl, /tmp/post-task-health-final.jsonl.
