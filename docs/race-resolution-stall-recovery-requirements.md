# Race resolution stall recovery and live diagnostics requirements

## Summary and user story

The production race-resolution worker can permanently stop making progress when
all of its in-process work-budget lanes are occupied by promises that never
settle. A database lease expiring makes the durable job reclaimable, but it does
not release the JavaScript lane or settle the scheduler's `Promise.allSettled`.
During the 2026-09-01 incident, a PgBouncer `server_login_retry` / Prisma `P2028`
connection event preceded two claimed jobs becoming stuck, after which mystery
box consequences stopped until the dedicated resolution process was restarted.

As an operator, I need a claimed job to emit live, bounded diagnostics and a
stalled resolution process to recover automatically, so one dependency incident
cannot silently stop all race calculations. As a racer, I need recovery work to
reconcile every overdue mystery-box threshold, even when a FULL recovery job has
no triggering user IDs.

This is a backend-only reliability and correctness change. It adds no client
feature and changes no public API.

## Incident evidence and decision

Production already emits `race_resolution_v2_claim` at claim time and detailed
terminal `race_resolution_v2` timing objects for jobs that commit, fail, discard,
or lose their fence. The terminal logs include claim readiness, claim, compute,
transaction, participant writes, side writes, box consequences, record success,
and post-task subphases. During the incident, terminal failures showed roughly
15–17 seconds in `transaction` alongside PgBouncer `server_login_retry` and
Prisma `P2028` errors.

The remaining blind spot is a claimed job that never settles: accumulated phase
timers are only printed at a terminal outcome, and the claim event does not say
which phase is currently active. The exact final await in the two stuck attempts
therefore cannot be proven from historical logs.

There is enough evidence to ship a generic fail-stop recovery mechanism now:
the worker-level invariant is that a claimed attempt must finish within a safe,
generous wall-clock bound. The recovery must not use `Promise.race` to release a
work-budget lane, because that would allow the timed-out promise to continue
executing and could exceed the capacity cap or write later. Instead, a watchdog
must log the active phase and terminate the dedicated resolution process. PM2
then starts a fresh process; connection teardown rolls back open transactions,
and the existing lease-token fence prevents a stale attempt from committing
after another worker reclaims the job.

This change should not wait for another incident. Monitoring alone would improve
the next postmortem but would not restore service. Exact-query diagnosis remains
a follow-up informed by the new live checkpoints if another stall occurs.

## Scope

1. Extend the existing phase timer to track the currently active phase and its
   monotonic start time without changing business behavior.
2. Emit privacy-safe live phase-transition/checkpoint events for claimed jobs.
3. Add one 60-second async-stall watchdog around each claimed resolution
   attempt in the dedicated resolution process.
4. On watchdog expiry, emit a synchronous final diagnostic and fail-stop the
   dedicated resolution process so PM2 restarts it.
5. Preserve the existing two-lane work-budget cap and scheduler semantics during
   ordinary operation.
6. Reconcile overdue mystery-box state for all eligible participants on FULL
   recovery, including jobs whose triggering-user arrays are empty.
7. Add queue-health telemetry for expired RUNNING leases, occupied/queued lanes,
   and age since the most recent terminal attempt.
8. Send deduplicated operational emails to `support@barastep.com` for sustained
   slowness and watchdog-caused restarts only.
9. Document production rollout, observation, and rollback commands.

## Non-goals

- Finding or optimizing the exact SQL statement responsible for the historical
  connection incident; the historical logs cannot establish it.
- Replacing PgBouncer, Prisma, PM2, or the queue architecture.
- Raising production HTTP or resolution-worker capacity.
- Starting staging without fresh authorization.
- Adding a feature flag, kill switch, rollout percentage, or temporary runtime
  toggle.
- Changing mystery-box thresholds, caps, odds, rewards, or economy rules.
- Automatically compensating arbitrary historical users in this deployment.
- Exposing operational diagnostics to mobile clients.
- Emailing on deployments, manual restarts, unrelated crashes, or every
  individual 10-second phase warning.

## Functional requirements

### R1. Stable attempt identity and claim event

Keep `race_resolution_v2_claim` as an additive structured event. Generate one
random UUID `bootId` at process boot and one random UUID per attempt; the global
`attemptId` is their bounded combination and remains unique across PID reuse and
host reboots. Add it to the event with the claimed job ID, race ID, lease expiry timestamp,
worker PID, and schema version. IDs are allowed in restricted server logs but no
user IDs, display names, raw steps, access tokens, query text, or payload bodies
may be logged. Every subsequent event for the attempt must include `attemptId`
so claim, checkpoint, terminal outcome, and watchdog expiry can be correlated.

