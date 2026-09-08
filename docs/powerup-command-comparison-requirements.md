# Powerup execution comparison

Status: experiment design for review; production queue implementation/deployment
is outside this experiment. User has requested comparison against current behavior.

2026-09-08 implementation authorization: user requested "start with tdd for
locking fixes". Execute A/B participant-lock work only, including audited self
and targeted paths; keep API, post-commit scheduling, race fence and gameplay
rules unchanged. Queue C/D and post-commit consolidation remain out of this
implementation. Use a release-based isolated checkout and do not deploy.

Subsequent authorization: user approved proceeding with original behavior,
narrower locks, ordered queue, and shared-state batching comparison. Run real
concurrent powerup and step-sync traffic; artificial lock holds are excluded
from the performance comparison. Local experiments only; no deployment. A is
`3b241ff`; B is reviewed locking fix `9b2cfb8`. Keep unimplemented/failed candidate
capabilities and performance limitations explicit in the final evidence.

## Summary and user story

During busy races, any powerup can respond slowly, including self bonuses. Measure
whether narrower participant locks, bounded command scheduling, and shared-state
batching improve actual public-request latency and database cost while preserving
each powerup's existing outcome. Cover the entire use-command framework, not an
Outage-specific or Shortcut-specific path.

Backend repository is identified by `CLAUDE.local.md`. Research is in backend
`docs/powerup-command-queue-research.md`. Baseline is release commit `3b241ff`;
freeze its tree and dependency versions for all comparisons. Do not base the
experiment on unrelated billing changes from backend main.

## Scope and non-goals

Local experimental checkouts, dedicated `*_test` databases, isolated Redis, real
HTTP handlers and real PostgreSQL. No staging start, production mutation, PM2
capacity change, deployment, mobile release, feature flags or gameplay changes.
Experimental alternatives are separate source revisions/process entrypoints,
not runtime controls added to the shipped application.

Four arms, reported separately. Complete A/B before implementing C/D; their
measured results determine whether the larger queue experiment is justified.

1. A: unchanged current release.
2. B: audited narrower participant lock scopes. Separately measure B-followup
   with consolidated durable post-commit scheduling, so response-work savings
   cannot be attributed to reduced locks. Retain race fence, lifecycle lock, item consumption
   checks, wallet concurrency and required response/inventory behavior. Initially
   narrow proven self-only Protein Shake and Trail Mix; other types retain their
   existing scope unless their complete read/write dependency set is proven.
   Include an independently reported B-targeted experiment: plan a targeted
   attack's Mirror/Decoy chain without mutations while holding the existing race
   fence, derive the participant/effect dependency set, acquire locks in the
   audited global order, revalidate, then apply. A Decoy chain can touch the
   caster, original target and redirect recipient, not just the final victim.
   Reads of eligible candidates do not themselves require locking every candidate.
   Audit effect insertion/expiry writers: locking existing effect rows does not
   protect an absent defense from concurrent insertion. If validation changes the
   dependency set, restart planning with the full ordered set; never append locks
   out of order or repeatedly redraw random targets to obtain a convenient result.
3. C: B plus durable per-race command scheduling, one command per transaction.
4. D: C plus bounded, sequential command batches, reused state reads and batched
   consequence writes. A loop over unchanged handlers is not this arm. If D
   needs an intermediate scorer flush, record it explicitly and include its cost.

All live powerup types enter the same scheduler in C/D. Complex types can impose
an execution boundary within that scheduler; they must not bypass command order.
The report identifies which types achieve shared-state batching versus boundaries.
Unknown/retired types keep existing validation/rejection behavior.

## API contract and old-app compatibility

Keep `POST /races/:raceId/powerups/:powerupId/use` unchanged. Example request:
`{"targetUserId":"recipient-id","upgradeLevel":0}`; self-use remains `{}`.
All existing optional targeting/direction/effect/multi-target fields and request
capability headers retain meaning. Never introduce required request fields.

