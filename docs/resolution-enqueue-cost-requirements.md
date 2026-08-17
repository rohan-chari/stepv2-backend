# Resolution-enqueue cost reduction — requirements

**Status:** proposed, not approved. No code changed.
**Date:** 2026-08-16
**Goal:** support 5,000 DAU (~61 rps) on the current hardware — 2 vCPU droplet,
`db-s-1vcpu-2gb` database. No resize.

**Supersedes `transaction-hold-time-requirements.md`.** That document blamed
transaction hold time. Hold time is real but it is a *symptom*: the transactions
are long because of the statement identified below. Do not implement it.

---

## 1. The finding

One statement is **81% of all database busy time**.

Sampling `pg_stat_activity` 1,229 times during a 61 rps run against staging on
prod-cloned data, counting what was actively executing:

| statement | samples | share |
|---|---|---|
| **`INSERT INTO race_resolution_jobs_v2 … ON CONFLICT (race_id) DO UPDATE`** | **1,001** | **81%** |
| `SELECT … race_participants` (two shapes) | 73 | 6% |
| `SELECT … race_active_effects` | 22 | 2% |
| `SELECT … users` (three shapes) | 34 | 3% |
| `SELECT … user_equipped_accessories` | 21 | 2% |
| everything else combined | 78 | 6% |

Every other query in the system — race reads, participant lookups, step-sample
scans, leaderboard queries — is 19% put together.

A V8 CPU profile of the app worker under the same load (186,273 samples, 84%
busy) agrees from the other side:

| | share of busy CPU |
|---|---|
| Prisma ORM | **34.8%** |
| garbage collector | 16.0% |
| node internals / V8 | 26.6% |
| pg driver | 8.0% |
| **application code (`src/`)** | **7.9%** |
| crypto (JWT verify) | 1.3% |

Application logic is 7.9%. The cost is in *issuing* database work, not in doing
anything with the results.

---

## 2. Why the statement is expensive

`src/modules/races/models/raceResolutionJobV2.js:163` — **7,780 characters,
127 lines**. Three separate problems compound.

### 2.1 The validation guard is written out three times

The `DO UPDATE` sets `dirty_reasons`, `dirty_participant_ids` and
`dirty_powerup_types`, and each one repeats the same ~12-condition guard:

| construct | occurrences in one statement |
|---|---|
| `jsonb_typeof` | 9 |
| `jsonb_array_elements` scans | 8 |
| `jsonb_path_exists` | 6 |
| the 12-reason allowlist literal, re-inlined | 6 |
| `SELECT DISTINCT` subqueries | 4 |

The two cap checks are the worst of it — each is a
`SELECT COUNT(*) FROM (SELECT DISTINCT value FROM jsonb_array_elements(a || b))`
over arrays that may legitimately hold **1,000 participant ids** and **64
powerup types**, and each is evaluated once per column, i.e. three times.

### 2.2 It runs once per race, sequentially, inside a transaction

`enqueueMany` (`raceResolutionJobV2.js:311`) is a `for` loop with `await`
inside it:

```js
for (const raceId of ordered) {
  out.push(await this.enqueue({ raceId, … }, tx));
}
```

Its caller is Transaction B of the step sync
(`recordStepSyncV2.js:189-201`). So one `/steps/sync-v2` from a user in N active
races issues **N sequential round trips of the 7.8 KB statement, with a
transaction held open across all of them**. Median races per active user in the
prod clone is **4**.

This is the direct cause of the `idle in transaction` pileup measured earlier
(13-16 of 21 connections, longest 57.9 s) — the connection is idle between
those round trips but the transaction, and its locks, are not released.

### 2.3 `ON CONFLICT (race_id)` serialises every uploader in the same race

There is one queue row per race by design. Concurrent uploaders in the same race
therefore contend for a single row's lock *while* running the work in 2.1.
That produced the `Lock:transactionid` waits and the 8 observed deadlocks.

### Why this shows up as "Prisma is 34.8% of CPU"

Marshalling a 7.8 KB statement plus its jsonb payloads, N times per sync, is
what the ORM time and most of the 16% GC actually are. Reducing the statement
reduces all three numbers.

---

## 3. Proposed changes

Ordered by payoff-to-risk. Each is independently shippable and independently
measurable — do not batch them, or the attribution is lost.

