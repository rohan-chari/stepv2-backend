# Capacity bottleneck optimization plan — 2026-08-17

## Status and scope

This document is the durable record of the 2026-08-17 single-worker staging
capacity investigation. It records measured evidence, separates confirmed
bottlenecks from hypotheses, and orders the next optimizations so each change
can be measured independently.

> **Historical harness notice:** The frontend production-mix harness and
> commands discussed in this investigation were retired in 2026-08. They are
> retained here only to explain the dated evidence and must not be used as the
> current capacity workflow. See the frontend repository's `k6/README.md` for
> the supported smoke/find/confirm/soak workflow. Results from the replacement
> profile are not directly comparable to this historical profile.

No result in this document authorizes a production deploy or production data
change. Production requires explicit, in-the-moment approval. Every proposed
backend change must preserve the behavior expected by frozen older clients.

Tested revisions:

- Backend staging checkout: `f86dd81`
- Frontend checkout: `17ca1a8`, plus uncommitted k6 harness corrections
- Topology: one staging PM2 worker; production remained at two workers, with
  cron ownership on production instance 0
- Staging PgBouncer pool: temporarily 20 during measured load; verified restored
  to 3 after testing

Operational note after the measurement: the six already-implemented performance
switches were subsequently enabled in production under separate owner approval.
Production remained at exactly two healthy workers, and cron ownership remained on
instance 0. That rollout is not evidence of a higher DAU ceiling and does not
authorize any proposed code change below.

## Capacity conversion

The old k6 scenario names (`dau_1250`, `dau_2500`, and so on) are stale and
must not be quoted as current DAU capacity. Production traffic measured on
2026-08-17 was:

- 495 DAU
- 280,554 app requests per day
- 566.8 requests per DAU per day
- 3.25 mean requests/second
- 12.82 requests/second in the organic peak ten-minute bucket
- 0.0259 peak requests/second per DAU

Therefore:

- 15 requests/second is approximately 580 DAU
- 31 requests/second is approximately 1,200 DAU

The conversion makes 15 rps a useful approximate 580-DAU rung and 31 rps a
1,200-DAU rung. It does **not** establish a pool-3 ceiling: these measurements used
the temporary pool of 20 and a harness that still needs the corrections below. A
corrected-harness, one-worker, pool-3 baseline is required before making a capacity
claim. Production is never inferred by applying an exact 2x worker multiplier.

## Harness corrections

The retired production-mix harness had three correctness defects in
race-resolution polling. At the time, they were corrected locally in the
frontend repository's since-deleted `k6/prod-mix-load-test.js`:

1. Idempotency keys are canonical UUIDv4 values accepted by the backend.
2. Resolution polls include the required generation.
3. A resolution poll reuses the token of the user who created that job rather
   than an unrelated randomly selected user.

The harness also advertised `race_participants_paging` while omitting paging
queries used by the real race-detail screen. Progress and bootstrap are corrected
locally; the complete screen-matching set must be:

```text
/races/:id/progress?view=participants-v1&offset=0&limit=15
/races/:id/bootstrap?view=participants-v1&offset=0&limit=15
/races/:id?view=participants-v1&offset=0&limit=15
```

Important limitation: this reduces the serialized participant array and wire
payload, but the current backend still loads and computes much of the full
roster before slicing the result. Paging is therefore not yet a proportional
server-work reduction.

The local harness still omits `offset=0&limit=15` from the standalone details URL;
that remaining correction is required before the next baseline. Threshold tags also
need cleanup: they currently target the stale `dau_5000` tag, so targeted 15/31-rps
runs print meaningless zero-sample threshold results. Resolution jobs are VU-local,
which underweights polling during scale-up, and ACTIVE/PENDING fixture races are not
separated. The exported metrics and CSV describe the completed runs, but these
limitations must be repaired before claiming an optimization delta.

## Measured baseline and switched result

### Earlier clean baseline (temporary pool 20)

| Offered load | Requests | Hard failures | Dropped | p95 | p99 |
|---|---:|---:|---:|---:|---:|
| 15 rps for 90s | 1,351 planned | 0 | 0 | 1.78s | 3.26s |
| 31 rps for 30s | 904 completed | 2 | 27 | 12.85s | 20.62s |