Success remains `{"result":{...existing type-specific fields...}}`, including
the existing top-level `activeImpactReceipt` when present. Scan success retains
`{"ok":true,"scan":{...},"result":{...}}`. Errors preserve current HTTP status
and `{"error":"message","code":"optional-existing-code"}` shape. Retired
type errors retain `powerupType`. Compare exact normalized payloads per fixture,
not just 200 status or final scores. Do not return a successful queued response.

Current Dart source awaits a terminal result and uses a 15-second response
timeout: `lib/services/backend_api_service.dart:5261` and `:6316`.
`lib/screens/race_detail_screen.dart:2995` consumes the result for outcome and
coin presentation. Preserve both iOS and Android behavior. Capture timezone,
request capabilities and canonical payload on admission; worker execution must
not substitute the user's newer stored capabilities.

For experimental overload: reject before durable admission when bounded
capacity is unavailable, with HTTP 503 and `{"error":"Powerup service busy. Please try again."}`.
Record it as rejected work, not throughput or successful latency. Accepted work
must persist its terminal result and return it through the original request if
still connected, or replay it on a matching retry; the waiter must not occupy a
DB connection. Timeout/disconnect is not cancellation.
Any inability to meet the existing client deadline is a failed compatibility gate,
not permission to increase the timeout or silently execute minutes later.

For this local prototype, pending commands have a five-second start-admission
deadline. Pending-to-running claim and pending-to-expired transitions compare
database time atomically; expired commands do not consume their item and persist
the same 503 busy response. This is a start deadline, not a promise that execution
finishes within five seconds. Running commands retain the existing transaction
deadline. Count end-to-end responses over 15 seconds as client-deadline misses in
healthy-load runs, including A. Fault-injection cases instead require durable
recovery and replay, not delivery to a disconnected HTTP request. Permit at most
three failed execution attempts per command, then record a terminal 500 after
proving no committed result exists. A HELD item permits a new legitimate attempt.
These experiment contracts need separate review before a production proposal.

## Experimental data model and scheduling

Use test-only SQL outside the production Prisma migration directory, installed
only after localhost and `_test` validation. Queue storage is durable PostgreSQL;
Redis wakeups are an accelerator. Maintain these conceptual records:

- Per-race inbox state: race ID primary key, next sequence, worker lease token,
  lease expiry, last completed sequence. Admission sequence assignment is a short
  transaction, independent of the long-held race execution fence. No admission
  can become visible past an uncommitted predecessor: serialize sequence allocation
  and insertion on that short inbox row and commit together.
- Command: ID primary key, race ID, unique race sequence, user ID, inventory item
  ID, canonical request and request fingerprint, capabilities, timezone,
  accepted time, state, attempts, lease identity, terminal HTTP status/body,
  applied time. Indexed pending race/sequence and terminal cleanup time.
- One pending/running command per inventory item. Identical in-flight retries
  attach to the same result. Differing in-flight payloads return conflict without
  modifying the original command. A terminal rejection leaving the item HELD
  permits a new attempt; do not permanently deduplicate rejected attempts by item.
  A consumed item can replay its successful result for the identical request.

Claim eligible races, then a contiguous command prefix. Never skip a locked
earlier command within one race. One executor owns a race at a time across both
HTTP processes. Integrate command scheduling with the dedicated resolution
process's bounded capacity; a separate unbounded pool invalidates the comparison.
Retain the existing job-row write fence and generation/fingerprint checks for
resolution, lifecycle, membership and deadline writers.

Inside the gameplay commit transaction, after acquiring the existing race fence
and before mutation, validate the current command lease token and contiguous
sequence cursor under the inbox ownership lock. An expired/replaced worker must
be rejected even if it later obtains the race fence. Claims/recovery must obey
the same lock order. Test paused worker, lease replacement, and resumed stale
worker explicitly; only the current owner may terminalize commands.

## Batch algorithm and correctness boundaries

1. Claim an admitted prefix without waiting to fill an idle batch; cap both command
   count and estimated touched rows. Test batch caps 1, 4 and 8 as experiment
   parameters; record actual batch occupancy. These are not game-balance values.