> **STATUS 2026-08-17: 3.1 is IMPLEMENTED and deployed to STAGING ONLY.**
> Prod still runs the original. 3.2, 3.3 and 3.4 are not started.
> Results in §3.1a below.

### 3.1 Batch `enqueueMany` into ONE statement *(highest payoff)*

Replace the N-round-trip loop with a single multi-row
`INSERT … SELECT … FROM jsonb_to_recordset($1) … ON CONFLICT (race_id) DO UPDATE`.
Turns N sequential round trips into one, and collapses the transaction's open
window correspondingly.

**Invariant to preserve:** `enqueueMany` currently sorts race ids ascending
(`localeCompare`) — that ordering is deadlock avoidance and must survive. A
single multi-row INSERT takes its locks in the order rows are supplied, so the
input must stay sorted. **Verify against
`test/integration/race-queue-v2-single-writer.test.js`.**

**Open question:** `enqueue` returns the upserted row per race and the caller
uses `jobs.find(Boolean)` to report one `jobId` to the client. A batched
statement must still `RETURNING` all rows, and the *same* row must be chosen —
the wire contract for frozen clients reports the lexicographically-first active
race (see the comment at `recordStepSyncV2.js:160-168`).

### 3.1a RESULT of 3.1 — real latency win, primary metric NOT met

Implemented in `src/modules/races/models/raceResolutionJobV2.js`. `enqueue()`
now delegates to `enqueueMany()`, which issues **one** statement expanding a
jsonb array through `jsonb_to_recordset`, with the conflict clause reading each
race's new values from `EXCLUDED` instead of positional parameters.

Measured at 61 rps, staging, **identical conditions both runs** (pool = 3, 1
worker, `PRISMA_QUERY_EVENTS_ENABLED=true` in both):

| | before | after | |
|---|---|---|---|
| avg latency | 11.81 s | **8.09 s** | −32% |
| median latency | 9.48 s | **5.39 s** | −43% |
| p90 | 29.95 s | **17.25 s** | −42% |
| p95 | 30 s | **20.3 s** | −32% |
| 5xx rate | 44.47% | **35.42%** | −20% |
| dropped iterations | 550 | **318** | −42% |
| throughput | 41.2/s | 43.3/s | +5% |
| **enqueue share of DB time** | **81%** | **89%** | **WORSE** |

**Read the last row correctly.** Batching removed round trips and app-side
marshalling — that is where the latency win came from. It did **not** reduce the
per-row jsonb work, which is still three copies of the guard and two
`SELECT DISTINCT` cap checks, now executed in one round trip instead of four.
Other queries got faster (less lock contention), so the enqueue's *relative*
share rose while its absolute cost fell.

**The remaining 89% is what 3.2 and 3.3 target.** Batching was necessary but is
not sufficient; the per-row cost is now the entire problem.

Caveat on absolute numbers: both runs had `PRISMA_QUERY_EVENTS_ENABLED=true`,
which `db.js` states adds hot-path work. The comparison is valid (same flag both
sides) but 8.09 s is inflated versus a clean run.

**Two bugs the integration tests caught before deploy** — both would have
corrupted data silently, and both are easy to reintroduce:

1. **Double JSON encoding.** The per-race values were `JSON.stringify`'d
   individually *and* the whole payload stringified again, so
   `jsonb_to_recordset` saw a jsonb **string** `"[\"uuid\"]"` where an **array**
   was intended. Caught by the `triggered_by_user_ids` union assertion in
   `race-queue-v2-single-writer.test.js`. Pass real arrays; the payload is
   serialised once at the call.
2. **`timestamptz` on tz-naive columns.** `not_before_at`, `requested_at` and
   `created_at` are `timestamp WITHOUT time zone`. Declaring the recordset
   column and the `$2` casts as `timestamptz` made Postgres convert into the
   session zone on assignment, shifting every value. Caught by the fixed
   five-second coalescing-window test in `stepSyncV2.test.js`. Use
   `::timestamp` — `db.js` sets `pg.defaults.parseInputDatesAsUTC`, so UTC
   wall-time is what the original parameter binding stored.

Test result after both fixes: **74 pass, 0 fail** across
`race-queue-v2-single-writer` (25), `race-queue-v2-closure-parity` (20),
`race-queue-v2-closure-shadow` (6), `race-queue-v2-settlement-parity` (2),
`race-queue-v2-closure-scaling` (2), `api-contract-resolution-query-count` (1),
`stepSyncV2` (11), `home-step-sync-cooldown` (7).

