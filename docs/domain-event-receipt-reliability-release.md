# Domain-event receipt reliability — release evidence

## Status

Implementation candidate; **not yet cleared for production**. No production or
staging deployment, migration, data repair, or capacity change was performed
during this verification. Production operations require fresh user approval.

The user approved the single-deployment revision on 2026-09-11. It is now
implemented and has passed combined code review. The full-suite comparison
has completed, but the integration gate remains red; this document does not
declare the candidate production-ready.

A separate `automatic-v1` sweep freezes its own database-clock cutoff
after all migrations; existing manual `historical-v1` progress is not adopted
as coverage proof. Every historical apply command shares the automatic
admission lock/capacity check without advancing automatic progress. Stopping
manual commands **does not pause automatic discovery**. Investigate an alert
and seek approval for an application rollback if needed; there is no new
runtime pause switch. The domain-event nightly broad backfill is removed;
notification-schedule backfill and receipt-aware retention are preserved.

The approved requirements live in the frontend repository at
`docs/receipt-reliability-requirements.md`. This is backend-only: existing iOS
and Android binaries keep their existing API contracts and need no release.

## What changes

- Single and bulk event writers create/validate the immutable FINAL receipt in
  the same transaction as the outbox event. Rollbacks publish neither record
  nor a queue wake. FINAL describes the recorded envelope, **not delivery**.
- Entitlement reconciliation preserves original receipt IDs/timestamps when
  restoring a missing nonterminal outbox row. Terminal receipt-only replays
  are not restored or double-counted. Colliding envelopes fail closed.
- A deferred, indexed compatibility check enqueues committed missing or
  PROVISIONAL receipts from old binaries. Normal finalized appends do not
  insert recovery jobs. The existing provisional and terminal-state triggers
  remain; the new trigger does not implement digest logic.
- Historical discovery pages the source `(created_at,id)` index **before**
  filtering receipts, at most 500 source rows per call. Automatic and manual
  checkpoint pages persist progress atomically with candidate insertion. Every
  apply path acquires the automatic admission lock and defers if 500 active
  candidates already exist, including future retries and live leases. Capacity
  probes are independently index-limited in one statement snapshot; receipt
  lookups use bounded indexed lateral probes. Lock contention fails the page
  without advancing its cursor. Fresh compatibility gaps remain accepted.
- Recovery runs in the existing dedicated cron process, not either HTTP
  worker. Claims independently bound due work and expired leases; at least
  one fifth of slots prefer fresh gaps over historical ones when available.
  A drain handles at most 10 candidates sequentially. Backlog timers are paced
  by one second; Redis-free fallback polling runs every 60 seconds. Repair
  precedes historical discovery on every tick. FINAL-only source pages still
  schedule another tick until discovery completes; exhausted history is not
  rescanned. A discovery failure does not roll back completed repairs.
- Source/audience reads are batched. Each repair still uses its own short
  transaction and locks/rechecks the source lifecycle before finalizing; this
  is bounded per-candidate work, **not** a fully set-based repair write.
- Claims use two-minute leases and token-fenced completion. Retries stop after
  eight attempts: 1m, 5m, 30m, 2h, then up to 6h with bounded jitter. Deleted
  sources and identity mismatches are quarantined. Candidate evidence is
  retained, including terminal errors; no destructive cleanup is introduced.

## Schema and release order

Apply these additive migrations before starting the candidate backend:

1. `20260911130000_domain_event_receipt_recovery`: recovery table, uniqueness,
   state constraints, due and lease indexes.
2. `20260911131000_receipt_discovery_index`: `CREATE INDEX CONCURRENTLY` on the
   existing outbox. Do **not** wrap this migration in a transaction. If index
   creation fails, inspect migration/index validity before deciding how to
   repair it; do not blindly mark the migration applied.
3. `20260911140000_receipt_discovery_checkpoint`: durable discovery cursor.
4. `20260911150000_receipt_recovery_compat_enqueue`: deferred compatibility
   enqueue trigger and fresh-work due index.

All four were successfully rehearsed, in final file order, on a newly created
dedicated local PostgreSQL 18 test database. Existing migrations were not
changed. Regenerate the Prisma client through the normal backend build flow.
Retain exactly two production HTTP workers and the existing process roles.
Do not start staging just to verify this feature.
Follow `DEPLOY_RUNBOOK.md` for preflight migration inspection, explicit Prisma
generation, and the safe production reload wrapper. Do not substitute a bare
PM2 restart/reload or run migrations during application rollback.

## Local verification (2026-09-11)

