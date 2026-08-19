> **SUPERSEDED 2026-08-16 — do not implement.**
> This document blamed transaction hold time. Hold time is real but it is a
> *symptom*: one statement (`INSERT INTO race_resolution_jobs_v2 … ON CONFLICT`)
> turned out to be **81% of all database busy time**, issued once per race
> sequentially inside the step-sync transaction. See
> **`resolution-enqueue-cost-requirements.md`**, which replaces this.
>
> Kept only for the measurements in §1 and the disproved theories in §1's
> "What it is NOT", which remain valid.

> **Historical harness notice:** The frontend production-mix harness and
> staging-clone workflow used for the measurements below were retired in
> 2026-08. Commands in this document are archival evidence, not runnable
> instructions. Use the frontend repository's `k6/README.md` for the supported
> smoke/find/confirm/soak workflow; its replacement profile is not directly
> comparable to these results.

# Transaction hold-time reduction — requirements

**Status:** proposed, not approved. No code changed.
**Date:** 2026-08-16
**Goal:** raise the concurrent-user ceiling from ~1,250–2,500 to 5,000+ without
buying hardware.

---

## 1. The problem, measured

Load test against staging on prod-cloned data, 400 distinct user identities,
driven at the measured prod request mix using the now-retired frontend k6
harness.

| Offered load | ok | 5xx | p95 |
|---|---|---|---|
| 15 rps (1,250 users) | 90.0% | 0.0% | — |
| 31 rps (2,500 users) | 61.5% | 12.8% | — |
| **61 rps (5,000 users)** | **52.6%** | **19.2%** | **30 s** |
| 122 rps (10,000 users) | 36.6% | 33.8% | 30 s |

**5,000 concurrent users is roughly 61 rps** (0.0122 peak rps per DAU, derived
from 24h of prod nginx logs). The app fails well before that.

### What it is NOT

Two expensive theories were tested and disproved. Do not re-walk them:

- **Not droplet CPU.** The app droplet (2 vCPU) held **23–52% idle** through
  every failing rung. Requests took 11 s while two cores sat a third idle.
- **Not database CPU, and not a database that needs resizing.** Sampling
  `pg_stat_activity` once a second during a 61 rps run: of 21 backends only
  **4–10 were `active`**, and several of those were parked on
  `Lock:transactionid` rather than computing. The DB node (`db-s-1vcpu-2gb`) is
  not saturated.
- **Not a `connection_limit` setting.** This backend uses the Prisma **driver
  adapter** — `src/db.js` builds an explicit
  `new pg.Pool({ max: 20, connectionTimeoutMillis: 5000 })` wrapped in
  `PrismaPg`. Prisma's own pool defaults never apply and a `connection_limit`
  URL parameter is silently ignored.
- **Not a `tx`-vs-global-client wiring bug** in the hot path.
  `StepSample.reconcileBatchOn(tx, …)`, `bumpScoringInputVersion(tx, …)` and
  `stepSyncRequestModel.createReservation(…, tx)` all correctly receive the
  transaction handle. `raceResolutionQueueV2` contains zero `await prisma.`
  calls. (One exception is noted in §2.2.)

### What it IS

```
19:00:12  active=1   idle_tx=0   idle=17  total=18
19:00:24  active=2   idle_tx=13  idle=6   total=21
19:00:37  active=6   idle_tx=12  idle=3   total=21   Lock:transactionid
19:00:45  active=10  idle_tx=11  idle=0   total=21   Lock:transactionid
19:01:13  active=8   idle_tx=13  idle=0   total=21   Lock:transactionid
```

**13–16 of 21 connections sit in `idle in transaction`, and free connections
reach zero.** The pool is not consumed by work; it is consumed by open
transactions that are not currently issuing queries. Each one also holds its row
locks for its whole lifetime, which produces the `Lock:transactionid` waits and
the deadlocks (8 observed in one run).

This is why raising the pool 3 → 20 only halved the failure rate instead of
fixing it: 20 slots fill with idle transactions exactly as 3 did. **Pool size is
not the lever. Transaction hold time is.**

---

## 2. Root causes, ranked by expected payoff

### 2.1 The resolution write transaction permits 15 s holds and 10 s queueing

`src/modules/races/jobs/raceResolutionQueueV2.js:1073`

```js
{ timeout: 15_000, maxWait: 10_000 }
```

`maxWait: 10_000` lets a transaction spend 10 s waiting to acquire a connection;
`timeout: 15_000` lets it hold one for 15 s. Under contention this is the
amplifier that turns a slow moment into total pool starvation — a handful of
concurrent resolutions can occupy the pool for 15 s while everything else
queues behind them and times out at `connectionTimeoutMillis: 5000`.