### R2. Live phase state

`createRaceResolutionPhaseTimer` must retain:

- a nested phase stack and the innermost active logical phase;
- the active phase's parent, where present;
- the monotonic phase start time;
- total elapsed attempt time;
- the most recently completed phase;
- accumulated phase timings already emitted today.

Nested compute/nudge/handoff measurements may continue using their existing
subphase timing objects, but the live stack must expose nested transaction
phases such as `fenceAcquire`, `participantWrites`, and `boxConsequences` rather
than reporting only `transaction`. Phase state must be popped in `finally`,
including when a phase throws, and must reject non-LIFO stop calls in tests.

Emit `race_resolution_v2_phase` when entering each logical phase and once when
the innermost phase reaches **10 seconds**. To bound log volume, emit at most one
entry event and one slow event per phase instance per attempt. Do not emit
per-query logs. Each event includes `attemptId`, `activePhase`, `parentPhase`,
the bounded `phaseStack`, phase elapsed time, attempt elapsed time, queue
priority, resolution plan if known, worker PID, and monotonic elapsed values.
Wall-clock timestamps are correlation fields only.

### R3. Hard fail-stop watchdog

Start the watchdog immediately after a job is successfully claimed, and cancel
it only after the attempt reaches a terminal path and all required durable
handoffs have settled. The exact watchdog constant is **60,000 ms** and the slow
phase threshold is **10,000 ms**; neither is environment-configurable. The
60-second bound is twice the 30-second lease, more than twice Prisma's combined
10-second transaction acquisition wait plus 15-second transaction timeout, and
over three times the observed 15–17-second incident failures. Before coding is
accepted, the production-shaped largest-race test must complete below 30 seconds
at p99, leaving at least 30 seconds of watchdog margin. If it does not, optimize
or bound the work; do not raise the watchdog in implementation.

This is explicitly an **event-loop-responsive asynchronous-stall watchdog**.
Node timers cannot guarantee wall-clock termination if synchronous JavaScript
blocks the event loop. The incident involved unresolved asynchronous database
work, so that guarantee addresses the observed failure. Event-loop delay must
be included in queue health telemetry; a future independent OS supervisor is a
separate feature if blocking-event-loop evidence appears.

On expiry:

1. Emit `race_resolution_v2_watchdog` with outcome `expired`, `attemptId`, job
   and race IDs, lease expiry, active phase, active-phase elapsed time, attempt
   elapsed time, `phaseStack`, work-budget snapshot, PID, last completed phase,
   `authoritativeCommitCompleted`, and a snapshot of every sibling active
   attempt that the process exit will also abort.
2. Set a non-zero process exit code and terminate the dedicated resolution
   process after giving stdout/stderr only a short bounded flush opportunity.
3. Do not call `recordFailure`, release a lane for reuse, claim another job, or
   continue application work in that process.

The fail-stop watchdog is armed only when `STEPS_PROCESS_ROLE=resolution`, and
that dedicated role is the only production role allowed to call `claimNext` or
execute resolution work. Targeted compatibility calls from HTTP paths must
enqueue the required generation and poll its durable state; they must never call
`processOneUnbudgeted`, `processRace`, `workBudget.run`, or otherwise execute the
resolution promise in the HTTP process. This preserves the frozen-client
contract that a due boundary may settle before the response while ensuring an
HTTP request timeout cannot leave a never-settling resolution lane behind.
Polling is bounded by the existing request deadline and returns the existing
compatible response/fallback when the dedicated worker does not settle in time.
Cron and migration roles are enqueue-only as well. Production startup must
continue to run exactly one dedicated resolution process and exactly two HTTP
workers. Integration tests must prove HTTP and cron roles neither claim jobs nor
invoke the exit seam.

### R3a. Post-commit recovery boundary

The watchdog remains armed after `recordSuccess` only if every required effect
that follows the authoritative commit is already durable or independently
retryable. The implementation must preserve this matrix:

