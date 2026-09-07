# Empty claim optimization: production verification

Deployed `ba58dd4f13f371d8d377d65d6a2a62287f1cd7d3` on 2026-09-07 using
`pm2-safe-prod-reload.sh`, following explicit user approval. No migration or
dependency changes. The pre-existing production package-lock modification was
preserved. HTTP health and Redis passed; exactly two HTTP workers, one cron,
one resolution worker, staging stopped, concurrency 3 and pool budget 32.
No additional restarts appeared during observation. Referral catch-up dry-run
reported zero missing activities and review ownership rows.

The legacy migration-check script expects PROD_DATABASE_URL and failed before
connecting; a bounded read-only fallback verified 239 migration records and
zero unfinished migrations. No schema changes were attempted.

## Five-minute observation

2026-09-07 22:43:46–22:48:49 UTC (18:43–18:48 EDT). Both monitors exited
successfully after their bounded window. Eleven managed database CPU samples,
roughly 30 seconds apart; SQL deltas span 301.874 seconds. No stats reset.

- Mean idle: **32.45%**; mean non-idle: **67.55%**.
- Idle range: 8.31–62.40%.
- After omitting the first three startup-affected samples: mean idle **23.38%**.
  The full-window figure overstates steady processing headroom. The prior
  diagnostic window averaged 24.58% idle. No sustained CPU improvement proven.
- Mean user CPU 43.41%, system 16.92%, steal 2.76%, I/O wait 0.55%.
- 59,294 tracked statements, 196.4/s; aggregate execution 143.70 seconds.
  Execution duration is not CPU attribution. Only entries present in both
  snapshots with matching statistics identity are included.
- Race claims: 1,657 calls / 692 returned jobs = **2.39 calls/job**, versus
  1,438 / 296 = **4.86 calls/job** in the prior observation (~50.7% lower).
  Empty fraction fell from 79.4% to 58.2%. Windows have different workloads;
  this is operational evidence, not a controlled CPU experiment.
- Claimed jobs averaged 2.29/s versus 2.41/s in the prior window, including the
  new window's startup handoff. Claimed rows are not proof of completed jobs.
- Queue briefly reached 39 during startup; thereafter sampled 0–7 queued, with
  oldest requested age under 3.4 seconds after recovery and no expired leases.
- Final health check 22:49:35 UTC: no queued/running races, unchanged PIDs,
  logged recent outcomes 310 commits and 1 superseded discard. Log counts are
  bounded-tail observations, not complete throughput counters.
- No long active application queries at final check. The old pghoard WAL sender
  was waiting on WalSenderMain; its connection age is not CPU execution time.

## Largest remaining statements by aggregate execution

| Query | Calls | Returned/affected rows | Execution seconds |
|---|---:|---:|---:|
| Race/participant fingerprint JSON (`1971792614491423347`) | 385 | 385 | 7.97 |
| Step sample range reads (`8055839263049160421`) | 177 | 90,421 | 7.42 |
| Fingerprint event/schedule lookup (`-5241993135095131194`) | 396 | 18,754 | 4.77 |
| Post-task claims (`1321273642760109324`) | 1,226 | 691 | 4.43 |
| Notification schedule cleanup (`-3019060856448485391`) | 1 | 0 | 3.70 |

Next optimization focus remains fingerprint assembly and its event/input
lookups, followed by step range volume and post-task bookkeeping. A single
3.7-second cleanup also merits inspection but does not explain sustained load.
The 70% idle target has not been achieved; do not infer CPU shares from this
execution-time table or increase concurrency based on lower claim overhead.

Evidence files: `/tmp/empty-claims-cpu-5min.jsonl`,
`/tmp/empty-claims-queries-5min.jsonl`, `/tmp/empty-claims-5min-analysis.json`,
`/tmp/empty-claims-health-final.jsonl`, `/tmp/empty-claims-deploy.log`.
