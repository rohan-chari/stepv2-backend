# Database CPU workload attribution — September 7, 2026 EDT

Read-only investigation after production commit 441f307. No production config,
application, queue capacity, data, or service changes in this investigation.
Both finite collectors completed and disconnected.

## Main finding

The leading mechanism is repeated **display refresh / repair work escalating to
full race resolution**, not one isolated dominant SQL statement.

In the matching 02:07:46–02:12:52 UTC log window, the resolution worker recorded
1,052 attempts. 767 used FULL resolution. 765 included DISPLAY_REFRESH among
possibly multiple reasons. **700 attempts had only DISPLAY_REFRESH, used FULL,
and recorded zero participant writes** (66.5% of all attempts). This does not
mean all side effects were absent, or that all 700 originated directly in HTTP:
display refresh also has repair and refresh-intent producers. Overall outcomes:
1,030 commit, 3 superseded_commit, 19 superseded_discard.

The code provides a concrete causal path:

1. `raceProgressSnapshot.js:51` sets a 15-second soft freshness limit.
2. `getRaceProgress.js:2320` serves a stale snapshot and requests worker refresh;
   `requestWorkerRefresh` at line 348 enqueues DISPLAY_REFRESH without an output
   artifact reference.
3. `raceResolutionQueueV2.js:1655` can reuse an output artifact only when a
   processingDisplayArtifactId exists. The FULL fallback replays race resolution.
4. This still runs reads, queue transitions, transactions and post-task handling
   even when it ultimately produces no participant changes. `changedRows` at
   line 2950 counts distinct participant write IDs, not all database mutations.

This is strong evidence of repeated work worth isolating. It is not a measured
percentage of CPU saved by eliminating it. Time-dependent effects and stale
state repair require correctness guards; simply extending TTL or dropping all
display-refresh jobs would not be justified.

## Synchronized evidence

31 managed-host metric samples over roughly five minutes averaged:

| CPU mode | Percent |
|---|---:|
| Idle | 4.69 |
| User | 61.67 |
| System | 23.85 |
| Hardware + software interrupts | 5.77 |
| Steal | 3.61 |
| IO wait | 0.40 |

Thus host non-idle averaged 95.31%. PgBouncer process CPU averaged 7.73%, already
included in the above host total. Process metrics do not expose PostgreSQL
backend PID CPU. Steal is external scheduling pressure, not SQL work.

The 302.37-second statement interval recorded 110,267 calls (~365/s). Matching
Nginx access logs recorded 3,033 requests, including 203 POST /steps/sync-v2 and
860 GET /races requests. These are traffic context, not a direct attribution of
every background query to an individual HTTP request. Access logs were reduced
to route-category counts; no IP addresses or raw user paths were retained.

Of 402 application-process active/no-reported-wait session observations:
198 were resolution, 87 cron, and 117 HTTP. Background workers therefore accounted
for 71% of those samples. This is **not 71% of CPU**: runnable sessions can be
waiting for the single CPU, and planning is not timed by pg_stat_statements.

## Workload groups

Table-name classification is mutually exclusive and approximate for cross-table
SQL; source tracing above supplies the specific display-refresh mechanism.
Elapsed totals can overlap between sessions and include waits.

| Group | SQL calls | Execution elapsed seconds |
|---|---:|---:|
| Durable step snapshots | 32,402 | 43.86 |
| Race queue / placement coordination | 15,899 | 35.85 |
| Race post-processing | 10,166 | 36.63 |
| Global events | 11,130 | 35.40 |
| Race state / scoring | 18,155 | 63.76 |
| Step intake / history | 2,384 | 45.73 |
| Notifications / outbox | 3,811 | 31.26 |
| User / app reads | 7,175 | 11.64 |
| Other | 8,866 | 3.21 |

Examples of repeated coordination:

- Materialization selection ran 3,755 times and returned 897 unprepared roots.
  `durableScoringMethod.js:72` asks materializeFactRoots for one root on each
  scoring-page iteration; `durableCaptureFacts.js:76` checks preparation and
  then separately reloads root status. Repeated checks need to be distinguished
  from actual materialization before optimizing.
- Post-task failure/pending checks and terminal receipts ran 1,016 times.
- Race job insertion ran 932 times; job claiming ran 1,983 times.
- Table counters show 4,669 race-job updates, 4,792 post-task updates, 3,913
  capture-root updates, and 2,827 scoring-progress updates.

No single statement accounts for most elapsed execution. The top selected-root
statement used 16.80 seconds elapsed. The underlying fan-out is the better
investigation target than another isolated query rewrite.

## Limits and checks

All SQL probes used explicit BEGIN READ ONLY with five-second statement limits.
The role can read all session statistics. Planning, function and IO timing are
disabled; pg_stat_kcache and pg_wait_sampling are unavailable in the exposed
extension list. Current tools therefore cannot directly assign CPU time per query.

Stats reset time and deallocation count (47) did not change. Deltas use
(dbid, userid, toplevel, queryid) and check stats_since. Six collector-created
entries born during initial snapshot assembly were excluded from workload deltas.
Monitoring itself accounted for 9.85 seconds execution elapsed, including 8.72s
across 18 interval statement scans. Future interval collection should use
pg_stat_statements(false) or less frequent scans to avoid reading stored SQL text.

There were 424 total active/no-wait observations; 49 had no attributable SQL
text/query ID and were retained as unknown. Application waits are restricted to
client backends; sleeping background workers are not included in that denominator.
Autovacuum and autoanalyze completed elapsed increments were 3.29s and 15.10s;
these are not CPU counters and do not establish them as the primary problem.

Required read-only reviewer validated the collector limitations, counter handling,
and the display-refresh source path. No fixes or deployments were attempted.

## Next discriminating test

Reproduce repeated race-progress reads with unchanged steps and a fixed interval
that crosses the snapshot freshness deadline. Measure FULL attempts, participant
writes, snapshot correctness, SQL volume and local PostgreSQL CPU. Include real
step changes, effect/event boundaries, race end and repair cases. Then evaluate
an input/version-and-boundary-based refresh path that avoids full scoring when
only presentation needs refreshing. Do not infer a production CPU saving from
job counts alone; a controlled production comparison would require approval.

Evidence: /tmp/db-attribution.jsonl, /tmp/db-attribution-metrics.jsonl,
/tmp/db-attribution-analysis.json, /tmp/db-attribution-worker-cross.json.
Collector and analysis sources: /tmp/db-attribution.js,
/tmp/db-attribution-metrics.py, /tmp/analyze-db-attribution.py,
/tmp/db-attribution-worker-cross.py, /tmp/db-attribution-http.py.

References: [PostgreSQL activity/statistics semantics](https://www.postgresql.org/docs/18/monitoring-stats.html),
[Statement planning and execution statistics](https://www.postgresql.org/docs/18/pgstatstatements.html).