### Staging switches enabled

The following switches were enabled on staging only:

```text
SYNC_V2_INLINE_UPLOADER_RECONCILIATION=false
PLACEMENT_DISTRIBUTED_CLAIM_ENABLED=true
PLACEMENT_INERT_PUSH_SUPPRESSION_ENABLED=true
PLACEMENT_LEAN_BASELINE_WRITES_ENABLED=true
STEP_SYNC_BULK_ENABLED=true
APNS_SESSION_REUSE_ENABLED=true
```

Runtime logs confirmed all five performance flags as active. Sync-v2's
deferred reconciliation mode is already covered by a real-HTTP/real-Postgres
integration test and preserves the existing response shape.

### Partially corrected-harness switched result (temporary pool 20)

| Offered load | Completed | Hard failures | Dropped | p95 | p99/max |
|---|---:|---:|---:|---:|---:|
| 15 rps for 90s | 1,351 (15.003/s) | 0 | 0 | 3.40s | 11.17s max |
| 31 rps for 30s | 882 (23.17/s effective) | 1 timeout | 49 | 14.23s | 29.96s max |

The generic k6 `http_req_failed` values are not capacity failures by
themselves. They include the expected legacy `/challenges/current` 404s and two
participant-access 403s. The custom hard-failure metric counts status 0 and
5xx responses.

The switched run did not prove a DAU capacity improvement. Placement work
became dramatically cheaper, but step writes, resolution churn, and full-roster
read computation consumed the released capacity.

## Six optimization workstreams

### 1. Placement baseline persistence

#### Evidence

- Legacy sampled placement recompute: 107 seconds for 79 races and 1,550
  accepted participants.
- First optimized no-change tick: 1.58 seconds.
- Optimized tick during the 15-rps run: 4.74 seconds, with 667 baseline
  proposals, 667 CAS wins, and 667 emitted events.
- That write-heavy tick coincided with the largest 15-rps latency wave.

#### Plan

Keep the existing optimized switches enabled on staging. If repeated tests confirm
that changed baselines still starve HTTP, add a closed `PLACEMENT_BASELINE` queue
reason: the cron enqueues only race ID plus reason. After claim, the fenced
race-resolution worker recomputes proposals from current persisted standings and,
as the sole bulk writer, performs a deterministic, chunked compare-and-set update in
its lease transaction. The cron must not carry ephemeral proposals or directly
bulk-write participant rows. Emit placement events post-commit only for returned CAS
winners and in proposal order.

Tests must prove first-observation suppression, muted participants, lost CAS
races, exact event parity, team-race behavior, and old-client notification
semantics through the real database path.

#### Gate

- Normal tick under 2 seconds when nothing changed.
- A 600+ baseline-change tick under 3 seconds without raising HTTP p95 above
  the 2-second target.
- No duplicate or missing placement events.

### 2. Legacy step reconciliation

#### Evidence

Active-race membership on the cloned production dataset:

- mean: 2.52 active races per user
- median: 2
- p95: 5
- maximum: 16

`/steps` and `/steps/samples` preserve same-request box/powerup freshness for
frozen clients by running uploader-only reconciliation inline. That reconciler
loops over races sequentially and repeatedly loads steps, samples, events,
effects, totals, and box state.

At 31 rps:

- `/steps/samples` p50 14.12s, p95 28.81s
- `/steps` p50 14.58s, p95 25.75s
- sync-v2, which can safely defer, was materially cheaper: p50 6.52s, p95 7.53s

#### Plan

Do not make legacy endpoints enqueue-only; that would change frozen-client box
behavior. Instead:

1. Instrument reconciliation phases and query counts per user/race.
2. Batch user step/sample reads across compatible race windows and timezones.
3. Reuse immutable inputs such as active global events across races whose
   windows overlap.
4. Batch only steps/samples. First idempotently create an absent scoring-input
   version row, then lock and validate it in the same transaction as membership and
   participant write; keep effects/Hitchhike just-in-time. `withRaceResolutionLock`
   is intentionally a passthrough;
   there is no established per-race lock boundary, and the removed pooled-connection
   advisory lock must not be re-enabled.