**Lock ordering for 3.1 — VERIFIED 2026-08-17.**
`test/integration/race-queue-v2-enqueue-lock-order.test.js` measures the
acquisition order directly rather than inferring it from an absence of
deadlocks: a blocker transaction parks on one queue row, the enqueue is run so
it collides with that row, and a third session probes the *other* row with
`FOR UPDATE NOWAIT`. Whether the probe succeeds says which row the enqueue had
already taken when it stalled.

Result: blocked on the high id it already holds the low one; blocked on the low
id it has not yet reached the high one — ascending, and it stays ascending when
the caller passes the races in descending order. A control case runs the same
statement shape with rows fed descending and no `ORDER BY`, and the lock order
flips, which is what proves the experiment can detect order at all and that the
ordering is load-bearing rather than Postgres being incidentally well-behaved.

Two things this surfaced, both worth keeping in mind before touching the sort:

- **The JS `.sort()` alone would satisfy the ordering cases** — rows reach the
  server already ascending and `jsonb_to_recordset` preserves array order, so
  `ORDER BY i."raceId"` is redundant *today*. It is kept because it is what makes
  the order true if the planner ever stops preserving that input order, and a
  source-level guard asserts both halves are still present.
- **The concurrency case alone would not have caught a regression.** Reversing
  both the sort and the `ORDER BY` still passes it, because *consistent
  descending* is equally deadlock-free. Only an inconsistent order deadlocks, so
  a "many concurrent enqueues, no 40P01" test cannot by itself protect this
  invariant. Verified by mutation: reversing the order fails 3 of the 5 cases.

### 3.2 Compute the guard once instead of three times — TRIED, REJECTED 2026-08-17

**Do not re-attempt without new evidence.** The change was written, tested for
behavioural parity, benchmarked, and reverted. It is **9% slower**, not ~3×
faster.

Implementation used, since a CTE cannot reach `EXCLUDED`: multi-column
assignment, `SET (dirty_reasons, dirty_participant_ids, dirty_powerup_types) =
(SELECT … FROM (guard) g)`. The guard's condition list, its OR ordering, its
three-valued logic and the laziness of the merge branches were all preserved.

Measured on the integration database, 900 stored participant ids, 400 executions
per trial inside one server-side plpgsql loop, median of 5 trials
(`scripts/bench-enqueue-statement.js`):

| Statement | per-execution |
|---|---|
| shipped (guard written out ×3) | **1.12 ms** |
| hoisted (guard evaluated ×1) | **1.22 ms** |

Reproduced at 100 participants too (0.338 → 0.353 ms), and the wall-clock
end-to-end benchmark agrees. So evaluating the guard *once* costs more than
evaluating it *three times* — most plausibly Postgres was already sharing those
repeated subexpressions, while the nested `SubPlan`-inside-`SubPlan` the hoist
introduces adds per-invocation overhead that exceeds anything it saves.

**Two things worth keeping from the attempt:**

1. **`test/integration/race-queue-v2-enqueue-scope-guard.test.js` was kept.** The
   enqueue guard had NO coverage of any of its degrade branches — the one
   existing over-cap test drives `discardSuperseded`, a different statement with
   its own copy. 13 cases now pin every branch, and they pass identically on the
   shipped statement and on the rejected rewrite, which is what established that
   the rewrite was a true behavioural no-op before it was judged on speed.
2. **Per-call `EXPLAIN ANALYZE` is not usable at this effect size.** Its variance
   exceeded the signal and it reported a **41% win** for the change the loop
   benchmark shows is a 9% loss. Use the loop benchmark.

### 3.3 Replace the cap checks with `jsonb_array_length`

```sql
-- now (per column, so ×3):
(SELECT COUNT(*) FROM (SELECT DISTINCT value
   FROM jsonb_array_elements(existing || $6::jsonb)) s) > 1000
```

The DISTINCT materialisation exists to count *unique* ids. If the stored arrays
are already deduplicated on write — which the `triggered_by_user_ids` merge
already does via `jsonb_agg(DISTINCT v)` — a plain `jsonb_array_length` upper
bound is sufficient and is O(1) on the jsonb header.

**DONE 2026-08-17 — but NOT in the form proposed above.** The dedup invariant
does not hold in the way this section assumed, and the proposed rewrite is
unsafe. What shipped is a cheap *pre-filter* in front of the existing exact
check.