The existing comment justifies the headroom ("a large field is still N row
updates"). That reasoning is sound for a big race; the problem is that the
ceiling applies to *every* resolution, including small ones.

**Proposed:** scale the budget to the write size rather than using one worst-case
constant — a small ceiling by default, with the current headroom retained only
when `participantWrites.length` exceeds a threshold. Requires knowing the actual
distribution of `participantWrites.length` and observed `writeMs` in prod first
(see §4).

### 2.2 Non-database I/O inside the write transaction

Same transaction, at `raceResolutionQueueV2.js:909` and `:971`:

```js
const currentConfig = await balanceConfig.getSnapshot();
```

`getSnapshot()` (`src/modules/economy/balanceConfig.js:668`) is in-memory cached
with a TTL, but on expiry it performs `derivedCache.cachedRead(…)` — a **Redis
round trip**, and on a Redis miss a **database read on the global client**. Both
happen while this transaction is open:

- the Redis hop is pure latency added to the hold time;
- the DB fallback checks out a **second pooled connection** while the first sits
  idle in transaction — the exact nested-checkout pattern that deadlocks a pool
  under load.

It is called at two points in the transaction (artifact path and closure path).

**Proposed:** resolve the snapshot **before** opening the transaction and pass
the value in. The fence logic compares `currentConfig.version` against the
claim; reading it marginally earlier does not weaken that check, because the
generation/fingerprint comparison inside the fence is what makes the write safe.
**This needs review against spec rule 7** (`race-resolution-dependency-closure-requirements.md`)
before it is treated as settled — rule 7 governs what must be re-verified inside
the fence, and this must not become a second fingerprint implementation.

### 2.3 Step-sync Transaction A holds `users` and `steps` row locks across 5–7 round trips

`src/modules/steps/commands/recordStepSyncV2.js:327`

Sequence inside one transaction:

1. conditional `UPDATE users … last_home_pull_step_sync_at` (home-pull throttle)
2. `tx.step.findUnique`
3. `tx.step.update` or `tx.step.create`
4. `tx.user.update({ lastStepSyncAt })`
5. `StepSample.reconcileBatchOn(tx, …)` — batch sample writes
6. `bumpScoringInputVersion(tx, …)`
7. `stepSyncRequestModel.createReservation(…, tx)`

Each step is a separate network round trip; the connection is idle between them
but the transaction — and its locks on `users`, `steps`, `step_samples`,
`user_scoring_input_versions`, `step_sync_requests` — stays open throughout.

Note the `users` row is locked twice: at (1) and again at (4). Step (4) is
last-sync bookkeeping; the comment chain gives no correctness reason for it to
be atomic with the step write.

**Proposed, in increasing order of risk:**

- **(a) DONE 2026-08-17 — moved out of Transaction A.** The stamp now runs after
  the transaction commits, next to the daily-steps cache invalidation, and its
  failure is swallowed for the same reason: the steps are already committed, so
  failing a sync over a bookkeeping timestamp would be strictly worse than losing
  it. Transaction A drops from 7 statements to 6, and — the actual point — it no
  longer holds a `users` row lock across the sample reconcile, the scoring-input
  bump and the reservation insert.

  Two things that made this safe beyond the reader audit below: nothing inside
  the transaction reads the value back, and the **v1 path (`recordSteps`) already
  stamps it outside any transaction**, so non-atomic stamping was existing
  behaviour rather than something this change introduces.

  A regression test was added (`stepSyncV2.test.js`, "stamps lastStepSyncAt on a
  successful sync") because the behaviour had **no coverage at all**, in or out
  of the transaction; mutation-checked by deleting the stamp.

  **The benefit is not locally measurable** — it is lock hold time under
  contention, so it shows up in the `idle in transaction` sample during a staging
  load run (§5), not in a single-request timing.

  Original reasoning follows.

- **(a) Move `tx.user.update({ lastStepSyncAt })` out of the transaction.** It is
  a timestamp; a crash between commit and stamp costs one stale
  `lastStepSyncAt`, which the next sync corrects.
  `last_home_pull_step_sync_at` at (1) is a *different* column and must stay
  inside — it is the throttle authority.

  **Readers audited (2026-08-16) — all three are push-suppression heuristics,
  none is a correctness gate:**

  | Reader | Use |
  |---|---|
  | `src/shared/push/stepSyncPush.js:51,171` | "synced recently → skip the silent push" |
  | `src/modules/races/services/raceResolutionDeliveryIntents.js:161` | same suppression, in the batch eligibility SQL |
  | `src/modules/users/models/user.js:40` | selected into the payload; `authMeCache.js:50` annotates it "bookkeeping; not read by the client" |

  **Failure mode if the stamp is lost:** the user looks *less* recently-synced
  than they are, so they may receive one extra silent push. That is the safe
  direction — no double-counted steps, no missed scoring. This makes (a) the
  lowest-risk change in the document and the recommended starting point.
- **(b) Collapse (2)+(3) into a single `upsert`.** Removes one round trip.
  `changed` is currently derived from `existingStep`; an upsert would need
  another way to report it (e.g. `xmax = 0` via `$queryRaw`, or comparing
  `createdAt`/`updatedAt`).
- **(c) Fold (6) into (5) or (7).** Needs a read of `bumpScoringInputVersion`'s
  contract first; it participates in the closure fingerprint, so ordering may be
  load-bearing.

**(a) is the clear first move**; (b) and (c) are follow-ups only if measurement
says the remaining round trips still matter.

### 2.4 The app pool is oversubscribed 2:1 against PgBouncer

`src/db.js:22` sets `max: 20` **per process**, and pm2 runs the app in cluster
mode with 2 instances — 40 client connections against a PgBouncer pool of 25
(prod). PgBouncer queues the excess, node-postgres gives up after
`connectionTimeoutMillis: 5000`, and the request 500s with
`Error: timeout exceeded when trying to connect` (the dominant error signature
once §2.1–2.3 starve the pool).

This does not by itself cause the stall, but it converts backpressure into
errors instead of latency, and it makes the failure mode abrupt.

**Proposed:** align the per-process `max` so that `max × instances ≈ pool size`,
and treat `connectionTimeoutMillis` as a deliberate shed-load budget rather than
an accident. Change only *after* §2.1–2.3, so the effect of each is measurable
separately.

---

## 3. Explicit non-goals

- **Do not resize the database cluster.** §1 shows it is not saturated.
- **Do not raise the connection pool sizes.** On a 1-vCPU database more
  concurrent backends adds context-switching, not throughput, and the 3 → 20
  experiment already showed the wall simply moves. Note the current sizes
  (prod 25 + staging 20 = 45) already sit close to the **47 usable**
  connections (`max_connections` 50 − 3 superuser-reserved); staging should
  return to 3 when not benchmarking.
- **Do not change `/challenges`.** Unrelated; already handled.

---

## 4. Evidence still needed before implementing

1. **Prod distribution of `participantWrites.length` and `writeMs`** in
   `raceResolutionQueueV2`, to size §2.1's threshold instead of guessing.
2. ~~Whether `lastStepSyncAt` is read as a correctness gate~~ — **answered
   2026-08-16, see §2.3a. It is not; all three readers are push suppression.**
3. **`balanceConfig.getSnapshot()` cache hit rate under load.** If it effectively
   never misses inside a transaction, §2.2 is a latent hazard rather than an
   active cause, and drops in priority.
4. **Confirmation from `race-resolution-dependency-closure-requirements.md`
   rule 7** that hoisting the config read out of the fence is permitted.

---

## 5. Historical verification protocol

The baseline is recorded, but the harness no longer exists. The following
command is preserved only to identify how the 2026-08-16 comparison was run;
do not run it as a current capacity test:

```bash
cd ~/repos/stepv2-frontend/k6
k6 run -e FAST=1 -e TARGET_ONLY=dau_5000 -e DURATION_OVERRIDE=1m \
  --out csv=/tmp/after.csv prod-mix-load-test.js
```

Compare against the 2026-08-16 baseline at 61 rps: **52.6% ok / 19.2% 5xx /
p95 30 s**.

**The primary success metric is not the failure rate — it is `idle in
transaction`.** Sample during the run:

```sql
SELECT state, COUNT(*) FROM pg_stat_activity
 WHERE datname='step-tracker-staging' AND backend_type='client backend'
 GROUP BY state;
```

Baseline is 13–16 idle-in-transaction of 21 with 0 free. A fix that does not
move that number has not addressed the cause, whatever it does to the headline
percentage.

At the time, a like-for-like comparison required re-syncing staging from prod
and temporarily raising `bara-staging-pool` to 20. That staging-clone procedure
is not part of the replacement harness. Follow the frontend `k6/README.md` for
the current non-production fixture and target-safety contract.

---

## 6. Risk

This is the step-sync hot path — the highest-traffic, most correctness-sensitive
code in the backend, carrying explicit invariants about idempotency replay,
double-counting of step samples, and fence ordering. Several of the comments in
these functions record past incidents.

Per `CLAUDE.md` this warrants: spec approval → `architect` review → implementation
by `backend-developer` → `code-reviewer`. Integration tests over unit tests, and
no existing assertion weakened. Every change here is also subject to the frozen-
client rule: shipped binaries keep calling these endpoints with the old
expectations.