5. Preserve the existing reason-aware reuse of reconciled races for enqueue. Do not
   add a second optimization for an active-race lookup that this path already avoids.

#### Gate

- Exact HTTP response and same-request box parity for old clients.
- Query count grows by unique scoring window, not blindly by active-race count.
- `/steps` and `/steps/samples` p95 below 2 seconds at 15 rps.

### 3. Resolution enqueue and generation churn

#### Evidence

- `INSERT INTO race_resolution_jobs_v2 ... ON CONFLICT` remained about 26% of
  sampled active SQL after earlier batching and cap-guard improvements.
- Queue generations on the clone reached 133,646 for a 500-person weekly race,
  46,069 for a 50-person race, and 40,492 for the current daily challenge.
- The 31-rps run produced 21.2 seconds of resolution queue lag.
- Existing documentation identifies the remaining no-op/queued-generation
  suppression as section 3.4 of
  `docs/resolution-enqueue-cost-requirements.md`.

#### Plan

Reuse a generation only when the conflict-locked row is QUEUED, has no live lease,
and `processing_generation IS NULL OR processing_generation < generation`. Merge
new dirty scope atomically in that update. A failed claimed generation returned to
QUEUED has `processing_generation = generation` and must bump, as must RUNNING or
SUCCEEDED work, so the fence observes the new write and schedules another pass.

Also benchmark fast containment branches for already-present triggered users,
dirty reasons, participant IDs, and powerup types before attempting a broader
SQL rewrite. Do not retry the previously rejected guard-hoisting experiment.

#### Gate

- Real-Postgres integration coverage for queued merge, concurrent claim,
  running merge, succeeded requeue, malformed scope, and generation polling.
- Lock acquisition remains stable ascending race-ID order.
- Enqueue falls below 25% of sampled active SQL.
- Resolution lag remains below 5 seconds at 31 offered rps.

### 4. Race progress/bootstrap full-roster work

#### Evidence

The real Flutter screen requests 15 participants, but `getRaceProgress` first
loads a fat `Race.findById` graph, computes participant state, builds the full
result, and slices `result.participants` late. The ACTIVE bootstrap path reuses
that same fat preload for details. This saves a duplicate fat read, but it
means pagination primarily reduces response bytes rather than database and CPU
work.

At 31 rps with the corrected 15-person query:

- race progress p50 7.00s, p95 12.89s
- bootstrap p50 7.87s, p95 7.99s (only five samples)
- race list p50 10.23s, p95 11.35s

#### Plan

Build a two-phase read for paging-capable clients, initially on the
Redis-standings-enabled path:

1. Load the complete lean scoring/ranking projection required for correctness.
2. Compute authoritative totals and rank across every accepted participant.
3. Select the requested 15 participant IDs only after ranking.
4. Remove presentation from a versioned shared standings snapshot, and hydrate
   cosmetics, presentation relations, and page-only display fields for
   those 15 IDs, plus the viewer when needed.
5. Let bootstrap and details consume the same lean summary and hydrated page
   instead of treating the progress fat graph as a sunk cost.
6. Keep the existing full-payload path byte-compatible for clients that omit
   the capability or paging query.

#### Gate

- Byte-parity for all non-participant fields.
- Identical rank/tie, team, stealth, powerup, and viewer results.
- Old clients still receive the complete participant array.
- Query count and hydrated relation rows are bounded by page size, while lean
  scoring input remains complete.
- Bootstrap response size and p95 materially decline on 500-person races.

### 5. Social/message cache cold-miss behavior

#### Evidence

Redis and the message/friends/presentation generation-guard flags are enabled.
The presentation cache performs one batched initial MGET, but on a miss it
reads each generation marker sequentially inside a WATCH callback. Concurrent
cold misses can each query the same Postgres presentation rows and only race at
installation time; there is no read singleflight.

At 31 rps:

- race messages p50 5.83s, p95 6.71s
- message streams p50 3.28s, p95 5.01s

These durations include global server queueing and do not by themselves prove
Redis is the primary cause. Phase-level cache measurements are required first.

