# Managed database CPU investigation — 2026-09-07

Target: average 70% idle CPU on the managed PostgreSQL node under comparable
traffic. This is not yet achieved. No production code/configuration was changed
in this investigation.

## Persistent access

Direct DigitalOcean metrics access is configured in the named remote doctl
context `db-metrics`. Machine-specific access instructions are in both main
repositories' gitignored CLAUDE.local.md. Frontend AGENTS.md and CLAUDE.md now
explicitly point future agents to these notes (commit bfcbb9a). No secrets were
copied into repository instructions or logs.

## Aligned observations

Query window: 2026-09-07 22:17:21–22:19:24 UTC (123 seconds). Five managed-node
CPU scrapes were taken approximately every 30 seconds over the same period.

- CPU idle: 24.58% mean; non-idle: 75.42%.
- User CPU: 46.47%; system CPU: 19.16%; I/O wait: 0.61%; steal: 4.81%.
- PgBouncer process CPU: 5.06% mean. This is a process attribution and overlaps
  node CPU categories; do not add it to user/system usage.
- 21,453 tracked statement completions (~174/s), 37.69 seconds aggregate
  execution time. Deltas omit new/reset entries whose interval is ambiguous.
- Active/no-wait client samples: resolution 24, cron 17, HTTP 2. This is sampled
  activity, not a per-role CPU percentage.
- No claim that CPU user time equals SQL execution time: execution includes
  waits, planning is untracked, and the node includes OS/pool/maintenance work.

## Concrete avoidable-work candidates

| Operation | Calls | Rows returned/affected | Recorded execution |
|---|---:|---:|---:|
| Race queue claim (at most one job/call) | 1,438 | 296 | ~2.2 s |
| Post-task queue claim (at most one task/call) | 562 | 297 | ~2.1 s |
| Presentation-bearing race input fingerprint | 115 | 115 | ~2.3 s |
| Step sample ranges | 49 | 18,902 | ~1.5 s |
| Snapshot completion update | 297 | 297 | ~1.5 s |
| Post-task finish/receipt statement | 297 | 297 | ~1.2 s |
| Post-task insertion | 297 | 297 | ~1.2 s |

Race claim probes were 79.4% empty; post-task claim probes were 47.2% empty.
Eliminating these probes alone cannot be assumed to meet the idle target:
recorded execution is only part of their cost and only a small part of total
node non-idle time.

A bounded SELECT-only EXPLAIN ANALYZE check on three current races, twice each,
measured fingerprint planning at 1.17–27.04ms and execution at 0.46–79.14ms, with
zero shared-block reads in all six checks. This establishes material, variable
planning elapsed time in this query, not its aggregate CPU contribution.

## Next experiments, in priority order

1. Reproduce empty claim amplification with the real resolution scheduler and
   real test DB. Evaluate avoiding redundant claim lanes after exhaustion while
   preserving wake delivery, expired lease recovery, concurrency and race lag.
   Measure queries per completed job and latency, not merely faster SQL.
2. Benchmark returning narrow typed race/participant rows and assembling the
   fingerprint payload in the application. Preserve exact digest content,
   ordering, date/number encoding and presentation fields used for closure
   safety. Compare the complete worker path before changing business logic.
3. Profile and reduce post-task bookkeeping round trips where statements can
   be combined without weakening lease fences, receipts or at-most-once
   delivery rules. Existing readiness cache must not be blindly extended.
4. Re-measure actual node CPU, workload rate, job throughput and oldest pending
   age after each approved release. Retain peak/burst measurements; a quieter
   traffic window is not proof of an optimization.

Going from 75.4% non-idle to 30% would require about 60% less non-idle time at the
same capacity and comparable demand. These targets are candidates, not promised
savings. If measurements show useful irreducible workload dominates, report
that and assess capacity separately; do not force 70% idle by starving races or
silently delaying notifications. Any controlled production worker reduction or
new release requires a concrete proposal and explicit authorization.

Evidence: /tmp/idle-target-cpu.jsonl, /tmp/idle-target-queries.jsonl,
/tmp/idle-target-query-deltas.json, /tmp/fingerprint-planning-cost.jsonl.

## First candidate implemented: share an empty claim within a tick

The real entrypoint against an isolated PostgreSQL 18 test database reproduced
three empty claim statements at concurrency 3 during one startup drain. The new
integration assertion failed with `3 !== 1` before changing the worker.

The worker now coordinates only claims within one tick: successful claims release
coordination immediately and their jobs execute concurrently. A miss suppresses
remaining claims in that tick. Every subsequent tick starts fresh; targeted
compatibility requests bypass this coordination. Claim errors still propagate,
and all lanes settle before the scheduler can start another tick.

After the change, the same empty drain issues one statement (67% fewer empty
claim statements for this case). This is not a claim of 67% lower database CPU,
nor a prediction that every production empty probe can be eliminated.

Validation: all three new integration scenarios passed (idle-to-new-HTTP-work,
future deadline and expired lease recovery, and an independently completing race
while another race is row-locked). Both existing 100-participant individual/team
worker integration scenarios passed. All 35 existing queue/concurrency/claiming
cache tests passed. An initial unit invocation lacked DATABASE_URL and failed
before loading tests; rerunning with the isolated test database passed.

No API response shape, race scoring, lease fence, concurrency configuration,
production topology, or schema changes. Old iOS and Android clients continue
through their existing API contracts. Production CPU benefit remains unverified
until deployment and a comparable metrics/query-delta observation window.

Review also identified that queued claims must refresh their lease timestamp. A
deterministic injected-clock regression reproduced the stale timestamp, then
passed after taking the timestamp inside each actual claim. It also verifies
that a claim failure does not poison later lanes and the next tick probes again.

Final verification caveat: after the timestamp fix, the 3 new integration tests
and 36 queue unit tests passed. The existing team-race integration passed. The
individual-race integration passed its worker/result assertions but failed its
separate existing buffer-hit benchmark (`afterHits < beforeHits * 0.5`): the
planner used 12 versus 8 hits rather than the earlier 306 versus 6. Running that
same suite with unchanged deployed HEAD 08fd298 reproduced the identical
assertion failure. No existing assertions were weakened or skipped. This
planner-sensitive benchmark remains unresolved; the whole verification run is
therefore not reported as green. Evidence: /tmp/empty-claims-final.log and
/tmp/empty-claims-baseline-resolution.log.
