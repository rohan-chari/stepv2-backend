# Scoring-state lock production verification — 2026-09-07 EDT

Deployed 167276e11ecc99b40b7c4f07f4a1c7ea46714cef after fresh approval using
the serialized PM2 safe reload wrapper. No migration or dependency changes.
Preserved production package-lock checksum. Two HTTP workers, one cron worker,
one resolution worker; staging stopped; concurrency 3; aggregate pool budget32.
Referral ledger audit: both missing counts zero. Public/local API and Redis
health passed; migration census239 with zero unfinished.

Waited for startup recovery before monitoring. Queue briefly had40 due jobs,
oldest67 seconds. Before monitoring, worker had97 commits and only three due
jobs, oldest5.74 seconds.

## Five-minute observation

Statement window 2026-09-08 00:33:58–00:39:02 UTC (20:33–20:39 EDT Sept7),
303.896 seconds. Eleven managed-DB CPU samples approximately30 seconds apart.
Both finite monitors exited successfully and stopped.

- Mean CPU idle11.71%, non-idle88.29%, versus prior idle14.76%.
  The70% idle goal remains unmet. No total CPU benefit demonstrated.
- CPU user54.30%, system21.34%, steal6.86%, iowait0.37%; remaining non-idle
  categories include IRQ/softIRQ/nice. Non-idle is not all SQL execution CPU.
- 72,773 tracked statements (239.47/s), versus81,879 previously.
  Aggregate query execution221.98 seconds versus259.75 seconds previously.
- New scoring-state lock query:167 calls,5.780 seconds,34.61ms/call.
  Previous unconditional-upsert query:174 calls,9.554 seconds,54.91ms/call.
  Old query had no calls in this window. The observed reduction cannot all be
  attributed to the release because these are uncontrolled traffic windows.
- Post-task completions934 versus928 previously, a similar count of work.
- Sampled queued count0–12, oldest queued request6.61 seconds; no expired leases.
  Final health00:39:20 had no queued/running rows at that instant; subsequent
  verification saw three newly queued jobs. PIDs/restart counters unchanged.
- Bounded recent logs:313 commits,2 superseded commits, no error outcome in
  that tail. This is not a full-window throughput count.
- No long application query at final check. The old pghoard WAL sender was
  waiting on WalSenderMain.

## Largest execution totals

| Query | Calls | Seconds |
|---|---:|---:|
| Queue insertion/upsert |894|10.67|
| Post-task completion/receipt |934|8.92|
| Durable capture compaction check |898|6.48|
| Post-task claim |1622|6.39|
| Scoring-state lock |167|5.78|
| Fingerprint event/schedule lookup |439|5.76|

No single query dominates aggregate execution. Query execution elapsed time
includes waits, and planning is untracked. Falling SQL execution totals alongside
persistently high CPU do not establish a cause; investigate total statement
frequency, planning and background database activity rather than promising that
another small SQL change will reach70% idle.

Evidence: /tmp/scoring-lock-deploy.log, /tmp/scoring-lock-cpu-5min.jsonl,
/tmp/scoring-lock-queries-5min.jsonl, /tmp/scoring-lock-5min-analysis.json,
/tmp/scoring-lock-health-start.jsonl, /tmp/scoring-lock-health-final.jsonl.
