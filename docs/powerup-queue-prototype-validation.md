# Local powerup command prototype: implementation and functional evidence

This is an experiment on reviewed participant-lock changes `9b2cfb8`, compared
with unchanged production-release commit `3b241ff`. It is not installed by normal
application startup, has no release flag, and has not been deployed. Performance
measurements and their limitations are recorded separately by the workload
harness. These functional results do not establish production capacity.

## Contract

The public powerup-use route, optional fields, request capability semantics,
timezone, terminal success envelopes, X-Ray's top-level `ok`/`scan`, active-impact
receipt envelope, and existing gameplay errors remain unchanged. A queued use
does not return HTTP 202 or a successful admission acknowledgement.

The approved experiment adds a pre-admission HTTP 503 busy response with exactly
`{"error":"Powerup service busy. Please try again."}`. Conflicting in-flight
requests for the same item return HTTP 409; matching requests attach to the same
durable result. A rejected race-earned HELD item permits a corrected command.
Successful matching retries replay the committed response after required durable
response work finishes. Request capability Sets are captured as arrays; workers
do not substitute the user's stored capabilities.

## Implemented execution

`scripts/experiments/powerup-command-comparison/queue.js` exports
`installQueueSchema()` and `createPowerupCommandQueue()`. The factory supports
the experiment arms `SINGLE` and `BATCH`, batch caps 1/4/8, a shared work-budget
instance, and a default unfinished-command capacity of 256. Its methods are
`execute`, `enqueue`, `wait`, `claim`, `runClaim`, `tick`, and `snapshot`; metrics
are available on `metrics`. HTTP processes call `execute`; dedicated worker
lanes call `tick`. The default budget is the actual process-wide race resolution
work budget, not an additional unbounded pool.

Installation validates localhost and a database name ending in `_test`. It
creates three experiment-only SQL tables outside Prisma's migration directory:

- `experiment_powerup_admissions`: short, serialized sequence allocation.
- `experiment_powerup_inboxes`: per-race execution lease and completed cursor.
- `experiment_powerup_commands`: canonical requests, admission deadline,
  execution attempts, results, random draws, and durable response work.

Admission's allocation row is separate from the gameplay ownership row. A
review regression initially showed that sharing those rows held up both the
busy race's admissions and other races behind the global capacity latch; the
separate-row fix passed the same test. Unfinished capacity includes committed
successes still awaiting required response work.

The real singleton use command runs inside the real scoped Prisma transaction.
Execution acquires the existing race fence, validates ownership/cursor under the
inbox lock, then preserves the command's normal lifecycle, inventory,
participant, and effect locks. Pending commands have a database-clock five-second
start deadline. Execution attempts are recorded before gameplay begins; at most
three failed executions occur before a terminal internal-server error. Seeded
command RNG quantiles are stable across retries and final draws are recorded.

Expected gameplay rejections roll back a per-command savepoint and discard its
in-memory consequences/callbacks. The normal best-effort redeemed-item refund
is retained. Unexpected SQL failures roll back the whole batch. A failing
command becomes an execution boundary so a healthy preceding command is not
repeatedly failed alongside a poison command.

The canonical resolution enqueue commits atomically with gameplay and the
durable result. Inventory repair and progress invalidation are persisted as
post tasks. Successful HTTP delivery/replay waits for `post_done`. Post claims
are recovered even if no gameplay commands remain. Each post execution acquires
the race fence, validates its current token and deadline, and commits canonical
inventory changes with `post_done` in a bounded transaction. Failures remain
durable with attempts/error information and retry later; they do not convert a
committed use into a false unused-item error.

## What D actually batches

D reuses race/roster reads across these six safe self-effect types:
Compression Socks, Mirror, Umbrella, Decoy, Stealth Mode, and Runner's High.
Relevant participant/user/race mutations invalidate cached relation reads.
The complete batch item/participant lock set is acquired in stable order.
Feed-producing commands collect feed consequences and actually insert them
together at commit. Silent defense activations remain silent.

Effects are still written immediately inside the transaction, so subsequent
commands see active defenses and effects through the existing models. There is
no copied second gameplay engine. All other types enter the same scheduler but
create single-command execution boundaries, including direct score changes,
attacks, cleanses, inventory transfers, and commands requiring fresh scoring.
This is a deliberately limited batching prototype, not full shared-state
batching for every powerup. The two-command Runner's High test proves actual
repeated-read elimination and one multi-row consequence insert. Merely routing
a complex command through the scheduler is not counted as batching it.