#### Plan

1. Add hit/miss/load/install timing and requested/missed ID counts.
2. Batch generation-marker reads on the dedicated watched connection.
3. Add bounded per-process singleflight for identical presentation loads.
4. Preserve the invariant that any Redis uncertainty falls back to Postgres.

A distributed rebuild lock is excluded pending its own reviewed key/TTL/wait/failure
contract.

#### Gate

- Cache hit output remains byte-identical to the live Postgres path.
- Mutation during rebuild cannot install stale presentation.
- Cold-load Postgres calls collapse under concurrent identical reads.
- Warm message-stream p95 below 500 ms at 15 rps.

### 6. Background/web isolation and load shedding

#### Evidence

The conservative staging test intentionally uses one PM2 process. Instance 0
serves HTTP and runs all schedulers. At 31 rps, k6 expanded to 173 VUs, completed
only 23.17 requests/second, dropped 49 scheduled arrivals, and took about eight
seconds after offered load stopped to drain. Staging RSS reached about 451 MB;
the shared host fell to 183 MB available until staging was gracefully reloaded.

The database was not broadly saturated in earlier sampling; connection-pool
increases moved the wall but did not eliminate it. Raising pools further is not
an optimization.

#### Plan

First complete workstreams 1-5 while retaining the conservative one-worker
topology. If an optimized cron tick still causes interactive latency waves,
design a separate cron process/droplet and web-only workers. That is an
infrastructure scaling phase and must be benchmarked separately; it cannot be
presented as an improvement to one-worker code capacity.

Add explicit overload protection only after endpoint budgets are known:
bounded queue depth, clear 429/Retry-After behavior for safe retryable reads,
and preservation of mutation/idempotency semantics. Do not turn slow durable
writes into ambiguous client failures.

#### Gate

- No production health impact during staging tests on shared hardware.
- At least 300 MB host memory headroom throughout the conservative run.
- No OOM, PM2 restart, deadlock, or pool timeout.
- A separate-topology result is labeled infrastructure capacity, never mixed
  into the single-worker DAU number.

## Ordered implementation sequence

The cross-repo source of truth for implementation order, compatibility, tests, and
approval gates is now
`stepv2-frontend/docs/capacity-bottleneck-optimization-requirements.md`. In summary:

1. Commit the harness correctness and 15-person paging corrections; fix
   threshold tags and add endpoint/status summary output.
2. Add phase measurements for legacy reconciliation, progress/bootstrap, and
   presentation cache misses. Run a clean 15-rps diagnostic without intrusive
   hot-SQL polling.
3. Implement the two-phase paged progress/bootstrap projection.
4. Implement fenced worker-owned placement baseline batches if another
   changed-baseline tick reproduces the HTTP latency wave.
5. Implement the queued-generation merge optimization with integration tests
   and architecture/code review.
6. Implement legacy reconciliation read reuse/batching without changing
   same-request box behavior.
7. Implement cache/access work only if phase evidence still
   attributes material time to cold misses.
8. Re-run the exact protocol after each independently attributable change:
   15 rps for 90 seconds, then 31 rps for 30 seconds only when 15 rps is clean.

Do not bundle these code changes into one benchmark. A faster final number with
six simultaneous changes would not establish which invariant-risking change
provided value.

## Acceptance criteria for a higher DAU claim

A DAU ceiling is raised only when the corresponding arrival rate passes all of
the following on the production-cloned staging dataset:

- hard failures below 1%, preferably zero at the conservative rung
- zero dropped arrivals
- overall p95 below 2 seconds and p99 below 5 seconds
- no completed endpoint critical to step persistence at or above 15 seconds
- resolution queue lag below 5 seconds and returned to zero before the next
  rung
- no new P2028, deadlock, uniqueness, pool-timeout, or ambiguous write errors
- placement and notification parity tests green
- production remains exactly two healthy workers during shared-host testing
- staging pool and process topology restored after testing

Until the corrected harness is rerun at pool 3, this investigation makes no
validated one-worker DAU-capacity claim. Once established, any higher claim still
requires the corresponding rung to satisfy every gate above.
