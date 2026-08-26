# Notification domain-event producer matrix

The executable source of truth is
`src/modules/domainEvents/services/producerMatrix.js`. CI compares that
registry with the visible-handler registry and parity fixtures. Every active
producer row uses an owning command/job transaction plus `DomainEventOutbox`;
no active row uses the process-local event bus or an after-commit callback as
its durable source.

`RACE_BUYIN_CHANGED_V1` is an explicit `DORMANT_COMPATIBILITY_ONLY` exception.
Buy-in edits are permanently rejected after the legacy hold drain, so there is
no current business command that can append this event. Its typed V1 projector
and literal parity fixture remain only to preserve compatibility with any
already-recorded/manual recovery event. It has `owner: null` and
`durableSource: null`; it must not be counted as producer-path outbox coverage
unless a separately approved revisioned buy-in operation is introduced.

`TOURNAMENT_COMPLETED_V1` is also `DORMANT_COMPATIBILITY_ONLY`. The 2026-07-25
D1 behavior deliberately retired that fan-out: the champion receives
`TOURNAMENT_CHAMPION_V1` and every losing player receives exactly one
`TOURNAMENT_ELIMINATED_V1`. The old handler and typed projector remain inert
compatibility paths, but `advanceTournament` does not emit this event and the
matrix therefore records no owner or durable source.

The V1 event names, immutable payload/audience facts, deterministic event and
delivery keys, recipient rules, eligibility timing, cooldowns, expiry,
suppression outcomes, and golden copy sources are the literal rows in the
approved `docs/notification-domain-isolation-requirements.md` producer matrix.
This companion is intentionally concise so the detailed approved matrix does
not drift from a second hand-maintained copy.

Operational ownership is grouped as follows:

- Social: friend requests and race chat.
- Races: invites, starts, completion/cancellation, reminders, placement/team
  changes, and high-multiplier crossings.
- Powerups: committed offensive powerup uses.
- Tournaments: invite, round, result, completion, and cancellation commands.
- Rewards/referrals: committed referral reward grants.
- Reminders: daily reward, milestone, and daily mover observations.
- Steps: committed local or legacy global-step-event activation.
- Feedback: committed staff support replies.

Projection terminal outcomes are `COMPLETED`, `SUPPRESSED` with a bounded
reason, or `FAILED_TERMINAL` after 12 attempts. Scheduled rows preserve their
existing expiry. Visible work uses Inbox/outbox; race-message and placement
silent work uses the persisted `SILENT_REFRESH` kind and never creates Inbox
rows.

Checked-in integration evidence exercises every active event name through its
real request, command, or job and then runs the real Postgres projector into
Inbox. Tournament invite/start/round/result/champion/cancellation paths are
covered in `feature-batch-2026-07-25-tournament-pushes.test.js`; friend/race
lifecycle, placement/team reminders, daily mover, scheduled reminders, and
support are covered by the notification isolation and scheduled-race suites;
powerup, referral, global-event, and high-multiplier paths remain in their
own domain integration suites. Literal parity fixtures separately lock every
row's eligible copy and deleted-recipient suppression contract, while the
tournament cancellation and daily-mover public-path tests also exercise real
deleted-recipient projection suppression.

## Operations and recovery

The cron owner logs a health snapshot once per minute with pending counts by
event type, projection counts by state, separate schedule/Inbox-outbox backlog,
and terminal-failure totals. A notification backlog alert is emitted after five
consecutive snapshots over 60 seconds old, or immediately for any
`FAILED_TERMINAL` row. These signals never participate in domain health checks
or stop gameplay schedulers.

Recovery order is:

1. Correct the projector/Inbox/provider dependency while leaving domain rows
   untouched.
2. Inspect the bounded event ID/type and error code; do not log payloads,
   support text, or device tokens.
3. Replay only explicit terminal IDs with
   `npm run domain-events:replay -- --event <uuid>` or
   `--projection <uuid>`. The command is idempotent and changes coordination
   state only; production use remains a separately authorized data write.
4. Confirm the event returns to `PENDING`/`PROJECTING`, then verify one Inbox
   alert/outbox row at the canonical delivery key.

Initial bounds are fixed in code at 100 audience rows per expansion, a hard
maximum of 50 recipient projections per repository claim, runtime claims of at
most the four-row concurrency bound, and a five-second tick budget. `EXPLAIN`
on the local integration database confirms both claim scans
use the `(status, available_at, ...)` indexes before primary-key joins.

The 2026-08-25 local release-gate run used the checked-in integration test and
a 1,200-recipient event against the dedicated local Postgres test database.
With projection concurrency four it completed in 3,546 ms; projection
queue-to-completion p95 was 3,615 ms and p99 was 3,830 ms. A concurrent
cron-style `SELECT 1` probe had 0 ms maximum observed latency, Postgres reported
eight connections and zero waiters, and no pool wait/timeouts occurred. This is
within the acceptance bounds of p95 under 10 seconds, p99 under 30 seconds,
cron probe under 5 seconds, no waiters, and no more than the 20-connection pool.
The same recovery suite passed with Redis entirely unset; the public friend
request handoff also passed against a temporary local Redis instance explicitly
using database 15. These are representative local measurements, not production
load-test results.

A disposable clean database applied the two domain-event migrations before an
unrelated later referral migration was unavailable in this worktree. The five
domain-event primary/foreign-key columns were verified as PostgreSQL `uuid`,
and a Prisma schema diff filtered to the domain-event tables was empty.