- 71 receipt-focused integration tests passed: real HTTP old-client contracts,
  canonical digests, rollback, duplicate/collision behavior, root transaction
  ownership, entitlement restoration, discovery checkpoint/fairness, lease
  fencing, source deletion/completion races, retry bounds, and query budget.
  New single-deployment cases prove autonomous scheduler progress, late commits,
  old manual-checkpoint gaps, future-retry/live-lease backpressure, concurrent
  manual/cron admission, deferral, atomic cursors, trigger readiness, bounded
  index plans, and retention while repair is incomplete or quarantined.
  This includes a table-lock regression proving source/audience reads honor
  250ms lock and 2s statement budgets in a read-only, bounded transaction;
  failed reads leave reclaimable leases, not false successes. Red/green logs:
  `receipt-single-source-timeout-red.log`, `receipt-single-focused-complete.log`.
- The combined run includes a production-mode CLI test against a validated localhost
  `_test` database with an isolated environment: read-only preview, shared
  apply admission, independent automatic cursor, and a one-connection role.
  No production connection was attempted (`receipt-single-production-cli.log`).
- Latest full unit run: 3,406 passed, zero failed. The 71-test combined receipt
  run includes 13 audit tests. Imported resume totals are now explicitly
  unverified/ineligible for release evidence, and remote TLS configuration
  preserves the existing backend connection behavior. Forged-token CLI and
  unconnected driver-configuration regression tests pass; no remote TLS
  connection was attempted.
- Combined implementation review: SHIP, no blockers/issues/nits. Frontend
  compatibility review: no app changes required; both platforms accounted for.
- Wider affected-path run: 127 passed, four failed. All four were reproduced
  at unchanged HEAD `9b08e5f`: PostgreSQL error-code expectation, dependency
  closure expectation, missing Home cache, and missing display artifact.
  Private Redis resolves the Home-cache case and advances the artifact case
  to a separate existing boundary-worker failure. Assertions were not changed;
  this result is **not** a clean integration gate.
- Broad integration diagnostic run completed: 3,450 tests, 3,349 passed,
  100 failed, one pre-existing skip, zero cancelled (24m34s). It started before
  the last focused fixes and additional tests. Representative baseline results
  below do not classify all 100 failures; do not treat the full gate as green.
- Frontend `flutter analyze`: no issues. No Flutter source/build configuration
  changed; no platform artifacts were built or uploaded.
- Bulk append measurement on the local database: 2 events and 100 events both
  required 9 client-visible SQL round trips, of which 3 mentioned receipts.
  This excludes server-side trigger statements, WAL, and downstream delivery
  work; it is not a claim of measured production CPU reduction.
- A separate local 10,000-candidate claim test selected all three intended
  partial indexes (fresh due, general due, expired lease). The plan was
  obtained from the actual claim SQL using non-executing `EXPLAIN`.

Clean-HEAD diagnostic subsets also reproduced admin count expectations,
missing billing seed/Redis prerequisites, mystery-box response/counter
expectations, wardrobe invalidation, and completed-summary Redis failure.
The broad catalog failure did not reproduce in four HEAD runs. Candidate runs
with final migrations and private Redis returned 8/9, 9/9, and 9/9: the failure
was reversed inventory ordering with both expected items present, on an
unchanged query ordered only by millisecond-precision `createdAt`. This is
intermittent under isolated execution; a timestamp tie is plausible but was
not captured. No deterministic receipt regression was established. This does
not classify every other broad-suite failure or make the gate green.

Tests used explicit localhost URLs ending in `_test`, empty `REDIS_URL`, and
test-only referral HMAC values. The repository's `test:integration` script
hardcodes a shared local database, so its migration, identity-index, and Node
test stages were run separately against isolated databases. The latest full
candidate clone initially lacked the separate identity-index setup; this was
corrected for the focused rerun described below. No integration
test was pointed at production.

### Final full-suite comparison

Both runs used isolated local databases, sequential test-file execution, and
the same test-only environment. Unchanged HEAD was `9b08e5f9b50250cae431177e67e73e24dd6b2b34`.

| Run | Tests | Passed | Failed | Existing skips | Duration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Unchanged HEAD | 3,413 | 3,313 | 99 | 1 | 24m19s |
| Candidate | 3,483 | 3,382 | 100 | 1 | 24m29s |

Logs: `receipt-single-full-head-baseline.log` and
`receipt-single-full-candidate.log`. Neither run cancelled tests. The candidate
file list predates the additional production-mode CLI test; the final focused
71-test run includes that case.

Comparing exact test file/name pairs finds 96 shared failures, four
candidate-only failures, and three HEAD-only failures. Shared names establish
baseline reproduction, not that every stack/underlying cause is identical.
Two candidate-only schema failures came from the omitted existing identity
index companion script, not a receipt migration: all six schema-file tests
passed after applying that script to the dedicated local test database
(`receipt-single-candidate-delta.log`).

