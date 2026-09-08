# Powerup command batching: architecture research

Research date: 2026-09-08. Recommendation, not an approved implementation spec.
Scope: all powerup-use commands, not only Outage or Shortcut. No gameplay rule,
application code, runtime setting, schema, or production service changed.

TDD follow-up correction: real-PostgreSQL testing later showed the original raw
lock helper receives lowercase enum values, but compares them to uppercase
`PINECONE_TOSS`. The Pinecone narrow path described below was source intent,
not effective production behavior. New lock-scope tests must use actual database
enum values rather than relying on uppercase mocks.

Reviewed backend main `ba6cfc3` against release `3b241ff`. The powerup-use,
step-intake, race-fence, resolution-queue, and transaction-helper source reviewed
here is identical between those revisions. Main contains unrelated billing
changes; this report does not authorize releasing them. Frontend compatibility
observations describe the current Dart source, not an audit of every shipped binary.

**Recommendation**

Prototype a durable, ordered powerup-command inbox feeding a coordinated race
scheduler. All powerup uses share that execution path. Resolve bounded batches
against shared mutable state and bulk-persist their consequences when the command
semantics permit it. Preserve the existing race-resolution engine and its fences.
Do not create an independently competing, unbounded pool of powerup workers.

This can amortize repeated work and move waiting out of database transactions.
It is not yet evidence of a latency or CPU improvement. A queue alone adds writes;
the savings require shared reads, reduced lock churn, batched persistence, and
coalesced follow-up work. Sparse traffic may have no batch to amortize.

**What exists today**

| Stage | Observed behavior | Consequence for the proposal |
| --- | --- | --- |
| Step upload | `recordStepSyncV2` calls `stepInputIntake`, persisting canonical daily/sample data, scoring generation, and race work atomically. Response explicitly reports deferred reconciliation. | Upload ingestion is already separate from scoring. A powerup must not wait for every outstanding upload globally. |
| Race queue | One `race_resolution_jobs_v2` row per race, merged dirty reasons/users/participants/powerup types, generations and leases. | This is a coalesced recomputation queue, not an ordered event log. Two identical powerup types cannot stand in for two commands. |
| Powerup use | `usePowerup` starts a transaction, takes the race-job fence, race row, item row and usually all accepted participant rows, then validates/applies the action. Pinecone Toss narrows its initial participant lock. | Even self buffs and ordinary targeted actions can wait on a large shared lock scope. This is a plausible source of busy-period delay, not measured attribution. |
| After use | Common completion paths defer invalidation, `POWERUP_MUTATION` enqueue, inventory repair, and alert work until after commit. Branches have differing completion paths. | Much downstream work already belongs outside the authoritative mutation. Audit every branch before consolidating completion. |
| HTTP completion | `runInPrismaTransaction` awaits post-commit callbacks sequentially before returning. | Response latency includes work after the effect is already committed. A command queue does not automatically remove this delay. |
| Resolution worker | Computes outside its write transaction, then validates lease/generation/input fingerprints under the race fence before persistence. | Reuse this correctness machinery; an old computation must not overwrite newer powerup consequences. |
| Worker budget | `raceResolutionWorkBudget` shares a process-local cap between core resolution and post tasks. | A new process or HTTP-local queue does not automatically share that cap. Cross-process scheduling/capacity ownership must be explicit. |

Source anchors:

- [Step intake](../src/modules/steps/services/stepInputIntake.js),
  [sync HTTP command](../src/modules/steps/commands/recordStepSyncV2.js).
- [Powerup command and lock helper](../src/modules/powerups/commands/usePowerup.js),
  [HTTP route](../src/modules/races/routes.js), [transaction helper](../src/db.js).
- [Race fence](../src/modules/races/services/raceWriteFence.js),
  [job model](../src/modules/races/models/raceResolutionJobV2.js),
  [worker](../src/modules/races/jobs/raceResolutionQueueV2.js),
  [shared work budget](../src/modules/races/services/raceResolutionWorkBudget.js).

**Relationship to step sync**

Separate the durable representations of work, but coordinate execution per race:

1. Step intake persists source facts and marks affected races dirty, as today.
2. Powerup intake records each authenticated command and its immutable request
   context in a new durable inbox. Redis can wake workers; it must not be the
   sole copy of accepted actions.
3. A coordinated race scheduler selects pending command work or resolution work
   with bounded total concurrency and fairness. Do not put casts behind the
   step-ingestion debounce: the job model defaults to five seconds for relevant
   coalescing paths, while powerup resolution requests use immediate priority.
4. The selected owner takes the existing race fence for authoritative writes.
   Existing lifecycle, expiry, membership and inventory writers still require
   their locks; scheduler ownership alone does not exclude them.
