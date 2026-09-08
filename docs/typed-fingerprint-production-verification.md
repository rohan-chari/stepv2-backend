# Typed fingerprint production verification — 2026-09-07

Deployed `0feb327cbc0042bbeb3d45e6a9fb9e39d28a4d0b` following explicit user
approval, using the serialized safe PM2 reload wrapper. Main advanced from
ba58dd4. No migration or dependency changes; the pre-existing production
package-lock modification retained its checksum. Exactly two HTTP workers,
one resolution worker, one cron worker, staging stopped, concurrency 3,
aggregate pool budget 32. HTTP/Redis health passed; referral catch-up dry-run
reported zero missing records. Read-only migration census: 239, zero unfinished.

Waited for startup handoff and backlog recovery before monitoring: the queue
briefly reached 60 during startup, then had no due jobs at 23:15:17 UTC and
logged 141 commits. This startup period is excluded from the five-minute CPU
window below.

## Five-minute observation

Window approximately 23:15:33–23:20:35 UTC (19:15–19:20 EDT), 302.005 seconds
between statement snapshots. Eleven CPU samples roughly 30 seconds apart.
Both monitors exited successfully and stopped; no monitor errors.

- Average managed-database CPU idle **16.11%**, non-idle **83.89%**.
- Idle samples ranged approximately 4.4–24.1%. The 70% idle target is not met.
- 71,127 tracked statements, 235.5/s, aggregate execution 179.23 seconds.
- 1,001 race jobs claimed versus 692 in the previous 301.874-second window:
  about 45% more claimed work. Statements increased about 20% (59,294 prior).
  Claims are not a complete committed-throughput measure, and the older window
  included startup. These are uncontrolled workload comparisons.
- Presentation-bearing typed fingerprint: 380 calls, 14,390 returned participant
  rows, total execution 3.820 seconds, **10.05 ms/call**.
- Previous presentation JSON fingerprint: 385 calls, 7.972 seconds,
  **20.7 ms/call**. Approximate 51% reduction in observed mean query execution;
  roster mix and host contention differ between windows, so not a controlled
  CPU saving claim. The old presentation JSON query had no calls in this window.
- Scoring-only typed fingerprint: 12 calls, 279 rows, 44.1 ms total.
- Sampled queued count 0–4, oldest requested age at most 5.82 seconds, no expired
  running leases. Final health check 23:21:37: three future queued jobs, zero due
  jobs, no expired leases. Same process IDs and restart counters as post-deploy.
- Recent bounded log tail: 309 commits, 2 superseded commits, no error outcome
  in that tail. This is not a full-window completion count.
- No long active application query at final check. The older pghoard WAL sender
  was waiting on WalSenderMain, not executing a long application statement.

## Remaining largest statements by aggregate execution

| Statement | Calls | Execution seconds |
|---|---:|---:|
| Race queue insertion/upsert | 935 | 7.05 |
| Post-task snapshot completion update | 1,002 | 6.35 |
| Post-task claim | 1,594 | 6.00 |
| Post-task finish/receipt checks | 1,002 | 5.67 |
| Post-task insertion | 1,000 | 5.28 |
| Fingerprint event/schedule lookup | 392 | 4.77 |
| Race queue claim | 2,219 | 4.58 |
| Typed presentation fingerprint | 380 | 3.82 |

Queue/post-task bookkeeping is the next investigation candidate. Execution
elapsed time is not per-query CPU attribution and includes waits; planning is
not tracked. The fingerprint query cost improved while total node idle did not.
Do not attribute the worse overall idle percentage solely to this release, or
claim a hardware ceiling, from these differing workload windows.

Evidence: `/tmp/typed-fingerprint-cpu-5min.jsonl`,
`/tmp/typed-fingerprint-queries-5min.jsonl`,
`/tmp/typed-fingerprint-5min-analysis.json`,
`/tmp/typed-fingerprint-deploy.log`,
`/tmp/typed-fingerprint-health-final.jsonl`.