Existing per-command durable scoring enqueue behavior is preserved within the
batch commit; resolution triggers are not yet consolidated into one canonical
enqueue. Legacy event hints and optional multiplier alerts retain their existing
best-effort behavior. Queue-row polling occurs every 20 ms without holding a
database connection between polls; its SQL cost belongs in the comparison.

## Test evidence

Tests were added before the queue module existed and failed to load the missing
implementation. The admission-lock regression additionally failed on the
implemented original shared-row approach before its fix. Existing assertions
were not weakened. Two initially incorrect new fixture assumptions were corrected
against the existing source: Socks/Mirror activation deliberately has no feed
row, and an outage jam rejects with HTTP 409, not HTTP 400.

Final dedicated local PostgreSQL runs:

| Suite | Result |
|---|---:|
| `powerup-command-queue.experiment.js` | 55/55 |
| `powerup-command-replay.experiment.js` | 2/2 |
| Existing use/upgrades/powerups command suites | 67/67 |

The 55 HTTP/storage tests cover all 41 schema powerup enum values through the
same scheduler, terminal transport/storage agreement, request retries/conflicts,
expiry, replaced leases, database failure rollback, poison-command isolation,
actual separate-worker death before commit, and actual worker exit after commit
before required response work. The after-commit test verifies the durable
resolution job, withheld response, preserved queued box, replacement promotion
to a visible mystery box, identical successful retry, and no duplicate domain
event creation. This all-enum test is transport and inventory consistency
coverage, not exhaustive gameplay-rule coverage for each enum.

The two replay tests execute 15-command semantic chains through C and D, read
the actual committed inbox sequence and random draws, restore identical fixture
rows, then replay that sequence through a child HTTP server loaded from
unchanged `3b241ff`. Its RNG capture is instrumented before application loading;
handlers, models, and transaction paths are unchanged. The chain includes:

- Socks followed by two Shortcuts.
- Mirror and then Decoy interception of further Shortcuts.
- Outage, a jam-rejected Shortcut, Cleanse, then another Shortcut.
- Protein Shake, Trail Mix, Quick Rinse, and X-Ray.

Normalized responses and persisted participants, inventory, effects, and feed
consequences match. Player/item identities, target attribution, effect status,
step deltas, and durations remain part of the comparison; generated IDs and
absolute wall-clock timestamps are normalized. D's replay is a controlled
sequential chain, while a separate test exercises a real multi-command batch.

These explicitly invoked `.experiment.js` suites are outside the normal
`*.test.js` discovery pattern, so the standard integration runner does not try
to run their strict dedicated-database/reference prerequisites. Run them only
on the dedicated local queue test database. Example:

```sh
DATABASE_URL="postgresql://$USER@localhost:5432/steps_powerup_queue_unit_test" \
NODE_ENV=test SESSION_TOKEN_SECRET=queue-test-only \
node --test --test-force-exit test/integration/powerup-command-queue.experiment.js

DATABASE_URL="postgresql://$USER@localhost:5432/steps_powerup_queue_unit_test" \
NODE_ENV=test SESSION_TOKEN_SECRET=queue-test-only \
POWERUP_REFERENCE_ROOT="$REFERENCE_CHECKOUT" \
node --test --test-force-exit test/integration/powerup-command-replay.experiment.js
```

The reference checkout must have HEAD `3b241ff`. Both tests require the normal
schema migrations and matching generated Prisma client already installed. The
experiment installer creates its own test tables. No production migration was
added or run.

## Remaining gates

These tests are not the complete approved production oracle. In particular,
they do not exhaustively cover every type's decision tree, concurrent upgrades
sharing one wallet across races, every transfer/discard race, all settlement and
source-step revision boundaries, or reference replay of unconstrained concurrent
traffic. The workload harness must separately verify source-step arithmetic,
resolution drain, full-trigger handling, and the fifteen-second client deadline.
If those gates fail on any arm, report the arm as failed even if the selected
functional tests pass. Do not infer a queue recommendation from these tests or
from isolated successful requests.