The other two candidate-only cases were a race-worker callback receiving a
different race ID than its fixture expected, and a deferred-nudge fallback
expecting one delivery but observing zero. Both passed when run alone on a
freshly created, fully migrated local database (`receipt-single-fresh-delta.log`).
That isolated pass does not erase the broader failure or prove its root cause.
A fresh-database rerun of both complete race-worker files returned 52 passed
and 19 failed out of 71: the callback race-ID case passed, but the nudge
fallback failed again (`receipt-single-fresh-delta-fullfiles.log`). The latter
remains an unresolved suite-context difference; it is not classified as an
inherited failure simply because it passes in isolation.
Final reviewer inspection identified a wrong-race claim in this nudge case
too: its fixture race committed generation 1, whereas the final fallback call
processed a different race at generation 3 with zero changed rows (fresh full
file log lines 3117 and 3142). It was not duplicate processing of the fixture.
The existing `fixtureRaceId` worker seam offers a controlled diagnostic without
weakening assertions; that fixture change has not been made. No concrete link
to changed receipt code was established. Final release review: **FIX FIRST**
because the required integration gate is red; earlier implementation-only
review approval is not production clearance.
No scoring, nudge, economy, or protected test assertion was changed to obtain
green results. The full gate is not waived by focused success or by the
unchanged baseline also being red.

## Historical repair operations (approval required for production)

The audit command `npm run domain-events:receipts:audit -- --db=<target>
--cutoff=<ISO-timestamp>` reads at most 500 rows/page and 10 pages/invocation,
shared across source and queue scans. Resume with the report's `--resume`
token; it preserves cutoff, database identity, cursors, and observed totals.
Exit 0 means both observations exhausted; 2 means page-limited; 1 means an
error, with committed read progress retained when available. Unvisited counts
are null. A fresh repeat census must omit `--resume`. Independent pages are
not a point-in-time snapshot, and tokens are operator input, not trusted proof.
Resumed reports are always marked `totalsProvenance: imported_unverified` and
`releaseEvidenceEligible: false`. Independently reconcile captured page reports
before using a multi-invocation census as operational acceptance evidence.

Choose and record an immutable source cutoff. Start with a read-only discovery
page through `npm run domain-events:receipts:discover -- --db=<target>
--cutoff=<ISO-timestamp> --limit=500`. The JSON contains `scanned`, `discovered`,
`nextCursor`, and `exhausted`; a full-size page is not proof of completion.

For discovery commands in a production-mode shell, explicitly select a bounded
existing role: prefix the npm command with `STEPS_PROCESS_ROLE=cron
DATABASE_POOL_MAX_CRON=1`. This is the manual command's connection budget, not
a new process or a change to the running cron service. Unprefixed discovery
is intentionally not added to the role-less production CLI allowlist. Do not
set `NODE_ENV=test` against production to bypass that guard. The read-only
audit uses its own single PostgreSQL connection and does not load the app pool.

After production data-write approval, the same command with `--apply` and no
explicit cursor advances the durable `historical-v1` checkpoint. Repeat bounded
calls until exhausted. A restart reuses the saved cutoff even if a different
cutoff is passed later. Explicit `--after-created-at` and `--after-id` must be
supplied together and select manual, non-checkpoint discovery instead.
All apply variants share automatic admission. `deferred: true` means no source
page was admitted and no cursor advanced; it is not exhaustion or an error.
Normal deployment needs no manual discovery loop: the cron owns automatic
catch-up through its independently initialized `automatic-v1` checkpoint.

Do not run unbounded loops or increase worker concurrency to accelerate drain.
Monitor the existing DigitalOcean database metrics and query statistics,
recovery age/error counters, and bounded operator reports. Do not run
production `EXPLAIN ANALYZE`. Keep SQL error codes sanitized; do not copy event
payloads, user data, or database credentials into release logs.

## Single-deployment acceptance

The new backend replaces the domain-event nightly broad scan immediately with
automatic bounded recovery. After that one deployment, verify:

- Historical backlog drained or explicitly classified with terminal evidence.
- At least 24 hours with no newly missing receipts.
- Queue p95 age below 10 minutes; no unexplained terminal failures.
- Two consecutive **complete**, zero-eligible censuses for the recorded cutoff.
- Comparable before/after CPU, query work, WAL, and queue-lag observations.

A timeout, partial/resumed page, or empty current page is not a zero census.
Queue age above 30 minutes or any new missing receipt fails the gate. The
operator must investigate and seek approval for any rollback; stopping manual
commands does not stop automatic discovery. There is no new runtime kill
switch or feature flag.

The above evidence is postdeployment operational acceptance, not a second
code-release requirement. Local tests are not historical-production drain
proof. No production repair or observation has been performed in this turn.

## Rollback

If a rollback is authorized, use only the previously verified backend binary
while retaining the additive schema and compatibility triggers. Do not drop
receipts, candidates, cursors, or indexes as part of an application rollback.
An old binary can keep emitting provisional rows and temporarily run its old
scan; automatic recovery resumes when the candidate is restored. Every actual
production rollback/restart still needs explicit approval.