**Why the proposal above is wrong.** Both sides of the merge are individually
deduplicated — the stored side by the merge's `GROUP BY`, the incoming side by
`stableStrings()` in the reason registry — but they **overlap**, and their
concatenation is therefore not deduplicated. Re-reporting a participant id you
already reported is what a step sync does constantly. Swapping in
`jsonb_array_length` counts those duplicates, so a race sitting near 1,000
participants would degrade to `FULL` on nearly every sync — the expensive
direction, on the hottest path, for the largest races. Demonstrated: the naive
rewrite fails exactly one test, "an incoming id already in the stored scope does
not push it over the cap", and passes the other 13.

**What shipped instead:**

```sql
jsonb_array_length(a || b) > CAP AND <existing DISTINCT count over a || b> > CAP
```

`jsonb_array_length` is an O(1) header read and an exact **upper bound** on the
distinct count, so when it lands at or under the cap the DISTINCT pass cannot
change the answer and is skipped. Semantics are identical — the AND makes it
exact — and the expensive pass now runs only for scopes genuinely near the cap.

| stored scope | before | after | |
|---|---|---|---|
| 20 ids | 0.265 ms | 0.261 ms | neutral |
| 100 ids | 0.337 ms | 0.311 ms | −8% |
| 900 ids | 1.129 ms | 0.840 ms | **−26%** |

The win scales with scope size, which is the right shape: big races are both the
expensive case and the one that actually recurs under load. Against the
`VARIANT=noguard` floor of 0.806 ms this captures roughly 80% of the theoretical
31%.

**Two exact reformulations were tried first and are both WORSE** — do not
re-attempt:

| Form | p=900 |
|---|---|
| shipped `SELECT DISTINCT` + `COUNT(*)` (baseline) | 1.14 ms |
| `COUNT(DISTINCT value)` inline | **3.66 ms** (3.2× worse) |
| reuse the merge's deduped array, take its length | 1.42 ms (25% worse) |

The third of those also disproves the hypothesis raised by 3.2 that Postgres
shares identical subexpressions across the SET clause; if it did, reusing the
merge would have been free.

**Ceiling measured 2026-08-17 — this is the one still worth doing.** Same
harness and conditions as 3.2, neutralising *only* the cap counts
(`VARIANT=nocaps`):

| Component of the shipped statement | per-execution | share |
|---|---|---|
| the two `SELECT DISTINCT` cap counts | 0.355 ms | **31%** |
| the rest of the guard (typeof / `<@` / `jsonb_path_exists`) | 0.311 ms | 27% |
| merges, insert, WAL, lock | 0.495 ms | 43% |
| **total** | **1.16 ms** | 100% |

So 3.3 is worth ~31% of the hottest statement in the backend — a real target,
and the largest single one left. Note this also revises 3.2's premise: the guard
as a whole is ~58% of the statement, but its cost is in *what it computes*, not
in *how many times it is written*.

Two cautions the 3.2 attempt earned:

- **Measure with `scripts/bench-enqueue-statement.js`, not `EXPLAIN ANALYZE`.**
- **Extend `race-queue-v2-enqueue-scope-guard.test.js` first.** It already pins
  the exact-cap boundary (1000 and 64 pass; 1001 and 65 degrade). If the dedup
  invariant does not hold, those are the cases that will say so.

### 3.4 Skip the upsert when it would be a no-op

Many syncs add no new dirty scope — the reasons, participant ids and powerup
types are already present on the queued row. Today the full merge runs anyway
and rewrites an identical row, taking the lock and paying 2.1.

A cheap pre-check (or a `WHERE` clause on the `DO UPDATE` that suppresses a
write when the merged value equals the stored one) removes that cost entirely.

**Careful:** `generation` is incremented on every conflict and the worker's
fence depends on it. Suppressing a write must not suppress a generation bump
that a concurrent worker is relying on. This is the subtlest change here and
should be last.

---

## 4. Explicitly NOT the problem

Recorded so nobody re-investigates these. Each was measured and disproved.

- **Not the droplet CPU being maxed by application logic** — `src/` is 7.9% of
  busy CPU.
- **Not the database being undersized** — during the failing run only 4-10 of 21
  backends were `active`, several of those merely lock-waiting.
- **Not connection-pool size** — raising `bara-staging-pool` 3 → 20 halved the
  failure rate and did not fix it; the wall simply moved.
