# Empty sample cache deployment verification — 2026-09-07 EDT

Deployed 040e29ff7b86f996947aacd86f4522e7761ed2c3 after fresh approval,
using the safe serialized PM2 reload. No migrations or dependency changes.
Preserved the existing production package-lock modification. Two HTTP workers,
one cron worker, one resolution worker; staging stopped; concurrency 3 and
aggregate pool budget 32. Referral catch-up audit reported both missing counts
zero. Local/public health and Redis passed. Migration census: 239, no unfinished.

Waited for startup backlog recovery before measuring. The queue briefly had
16 due jobs with oldest requested age 76 seconds during startup. The worker
then logged 38 commits and the queue dropped to one job before monitoring.

## Five-minute observation

Window approximately 00:00:41–00:05:44 UTC September 8 (20:00–20:05 EDT
September 7), 302.875 seconds between statement snapshots. Eleven managed-DB
CPU samples approximately 30 seconds apart. Both monitors finished successfully
and stopped.

- Mean CPU idle **14.76%**, non-idle **85.24%**, versus 15.75% idle previously.
  No meaningful total CPU improvement demonstrated; the 70% idle target is unmet.
- 81,879 tracked statements, approximately 270.3/s, versus 68,263 previously.
  Aggregate execution time 259.75 seconds versus 272.51 seconds previously.
- Sample lookup: **241 calls / 6.55 seconds**, versus **378 / 12.58 seconds**.
  Returned rows 105,602 versus 121,519. Mean execution 27.2 ms versus 33.3 ms.
  These mixed-workload windows cannot attribute the entire reduction to caching.
- Post-task insertion count 928 versus 888: overall race work did not decline
  in the same proportion as sample reads. This is still not a controlled test.
- No expired leases in queue samples. Final health at 00:06:26 UTC showed two
  future queued jobs and zero due jobs. All process IDs and restart counters
  remained stable. Bounded recent log tail: 308 commits, two superseded commits,
  no error outcome; not a full-window completion count.
- No long-running application query at the final check. The pghoard WAL sender
  was waiting on WalSenderMain.

## Leading queries by aggregate execution

| Query | Calls | Seconds |
|---|---:|---:|
| Race queue insertion/upsert | 885 | 10.11 |
| Scoring-input version insertion/upsert | 174 | 9.55 |
| Post-task completion/receipt | 928 | 9.02 |
| Fingerprint event/schedule lookup | 445 | 6.83 |
| Batched step-sample lookup | 241 | 6.55 |
| Post-task claim | 1,587 | 6.19 |

No individual query dominates the measured execution total. Execution elapsed
time includes waits and is not SQL CPU attribution; planning remains untracked.
Next investigation should examine queue insertion and scoring-input version
locking/upserts, including repeated calls and contention. Do not assume another
small query optimization alone can deliver 70% idle.

Evidence: /tmp/empty-samples-deploy.log, /tmp/empty-samples-cpu-5min.jsonl,
/tmp/empty-samples-queries-5min.jsonl, /tmp/empty-samples-5min-analysis.json,
/tmp/empty-samples-health-start.jsonl, /tmp/empty-samples-health-final.jsonl.