| Post-commit work | Required recovery contract before watchdog may cover it |
| --- | --- |
| Effect expiry/state convergence | Durable post-task/intention keyed by race and generation, reclaimable after lease expiry |
| Notification decisions/delivery | Durable notification intent with existing dedupe and independent retry; process-local delivery is best-effort, not exactly once |
| Event publication/post-commit hook | No authoritative state; loss on process death retains its existing best-effort contract |
| Overtake nudges | Durable intent/task before considering the attempt fully handed off |
| Snapshot/placement/post-task handoff | Durable generation-keyed task with expired-lease recovery |
| Mystery-box state sync | Authoritative rows/feed events committed inside the fenced core transaction, not deferred |

If any required durable handoff is currently created only after success, move
that handoff before watchdog cancellation or give it an independently reclaimable
generation-keyed source. A post-commit watchdog expiry logs
`authoritativeCommitCompleted: true`; the core job is not reclaimed, while its
durable tasks retry independently. Tests must cover expiry both before and after
the authoritative commit.

### R4. Durable safety after restart

No new database state is required. Existing transaction rollback, lease expiry,
fresh lease tokens, job-row fencing, and idempotent/deduplicated side effects are
the correctness boundary. Tests must prove that a stale pre-restart lease token
cannot commit after a reclaimed attempt succeeds, and that mystery-box/feed
effects remain exactly once.

The production resolution process must use static PM2
`exp_backoff_restart_delay: 1000` (capped by PM2) and retain `autorestart: true`.
Alert after 3 watchdog exits in 15 minutes; do not silently stop recovery after
a fixed restart count. Do not apply this restart policy change to the two HTTP
workers or alter their count.

### R5. FULL recovery reconciles mystery boxes

The current transaction invokes `syncRacePowerupState` only for triggering
participants, and `boxEffectiveStepsByUser` is likewise computed only for the
resolver's supplied `userIds`. The implementation must use this exact scope
matrix:

| Accepted plan/envelope | Box-effective computation and consequence scope |
| --- | --- |
| Claimed `FULL` | All accepted participants that can be overdue |
| Any planner/fence fallback that executes `FULL` | Same as claimed `FULL` |
| `ARTIFACT_REUSE` whose accepted artifact represents a FULL envelope | All accepted participants that can be overdue, sourced from the accepted artifact or one canonical bulk computation |
| `STEP_SYNC_*` / `DEPENDENCY_CLOSURE` | Existing bounded triggering/closure participant scope |

For FULL scope, produce canonical box-effective totals for every candidate in
the resolver result; passing `null` because the original trigger list was empty
is forbidden.

Before the first participant write, acquire advisory locks for every selected
candidate in stable ascending user/participant ID order. Avoid a per-roster N+1:
bulk-read each candidate's cursor, existing inventory/queued state, and any
other roll prerequisites once; preselect only participants whose accepted
box-effective total reaches their next threshold; then invoke a bulk-capable
canonical sync that preserves `racePowerupStateSync` semantics. Any random roll
must retain the canonical deterministic/idempotent boundary and dedupe keys.
The design must not issue one inventory query plus multiple roll prerequisite
queries for every member of a large roster.

Preserve the canonical queue cap and forfeiture behavior; this fix restores what
current product rules award and does not grant extra compensation. A failure
rolls back totals, cursor movement, powerup rows, feed rows, and job success
together. The largest supported FULL recovery must complete its transaction
below the existing 15-second timeout and the whole attempt below 30 seconds p99
in the production-shaped test.

### R6. Queue-health telemetry

Extend the existing periodic queue-health event with:

- number of RUNNING jobs whose lease is expired;
- work-budget active, queued-core, and queued-post counts;
- milliseconds since the last terminal resolution outcome;
- age of the oldest claim without a correlated terminal outcome in this process;
- event-loop delay;
- current-process boot timestamp and nullable time since terminal outcome.

On fresh boot, `lastTerminalAgeMs` is `null`, not zero. After a terminal outcome
it is monotonic within that process. Repeated watchdog exits are computed from
correlated structured logs or PM2 restart metadata outside the restarted
process; a process-local counter must not be presented as durable. Telemetry
queries must be bounded and indexed, must not run inside a resolution
transaction, and must not include user data. Alarm conditions are: any expired
RUNNING lease while both lanes remain occupied, no terminal outcome beyond the
watchdog bound while claimable work exists, or repeated watchdog exits.

### R7. Support email alerts