- **Not Prisma's `connection_limit`** — this backend uses the **driver adapter**
  (`src/db.js` builds an explicit `new pg.Pool({ max: 20 })` wrapped in
  `PrismaPg`), so Prisma's own pool settings never apply and the URL parameter
  is ignored.
- **Not a `tx`-vs-global-client wiring bug** — the hot path threads `tx`
  correctly throughout.
- **Not `balanceConfig.getSnapshot()` inside the fence** — it is behind a 5 s
  in-process cache, so it misses at most once per 5 s per worker.

---

## 5. How to verify

Baseline, 61 rps against staging (1 worker, `bara-staging-pool` = 20), from
`k6/README.md` in the frontend repo:

```bash
cd ~/repos/stepv2-frontend/k6
k6 run -e FAST=1 -e TARGET_ONLY=dau_5000 -e DURATION_OVERRIDE=90s \
  --out csv=/tmp/after.csv prod-mix-load-test.js
```

| metric | baseline | target |
|---|---|---|
| ok rate @ 61 rps | 52.6% | >95% |
| p95 | 30 s | <2 s |
| **enqueue share of DB busy time** | **81%** | **<25%** |
| `idle in transaction` (of ~21) | 13-16 | <5 |

**The primary metric is the enqueue's share of database time, not the error
rate.** Sample it with the same method that produced this document:

```sql
SELECT left(regexp_replace(query,'\s+',' ','g'),95)
FROM pg_stat_activity
WHERE datname='step-tracker-staging' AND backend_type='client backend'
  AND state='active' AND query NOT LIKE '%pg_stat_activity%';
```

Per-request query counts are available by setting
`PRISMA_QUERY_EVENTS_ENABLED=true` (staging `.env`) and reading the
`api_contract_performance` log events, which carry `sqlCount` per endpoint.
**Leave it `false` in prod** — the flag adds hot-path work by design, and set it
the same way in both halves of any before/after comparison.

The tooling for all of the above lives in the **frontend** repo's `k6/`
directory and is documented in `k6/README.md`:

| script | measures |
|---|---|
| `prod-mix-load-test.js` | capacity (prod-weighted mix, arrival-rate rungs) |
| `profile-worker.js` | which **code** burns CPU (V8 profile via the worker's inspector) |
| `sample-db-queries.sh` | which **SQL** burns database time |
| `sample-db-state.sh` | active vs `idle in transaction` vs lock-waiting |

**`pm2 profile:cpu` profiles the pm2 daemon, not the app** — it returns 97.6%
idle and looks superficially valid. Use `profile-worker.js`.

---

## 6. Risk

This is the coalescing core of race resolution. The guards being simplified are
what force a `FULL` recompute when the dirty scope is corrupt, oversized, or
carries an unknown reason — i.e. they are the last line of defence against
committing a wrong race standing. `dirty_reasons` is also sticky across merges
(one `FULL` poisons the row), which is load-bearing and was the subject of a
prior incident.

Required per `CLAUDE.md`: spec approval → `architect` review → implementation by
`backend-developer` → `code-reviewer`. Integration tests over unit tests; no
existing assertion weakened. Existing coverage to run and extend:

- `test/integration/race-queue-v2-single-writer.test.js` (lock ordering)
- `test/integration/race-queue-v2-closure-parity.test.js`
- `test/integration/race-queue-v2-settlement-parity.test.js`
- `test/integration/race-queue-v2-closure-scaling.test.js`
- `test/integration/api-contract-resolution-query-count.test.js`
- `test/integration/stepSyncV2.test.js`

Frozen-client rule applies: the `raceResolution.jobId` / `generation` /
`requestedAt` wire shape returned by `/steps/sync-v2` must not change.

---

## 7. Related infrastructure findings (already fixed, 2026-08-16)

Not part of this plan, but discovered alongside it and relevant to capacity:

- **Prod was running 1 of 2 workers.** The 2-instance setup was never persisted;
  a worker had also been OOM-killed. Now declared in `ecosystem.config.js` and
  re-asserted by the deploy. Roughly 2× prod capacity recovered.
- **Prod on 1 worker silently disables all crons** — `pm2 scale steps-tracker 1`
  keeps `NODE_APP_INSTANCE=1`, and `startCrons()` is gated on instance `0`.
- **The droplet has OOM-killed node 6 times.** 1.97 GB with no swap does not fit
  four ~400 MB workers; staging is therefore pinned to 1 instance.