5. Committed command consequences atomically request the necessary resolution
   work, and the existing resolver converges scoring/projections afterward.

Prefer extending the dedicated resolution process's scheduling/budget ownership
over adding an unrelated pool. This is an implementation hypothesis: command
execution and scoring should remain separate modules even if one dispatcher
schedules both. Fairness must prevent hot races or sustained casts from starving
step resolution, effect deadlines, settlement, or delivery work.

A new inbox must not acquire the long-held race-execution fence just to accept a
command; that would move the current wait to the new endpoint. It still needs a
short, durable ordering/admission protocol, including any FK/item-lock effects.
Define order explicitly: timestamps or sequence allocation alone do not prove
transaction commit order. A worker cannot skip an earlier command in one race
merely because that command is locked; it can select a different eligible race.

**How a batch should behave**

Take a bounded prefix of one race's commands. Load the required state once,
evaluate commands sequentially, and update an in-memory overlay after each one.
Persist final row mutations in bulk while retaining each command's result,
events, receipts, inventory transitions and applicable intermediate boundaries.
Only return success after commit. Use a single-command batch when appropriate.

For example, a successful Outage that jams an attacker before their Shortcut
rejects that Shortcut before touching the target's Socks. If Shortcut comes
first, Socks block it and are consumed before Outage is evaluated. Do not reorder
by powerup type or retroactively cancel an earlier completed action.

An invalid gameplay command should produce its own rejection without cancelling
valid peers. Build its changes in a discardable command-local overlay; do not
catch arbitrary database errors and continue an aborted PostgreSQL transaction.
Unexpected database failure rolls back the whole uncommitted batch. No partial
success responses or notifications may escape it. Failed-batch retries need
bounded recovery so one bad command cannot permanently block a race.

Batch size must consider touched rows and computation, not just command count:
one race-wide attack can cost more than many self buffs. Start processing idle
races promptly and batch work already pending; do not assume a fixed waiting
window improves interactive latency. Choose limits experimentally, not from the
single-Outage benchmark. Do not introduce release flags for this normal change.

**Why the existing handlers cannot simply run in a loop**

- They repeatedly fetch race/effect/inventory state and write directly to models.
  Reusing one transaction does not reuse those reads or batch the writes.
- Trail Mine and Uprising calculate fresh totals for placement/rank decisions.
  Early-ending effects can clamp a DB effect and invoke the scorer against that
  uncommitted change. A memory overlay must reach the scorer, or these commands
  need explicit intermediate flush/compute boundaries inside the bounded batch.
- Leech/Hitchhike and other dependent effects require more than an actor/target
  snapshot. The existing powerup scope registry describes resolution scope, not
  a proven safe lock/read set for command execution.
- Stealth, reflection, redirection, shield consumption, scan results, and timed
  effects depend on state at each command, not solely the batch's final state.
- Inventory transfers, upgrades, store-item rejection refunds, and shared user
  balances interact with operations outside a race. Preserve their conditional
  writes and global lock ordering; a per-race lock does not protect a wallet
  from the same user's activity in another race.
- Timed-source metadata, direct-impact deltas and durable receipts are
  authoritative inputs. Summing final step deltas and dropping individual source
  events would break downstream behavior even if the final score initially matched.
- Randomized outcomes need reproducible retry handling, preserving the same
  rules; repeated failed attempts must not offer a way to choose a new outcome.

All powerup types should enter one framework. Complex types can initially use
explicit execution boundaries within that framework, rather than a second HTTP
writer that bypasses ordering. Cover every live catalog type and retain retired
type rejection compatibility; the existing registry is a useful coverage aid.

**Step freshness and time are unresolved design contracts**

My earlier suggestion to account for pending steps was too broad. Canonical
uploads are already durable, while their race scores may still be pending.
Current powerups do not all refresh totals the same way. Loading the latest
persisted participant rows is therefore not universally equivalent to computing
from the latest uploaded samples.

Document the existing input semantics per command first. For commands needing
fresh totals, capture a bounded source generation and calculate the relevant
dependencies from it; validate that snapshot before committing, following the
existing resolver's fingerprint/version model. Do not drain a continuously
changing global step backlog or silently change all powerups to a new freshness
rule as a performance optimization.

Likewise define command admission order, execution time, effect expiry, and race
end explicitly. Current handlers take time during execution, after waiting for
locks, and sometimes check again. Do not backdate queued actions to device time
or hold a race open indefinitely for pending commands. Commands crossing a
deadline require parity tests and an explicit compatibility decision.

**Old-app and failure compatibility**