Use the existing authenticated Google Workspace/Gmail delivery mechanism and
canonical recipient `support@barastep.com`. Extract a shared internal transport
only if necessary; the feedback endpoint, message format, delivery semantics,
and frozen-client behavior must remain unchanged.

Email delivery must never run in the watchdog callback or delay worker exit.
The resolution role may only write privacy-safe markers; no Gmail/OAuth code may
load or run there. The production spool is the deploy-persistent absolute path
`/var/lib/step-tracker/operational-alert-spool`, outside the release tree, owned
by the backend service account with directory mode `0700`; markers are `0600`,
at most 8 KiB, and the directory holds at most 1,000 markers. Provision and
verify this directory before restarting the resolution process.

Marker schema v1 permits only the documented scalar diagnostic fields and a
globally unique `attemptId`. Filename is
`v1-<alertType>-<bootId>-<attemptUuid>.json`; every segment is strict lowercase
ASCII/UUID, and import rejects path separators, unexpected fields, non-regular
files, hard links, and symlinks. Creation uses a same-directory exclusive temp
file opened with no-follow semantics, one bounded write, file `fsync`, atomic
`rename`, and directory `fsync`. The cron importer unlinks only after the
deduplicated outbox insert commits, then syncs the directory. Spool-full/write/
sync failure emits a bounded synchronous stderr fallback diagnostic; a watchdog
still exits from `finally`, while a slow-alert marker failure only loses that
notification and never changes resolution behavior.

At every resolution-process boot, atomically create an immutable
`resolution-boot-v1-<bootId>.json` marker in the same spool using the same
bounded write/fsync/rename/directory-fsync protocol. It contains only schema
version, global boot UUID, PID, and boot timestamp. Cron correlates each watchdog
incident to the chronologically earliest boot marker newer than that incident;
until one exists, the alert remains pending. Multiple restarts therefore cannot
overwrite correlation history. Boot markers never create alerts by themselves.
Cron removes them in bounded batches only after every older incident marker has
been durably correlated, with a 90-day minimum retention safety window.

Only the exact `STEPS_PROCESS_ROLE=cron` production process imports markers and
dispatches mail. Import is a bounded batch of 25 every 30 seconds, single-flight,
and never gates resolution startup or consumes a race-resolution work-budget
lane. Malformed files are quarantined with a bounded count and logged; database
or permission failure retries on the next cron tick. HTTP, migration, legacy
`all`, staging, and resolution roles may not import or dispatch. The 30-second
slow path also writes only a marker and never awaits a database operation.

The dispatcher is single-flight, claims one row per iteration with a **60-second
delivery lease**, releases its
claim transaction and every DB lock/connection before building MIME, OAuth, or
calling Gmail, and uses the existing bounded OAuth and 15-second provider
timeouts. It completes the fenced terminal update before claiming another row.
The lease must exceed the measured worst-case MIME + OAuth + Gmail + finalization
path by at least 15 seconds.

Two alert types exist:

1. **Sustained slow processing:** create an alert when an attempt reaches **30
   seconds** without a terminal outcome. The 10-second phase warning remains
   log-only. Include environment, observed time, attempt/job/race IDs, active
   and parent phases, phase/attempt elapsed time, queue lag, work-budget state,
   expired-lease count, and a concise operator action. Send at most one slow
   email per attempt with a global 15-minute cooldown. Admission is exact: the
   cron importer takes a fixed Postgres transaction advisory lock, reads the
   newest admitted slow alert, and inserts only when database `now()` is at
   least 15 minutes later. Concurrent attempts inside the window are suppressed
   and structurally logged; they do not create a later digest. At the exact
   boundary, the first transaction wins and later contenders are suppressed.
2. **Watchdog recovery:** import only a marker written by the **60-second
   `race_resolution_v2_watchdog` expiry**, then send one email stating that this
   watchdog restarted the worker. Include the same diagnostics, whether the
   authoritative commit completed, previous and new PID/boot time, and lease
   status. Deduplicate permanently by alert type plus `attemptId`.

Do not infer watchdog recovery from PM2 restart count. Deploy reloads, manual
restarts, OOMs, host reboots, and unrelated crashes lack a valid watchdog marker
and send no email. Subjects are:

- `[Bara Prod] Race resolution slow (30s)`
- `[Bara Prod] Race resolution watchdog restarted worker`

Delivery failure must never block resolution, HTTP, or unrelated cron work. It
emits a structured result. Each dedupe key produces a deterministic RFC
Message-ID for diagnosis only; Gmail does not promise idempotency from it.