2. Acquire locks in an audited stable order. Load required participants, effects,
   inventory and other dependencies once. Apply each command to an overlay, with
   a discardable per-command change set for expected rejection.
3. Preserve command order for jam, cleanse, Socks, Mirror, Decoy, inventory and
   step deltas. Preserve intermediate events/receipts even when final rows merge.
4. Preserve per-type current source-step/time semantics. For fresh-score commands
   reuse canonical scorer capture and validate input revisions. Do not change all
   commands to a new freshness rule or wait for the global upload queue to drain.
   Effect end/expiry and race expiry may force explicit boundaries.
5. Commit row mutations, item/coin consumption, individual terminal results,
   immutable event/receipt sources, and resolution handoff atomically. Avoid
   duplicate per-command race invalidations and redundant recomputation requests.
6. Release locks, wake durable delivery/projection work, return results. Retain
   required inventory correctness and all legacy response fields.

Unexpected SQL failure rolls back the entire uncommitted batch. Expected gameplay
rejections become individual results without poisoning peers. Retry recovery must
preserve randomized decisions, prevent duplicate effects/charges/receipts and
never let a poison command block the race forever. Do not label savepoint loops
over unchanged handlers as shared-state batching.

## Exact implementation path

1. Backend agent creates isolated checkouts of the release baseline and guarded
   experiment scripts under `scripts/experiments/powerup-command-comparison/`.
2. Write the HTTP/storage parity fixtures and baseline lock-contention tests
   first. Use existing `test/integration/setup.js`, command integration fixtures,
   and `power-outage-2000.test.js` patterns; no injected use-command doubles that
   bypass production transactions. Assert tests fail for the intended optimized
   property before changing an arm. Preserve all existing assertions.
3. Instrument experiment-only phases around backend `src/db.js`,
   `src/modules/powerups/commands/usePowerup.js`, and the public route in
   `src/modules/races/routes.js`. Preserve `onPerformanceContext` type when the
   result lacks a type field. Separate pool wait, race/participant lock wait,
   evaluation, commit, post-commit and total HTTP time.
4. Implement B in its own checkout after tracing every narrowed type's model and
   scorer dependencies. Test jam, expiry, duplicate use and concurrent resolution
   while retaining the existing race fence.
5. Implement C with experimental inbox SQL, admission, claim/recovery, and terminal
   response delivery. Reuse `raceWriteFence.js`, `raceResolutionWorkBudget.js`,
   `enqueueRaceResolution.js`, and `raceResolutionQueueV2.js` through explicit
   experiment adapters; do not copy scoring/gameplay rules into a second engine.
6. Refactor experiment D command evaluation into shared state plus ordered
   consequence planning, retaining individual handlers/rules. Adapt affected
   models in `src/modules/powerups/models/` and canonical scorer input/capture
   where required; document every intermediate DB flush.
7. Frontend agent audits frozen-contract compatibility and supplies contract
   fixtures for existing response/error shapes. No UI change is in scope; no
   mobile pending-job flow may be substituted to make the experiment pass.
8. Run the frozen harness on all arms, retain raw machine-readable evidence and
   report failures, limits, and incomplete arms honestly. Code-reviewer reviews
   experimental changes/harness before conclusions are presented.

## Test plan and acceptance criteria

Use two HTTP processes and one coordinated execution process at identical pool
and work-concurrency limits for every arm. Seed one 2,000-participant weekly race
and a second scenario of 100 twenty-player races with overlapping membership.
Measure powerups alone and with concurrent real step-sync HTTP traffic. Use a
fixed fixture seed and identical initial DB snapshots, then normalize generated
IDs/timestamps only where they are not the property under test.

Run isolated commands, prepared bursts, and 30-second sustained offered-rate
stages (2, 8 and 32 powerup commands/s; step uploads 0 and 16/s). These are local
load probes, not production forecasts. Freeze the emitted command mix and count
every unissued/rejected request. If the first calibration overloads, preserve its
result and add lower-rate stages rather than replacing it silently. Repeat valid
comparisons three times in alternating arm order with documented warmup/drain.

