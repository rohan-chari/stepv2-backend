# Cron work bounds verification

## Scope

- Exclude write-once window memberships before checking auto-enrollment activity.
- Replace sample replay and daily-row hydration with indexed existence queries.
  Preserve positive-only activity, ET completed-day boundaries, DST, lower-only
  daily date bounds, and review/new-account/race-creation exemptions.
- Use stable SQL retention cutoffs with existing collection indexes.
- Run historical collectors on existing recovery ticks, continuing full pages
  on subsequent bounded wakes. Keep pin release, orphan cleanup, and live
  mutation-journal compaction on every wake. No new queue or release flag.
- Limit generic notification projection concurrency to two, without changing
  scheduled-event batch size, pool size, topology, or transaction timeouts.
  This bounds one projector's fanout; it does not reserve connections globally
  or guarantee zero contention across independent cron jobs.

No API contract changes, client-version changes, or new migrations. Both mobile
platforms continue using the same endpoints. No production operations performed.

## TDD evidence

The real PostgreSQL cron callback regressions first demonstrated:

- Six historical collectors on two empty normal wakes (expected zero).
- Volatile retention cutoff predicates.
- Activity queries on already elected daily/weekly membership retries.
- 1,000 returned sample rows per first-election query (expected at most one
  activity indicator for the one candidate).
- Four concurrent notification queries (expected at most two), after real HTTP
  friend requests.

Review added fail-then-pass regressions for routine live-journal compaction and
continued full retention pages. Real election fixtures cover both spring/fall
DST transitions, both sample boundaries, an overlapping earlier-day sample,
zero/negative samples, daily lower bound and future-local-date activity, missing
activity, new accounts and review exemptions. Terminal pin tests retain every
existing assertion and additionally exercise non-recovery wakes.

## Verification results

Dedicated local `steps-tracker-integration_test` database was verified before
running tests and updated with already-existing repository migrations.

- Targeted integration group: 92/92 passed, zero skipped (eight files, including
  the nine new regression cases, capture cleanup/scoring and inactivity).
- The nine new regressions also pass with the production-shaped four-connection
  cron pool against local PostgreSQL (not production-sized CPU hardware).
- Code review: initial live-journal cadence blocker corrected; final verdict SHIP.
- Wider integration group: 90/94 passed. All four failures also reproduce on
  clean deployed baseline commit `661756c`:
  - Cross-user capture does not publish within the existing 400-claim assertion.
  - Placement producer test expects a missing team-lead event.
  - Daily-mover producer test expects two events but observes zero.
  - Retention test expects an obsolete exact return object shape.
- Full unit command: 3,330/3,341 passed. Five failures reproduce on clean
  `661756c` (balance structural guard, delivery scheduler contract, two
  entitlement test doubles, race-list opportunity test). Six other failures
  identify unrelated, pre-existing uncommitted capacity-workflow changes:
  participant mutation inventory and missing capacity environment metadata.
  Those user-owned files and existing assertions were not modified.

These results do not mean the full suite is green or prove production CPU/latency
improvement. Existing wider failures require an explicit release decision.

## Production verification after separate authorization

Keep two HTTP workers and existing cron/resolution owners and pool sizes.
Compare clean, reset-free windows: daily enrollment errors and transaction
duration; cron pool queued checkouts and transaction-start errors; retention
query calls/rows/buffers; journal and capture backlog age; notification delivery
latency and retries; successful sync intake/resolution. Confirm both empty-work
efficiency and continued progress under backlog. SQL execution time is not CPU.