The delivery state machine is exact:

- MIME/config/OAuth failures proven to occur before the Gmail POST return to
  `PENDING` with backoff of 1, 5, 15, then 60 minutes, through 5 total attempts.
- An explicit Gmail response classified `unavailable` may retry on the same
  schedule because receipt was explicitly rejected.
- Once the Gmail POST begins, network errors, timeout, malformed/empty 2xx,
  lease loss, or any result whose acceptance cannot be proven becomes terminal
  `UNCERTAIN` and is never sent again.
- A valid accepted response becomes terminal `ACCEPTED`.
- An expired `SENDING` lease becomes terminal `UNCERTAIN`, never `PENDING`.
- A fifth proven-retryable failure becomes terminal `FAILED`.

No feature flag or configurable recipient is introduced.

## API contract

No endpoint, request, response, status code, or authentication behavior changes.
Older and current iOS/Android clients continue to upload steps and read race and
powerup state through the existing contract. New structured log fields are
additive internal telemetry only.

## Data model and migrations

Add an internal `OperationalEmailAlert` outbox table with UUID `id`, unique
ASCII `dedupeKey` (max 160), `alertType` (max 32), bounded JSON `payload`, state
`PENDING|SENDING|ACCEPTED|UNCERTAIN|FAILED`, `attempts`, `notBeforeAt`, nullable
`leaseToken`/`leaseExpiresAt`, nullable `acceptedAt`, nullable `lastErrorCode`,
nullable `terminalAt`, and timestamps. `lastErrorCode` is ASCII max 64;
serialized payload is at most 8 KiB; attempts are constrained to 0–5. Defaults
are `state=PENDING`, `attempts=0`, and `notBeforeAt=now()`. Add claim ordering
index `(state, notBeforeAt, id)`, expired-send reconciliation index
`(state, leaseExpiresAt, id)`, and terminal cleanup index `(state, terminalAt,
id)`. Claims use `FOR UPDATE SKIP LOCKED`; completion and retry updates require
the current lease token. `FAILED` means retry attempts were exhausted and is
terminal. After 90 days, bounded cron cleanup scrubs diagnostic payload and
delivery-error detail but permanently retains the dedupe key, alert type, state,
and terminal timestamp as a tombstone. Never delete tombstones or pending/
sending rows.

The migration is additive with no backfill. Existing queue and powerup tables
and `FeedbackEmailAttempt` remain unchanged. Old backend processes ignore the
new table and clients never observe it.

## Frontend plan

No Flutter code, screen, widget, asset, or build configuration changes. Both iOS
and Android continue using the existing API. No UI-placement plan is required.

## Implementation plan

1. In `src/modules/races/jobs/raceResolutionQueueV2.js`, first add injectable
   monotonic clock, timeout scheduling, process-role, diagnostic-flush, and
   fail-stop seams used only by tests.
2. Extend `createRaceResolutionPhaseTimer` with nested-safe live state and
   bounded phase event emission while preserving the stable terminal schema.
3. Add the attempt context immediately after `claimNext` succeeds. Ensure all
   terminal branches cancel the watchdog in one outer `finally`.
4. Implement watchdog expiry as fail-stop, never as lane release or detached
   continuation.
5. In `src/modules/races/services/raceResolutionWorkBudget.js`, expose only the
   existing read-only snapshot required by diagnostics; do not change the cap.
6. Change box-consequence scope in `raceResolutionQueueV2.js` so FULL recovery
   reconciles the accepted full roster. Continue using
   `src/modules/races/services/racePowerupStateSync.js` as the single writer.
7. Extend the existing queue-health probe/event rather than introducing a
   second polling loop.
8. Add the atomic watchdog spool writer/importer and durable operational-alert
   outbox. Reuse or extract the Google Workspace transport without routing
   operational alerts through user feedback attempts.
9. Add a cron-owned fenced alert dispatcher with Gmail uncertainty handling,
   permanent dedupe, exact 15-minute slow-alert suppression, bounded cleanup,
   and expired-`SENDING` reconciliation.
10. Update the production PM2 ecosystem file with static restart
   backoff while preserving two HTTP workers and the dedicated resolution role.
11. Update the deploy/runbook documentation with log queries, watchdog alarm
   interpretation, and rollback instructions.

## Tests-first plan

Tests must be written and observed failing for the intended reason before
business logic changes.