Functional coverage enumerates every live catalog type plus retired/unknown
rejections. Contention probes deliberately lock an unrelated participant to
prove whether Protein Shake, Trail Mix, and Shortcut wait on that row. For B,
unrelated participant locks must not block the audited self-only direct mutation;
post-commit waits are measured separately. Protect jam/defense correctness and
target redirection rather than narrowing Shortcut blindly.

Include ordered attack/defense/jam/cleanse chains, multiple hits on one shield,
reflection/redirection, shared-user wallet spend across races, transfers versus
use/discard, fresh-score decisions, expiry/settlement, legacy capability payloads,
same/different-payload retries, rejection followed by valid reuse, and worker
death before commit and after commit before response. Verify every accepted
command has one terminal outcome and matching effects, inventory, event and
receipt rows. Drain scoring, then check persisted/public state against the
ordered reference, before public reads can mask stale storage through repair.

Report p50/p95/p99 HTTP and commit latency by type, SQL statements/rows per
completed command, database CPU, connection/lock waits, batch occupancy, queue
age, resolution lag, offered/accepted/rejected/completed counts, and retry/discard
rates. CPU requires direct local DB process/container metrics; SQL elapsed time
is not CPU. Keep post-commit projection visibility separate from authoritative
effect application.

Correctness and compatibility gates must pass before recommending an arm.
Performance hypothesis: at identical accepted load, lower p95 HTTP latency and
DB cost than A without worse step-resolution backlog or starvation; report tradeoffs
if metrics diverge. No universal improvement claim from a faster isolated cast.
An arm that fails the full oracle remains failed even if sampled outputs match.
Do not ship anything from this experiment automatically.

The oracle must replay each arm's actual serialization order through the unchanged
baseline HTTP path, not assume concurrent A requests acquire locks in inbox arrival
order. Capture per-command random draws, eligible-pool ordering, relevant source
step revisions, and execution-time boundaries in semantic runs; replay the same
inputs without bypassing command transactions. Different valid execution orders
are not parity failures. Keep throughput runs unconstrained; use separate controlled
replay fixtures for boundaries/randomness and report replay instrumentation separately.

## Frontend, rollout and definition of done

Both mobile platforms retain the same Dart/API behavior. No visual placements,
build config or assets change; no UI-placement checklist is required. Run
`flutter analyze`; builds are not necessary for this code-free frontend audit.
The experiment adds no production migration or backfill. A production-ready
queue, migration/compatibility rollout and deployment require a subsequent
reviewed implementation decision based on the measured result.

## Revision log

- Gap pass 1: separated scheduling-only C from true batching D; included B to
  avoid crediting a queue for narrower locks; retained complex-command boundaries.
- Gap pass 2: specified ordered admission commit, rejected-item retry semantics,
  legacy timeout failure gate, process/pool parity, offered-load accounting and
  intermediate source events rather than only final score equivalence.
- User follow-up: added plan-then-lock targeted arm with complete shield/redirect
  dependency set, absent-defense writer audit and ordered restart on revalidation.
- Architect review: required fixes incorporated for pending expiry/recovery,
  lease-token validation inside commit, and actual-order/random/source-input
  replay. Split B locking from post-commit work and stage A/B before C/D following
  the review's recommendations. No prototype implementation has begun.

## Execution status — 2026-09-08

The authorized first local screening is complete. All four arms were measured
with concurrent real step syncs in a 2,000-player race and 100 smaller races.
Neither queue prototype improved latency or database cost over direct execution.
The complete acceptance matrix and concurrency oracle remain incomplete; failed
drain/publication gates prevent production acceptance. The implementation and
checksummed evidence are retained on backend branch
`experiment/powerup-command-queue`, in
`docs/powerup-command-comparison-evidence.md`. No queue deployment is authorized
or recommended by this result.