The current Flutter `BackendApiService.usePowerup` awaits a final HTTP result.
`_sendJsonRequest` has a 15-second response timeout. The race-detail screen reads
the actual applied/blocked/reflected result and updates coins and presentation.
There is no powerup pending-job protocol in that path. Returning a successful
queued response would not preserve the existing contract.

The queue-backed endpoint must wait for a durable terminal result without holding
a DB connection. Persist the original request's capabilities/timezone/payload,
and replay the correct response after a successful retry. Existing item
HELD-to-USED protection prevents double consumption but is not a complete
command-result/idempotency protocol. Rejected commands that leave an item HELD
must allow a later legitimate attempt; do not permanently deduplicate all uses
by item ID alone. Concurrent differing payloads for the same item need an
explicit conflict rule.

Disconnect or timeout does not imply cancellation. Define atomic admission expiry
versus worker claim, response replay, and recovery before implementation. A job
accepted but left to execute much later can surprise old apps even if it only
executes once. Apply bounded admission/backpressure before accepting work the
service cannot handle; do not solve an overloaded queue by increasing HTTP
timeouts or returning a generic successful acknowledgement.

After-commit follow-up should use durable work and wakeups, retaining required
response fields and inventory correctness. Coalescing invalidations per race is
different from dropping per-player delivery intents. An awaited callback audit
may yield latency improvements even before command batching.

**Evidence and what remains unproven**

- The [Outage benchmark](power-outage-2000-benchmark.md) reduced a local
  2,000-recipient cast's median HTTP time from 3,280 to 323 ms and SQL statements
  from 15,974 to 56. It demonstrates batching within one command, not mixed-command
  queue throughput or production capacity.
- The [September 7 queue comparison](queue-convergence-fix-2026-09-07.md) found
  that higher concurrency could increase contention and superseded computation.
  In its fully offered 256-upload/s cases, concurrency 3 versus 20 had about
  6 versus 18 seconds p95 request-to-score delay. The report documents remaining
  failures and test limitations; it does not certify a production ceiling.
- Existing route telemetry records aggregate use duration. On the successful
  path, the route overwrites the type captured by `onPerformanceContext` with
  `result.type || result.powerupType || null`; many branches return neither.
  Preserve that classification when adding phase evidence.
- No new load benchmark, production trace, database CPU measurement, test run,
  or deployment was performed for this research. Broad participant locks and
  awaited post-commit tasks are leads, not a diagnosis of a particular slow tap.

**Validation before selecting the implementation**

Compare the same workload on (A) current code, (B) narrower proven read/lock scope
and consolidated follow-up, (C) durable scheduling with single-command commits,
and (D) scheduling plus shared-state microbatches. This separates scheduler benefit
from handler optimization and true batching savings.

Use real HTTP, two HTTP processes, the actual resolution worker, dedicated local
`*_test` PostgreSQL and isolated Redis. Test one 2,000-player weekly race, many
small races, and overlapping memberships with concurrent step uploads. Cover
idle traffic, bursts, sustained load and overload; do not change worker/pool
capacity between comparisons.

Include every live powerup's public-path behavior, with targeted interactions:
ordered jam/cleanse/shield/attack chains, two hits on one defense, reflection and
Decoy, transfers versus use/discard, concurrent balance spend across races,
fresh-total decisions, timed boundaries, hidden identities, duplicates with
same/different payloads, rejection followed by valid retry, and race expiry.
Kill/restart workers before commit and after commit before response; retry the
same request; verify no duplicate effects, charges, receipts or notifications.
Check persisted state and public results before reads can repair stale data.

Measure command admission delay, DB-pool wait, race-lock wait, shared-state load,
evaluation, SQL/commit, post-commit work, HTTP response, and projection visibility
separately. Report p50/p95/p99, offered/accepted/rejected/completed counts, oldest
pending command, step-resolution lag, SQL statements and rows, connection waits,
DB CPU, retry/discard rates and starvation. Count rejected/unissued work rather
than hiding it from latency comparisons. Set success thresholds before running.

**External primary-source checks**

- PostgreSQL documents `SKIP LOCKED` for queue consumers but warns that it returns
  an inconsistent view. Use it for claiming eligible race work, never for
  silently omitting locked defenders from gameplay evaluation.
  [PostgreSQL 18 SELECT](https://www.postgresql.org/docs/18/sql-select.html).
- Prisma recommends short interactive transactions because long transactions
  harm performance and can deadlock. This supports bounded batches and avoiding
  network operations while holding gameplay locks, not one unlimited transaction
  for everything queued in a race.
  [Prisma transaction documentation](https://www.prisma.io/docs/orm/v6/prisma-client/queries/transactions).