### Integration tests

Use a dedicated local `*_test` PostgreSQL database only. Never point these tests
at production.

1. Extend `test/integration/race-queue-v2-single-writer.test.js` through its real
   queue/DB path: create a FULL job with empty triggering-user arrays and an
   overdue participant, process it, and assert the canonical powerup row, cursor,
   and feed consequence are committed exactly once.
2. Reclaim an expired attempt with a fresh lease token and prove the stale token
   cannot commit participant, powerup, feed, or job-success writes.
3. Exercise a real claimed job with an injected never-settling dependency and
   assert claim and live-phase diagnostics identify the active phase before the
   injected fail-stop seam fires. Assert no subsequent claim occurs in that
   process.
4. Use a real child process with the dedicated test database: claim and stall
   inside a real transaction, let the real 60-second watchdog terminate the
   child, verify the child exits non-zero and the transaction rolls back, then
   start a fresh worker, reclaim after lease expiry, and assert one final
   successful resolution with no duplicate mystery-box/feed consequences.
5. Exercise the targeted compatibility path through real HTTP and the cron
   enqueue path; prove both enqueue/poll without calling `claimNext`, executing
   resolution work, occupying a work-budget lane, or invoking the exit seam.
6. Cover watchdog expiry after authoritative success and prove every required
   post-commit effect is either already durable or recovered by its independent
   task runner.
7. Through the real test transport boundary, prove a 30-second attempt creates
   one slow alert, repeats inside the cooldown are durably suppressed with no
   later digest, and sending never occupies the resolution lane.
8. Kill a real resolution child by watchdog, start a fresh worker, import its
   marker, dispatch exactly one watchdog email, and prove manual/non-watchdog
   restarts create none.
9. Cover Gmail accepted, rejected, network-uncertain, retryable, expired-lease,
   and concurrent-dispatcher cases with the specified dedupe behavior.
10. Prove concurrent 15-minute cooldown admission at, before, and after the
    boundary; fresh boot/PID reuse cannot collide attempt or dedupe IDs.
11. Prove one-at-a-time delivery near the 60-second lease boundary cannot be
    reconciled as expired while active, and a retained marker cannot resend
    after its 90-day payload scrub because its dedupe tombstone remains.

### Unit/structural tests where integration cannot express the property

1. Fake-time tests for watchdog cancellation, single expiry, nested LIFO phase state,
   bounded checkpoint volume, and the short diagnostic flush deadline.
2. A structural PM2 topology guard proving exactly two HTTP workers and one
   dedicated resolution worker remain configured.
3. A source guard proving watchdog expiry cannot call work-budget release and
   continue processing; process fail-stop is mandatory.
4. Queue-health metric tests for expired leases and terminal-age alarms.
5. Spool validation, size, atomicity, alert-body privacy, and source guards.
6. Structural role tests prove only exact production `cron` imports/sends,
   resolution only writes markers, and HTTP/migration/legacy `all`/staging do
   neither.

Run `npm run test:integration` only after confirming `DATABASE_URL` names the
dedicated test database. Run focused suites first, then `npm run test:unit` and
the full integration suite once.

## Backward compatibility and rollout

This backend-only additive change is compatible with every shipped app version:
no public contract changes and the schema change is additive. Deploy the
migration before restarting application processes. Deploy order is backend only;
there is no app release dependency.

Before production deployment:

1. Verify focused and full test results and code review.
2. Provision `/var/lib/step-tracker/operational-alert-spool` outside the release
   tree with the specified owner/modes; verify atomic write/import using a
   non-emailing canary marker before restarting any production process.
3. Apply the additive migration, then verify PM2 topology in the artifact:
   exactly two HTTP workers, one resolution
   process, cron unchanged, staging stopped.
4. Establish production baselines for queue lag, transaction p95/p99, longest
   completed attempt, and restart count. The production-shaped largest-race p99
   must be below 30 seconds; the constants remain 10 seconds slow / 60 seconds
   watchdog.
5. Obtain fresh explicit user authorization for the production deploy/migration/
   restart.

After deployment, monitor claim-to-terminal correlation, phase durations,
expired leases, queue lag, `P2028`, PgBouncer errors, watchdog events, PM2 restart
count, HTTP latency/errors, and mystery-box creation for at least one full peak
traffic window. A single watchdog recovery is an incident signal, not proof the
mechanism is unhealthy. Repeated watchdog exits require rollback or immediate
dependency remediation.

Rollback is an application-code rollback plus a serialized restart of both HTTP
workers, the dedicated resolution process, and cron. Claims must first be
disabled, every pre-disable attempt must be outlived through the watchdog
boundary, and every new-format post-task must drain before the old artifact can
run. Leave the additive operational-alert table in place during rollback;
dropping it is destructive and unnecessary. Preserve logs and unimported spool
markers before rollback. Disable/remove no spool path until its markers have
been preserved or imported; the directory may remain safely provisioned after
code rollback.

## Acceptance criteria and definition of done

- A claimed never-settling attempt produces a correlated claim, active-phase,
  and watchdog-expiry record without exposing user data.
- The stalled process cannot release its lane and continue; it terminates and
  PM2 restarts it.
- After lease expiry, a fresh worker safely completes the job, while the stale
  token cannot write.
- FULL recovery with empty triggering-user arrays reconciles overdue mystery-box
  state using canonical cap/forfeiture rules and exactly-once feed effects.
- Normal jobs retain current concurrency and terminal timing schemas.
- A 30-second sustained attempt produces no more than one rate-limited support
  alert, and a watchdog-caused restart produces exactly one post-restart alert.
- Deploys, manual restarts, OOMs, host restarts, and unrelated crashes produce no
  watchdog email.
- Gmail failure cannot delay watchdog exit or race resolution, and uncertain
  delivery is not blindly duplicated.
- The spool survives release replacement, uses the specified fsync/rename
  protocol, and a full/broken spool cannot prevent watchdog termination.
- Only the exact production cron role imports and sends alerts; the dispatcher
  holds no DB lock or connection during Gmail work.
- Exactly two production HTTP workers remain configured; staging remains stopped
  unless separately authorized.
- No public API or frontend behavior changes, including for old app versions.
- Focused tests, `npm run test:unit`, and test-database integration suites pass.
- A code-reviewer finds no correctness, compatibility, or test-quality blockers.
- Production deployment occurs only after fresh explicit authorization.

## Open questions

None. The slow-phase threshold is 10 seconds and the async-stall watchdog is 60
seconds. Failure of the largest-race performance gate blocks implementation
approval rather than changing these constants ad hoc.

## Revision log

- 2026-09-01, initial draft: combined live phase diagnostics, fail-stop recovery,
  queue-health telemetry, and the empty-trigger FULL mystery-box correction.
- 2026-09-01, gap pass 1: rejected `Promise.race` lane release because it cannot
  cancel Prisma work; specified process termination, rollback, lease fencing,
  role guards, and restart-storm protection.
- 2026-09-01, gap pass 2: separated FULL versus incremental box scope, preserved
  canonical cap/forfeiture rules, added claim-to-terminal correlation, bounded
  log volume, old-client compatibility, test-database safety, topology checks,
  explicit deploy authorization, and migration-free rollback.
- 2026-09-01, architect review: required innermost nested phase diagnostics;
  fixed the slow/watchdog constants at 10/60 seconds; limited the guarantee to
  event-loop-responsive async stalls in the dedicated resolution role; added a
  post-commit durability matrix, exact FULL/fallback/artifact scope, ordered
  locks and bulk candidate reads, static PM2 restart backoff, durable restart
  metrics, and a real child-process kill/rollback/reclaim integration test.
- 2026-09-01, architect re-review: prohibited HTTP/cron resolution execution;
  those roles now enqueue and bounded-poll only, preserving frozen-client timing
  while reserving claims, work-budget lanes, and fail-stop recovery for the
  dedicated resolution process.
- 2026-09-01, support-alert amendment: added a 30-second rate-limited slow alert
  and watchdog-marker-only restart alert to `support@barastep.com`; specified a
  bounded local crash spool, durable fenced email outbox, Gmail uncertainty
  handling, additive migration, and tests proving unrelated restarts never mail.
- 2026-09-01, support-alert architecture pass: fixed the persistent spool path,
  permissions, size/count limits, atomic fsync protocol, cron-only isolation,
  exact 15-minute suppression, globally unique attempt IDs, complete Gmail
  uncertainty state machine, outbox bounds/indexes/retention, and rollout order.
- 2026-09-02, implementation review: reload HTTP and cron claim paths before the
  dedicated resolution owner, and require a full watchdog quiescence plus
  new-format post-task drain before application-code rollback.
