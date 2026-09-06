# Database work reduction: acceptance contract

This is a permanent backend optimization, not a feature rollout. HTTP response
contracts, scoring math, immutable capture retention, race fencing, PM2 topology,
and production pool limits remain unchanged. Production remains at concurrency 4.

## 1. Capture compaction

- Persist one next-due deadline; ordinary summary wakes only probe that row.
- Serialize due work across processes in the same transaction as compaction.
- Preserve the 128-row journal/child collection bounds and all pin safeguards.
- Continue full batches promptly; idle maintenance runs at a one-minute cadence.
- Include maintenance's deadline in the existing summary wake coordinator so
  collection progresses without a user upload and survives a restart.
- A failed/rolled-back pass must not advance the deadline or discard history.

## 2. Global-event recovery

- Replace historical anti-join scans with indexed outstanding candidates for
  missing v2 summary work, missing entitlement outbox events, and ready v1 summaries.
- Source database triggers append independent signal IDs for every writer,
  including old application binaries and raw-SQL repair tools. Receipt writes
  retire the exact indexed completion key. No process-local negative cache.
- Hints have no parent foreign keys: appending a hint after locking a source row
  must not acquire a new parent lock during concurrent account deletion. Indexed
  deletion triggers remove hints; a durable 128-ID cursor removes rare orphan
  hints inserted after parent cleanup, including future-dated hints. A fixed
  upper-ID watermark per sweep guarantees wraparound even under continuous
  arrivals, so skipped locks and late commits are revisited.
- Maintenance validates and compacts at most 500 observed signals per pass,
  deduplicating only that page. Eligible signals are updated in place; concurrent
  new signal IDs survive. Candidate reads deduplicate only after a bounded LIMIT.
  Maintenance commits before any repair transaction can write source/outbox rows.
- Revalidate authoritative eligibility at processing time and preserve existing
  unique fences, summary versions, local deadlines, and all-zero outcomes.
- Bootstrap pre-migration sources through bounded, durable primary-key cursors.
  Parent-event edits use bounded per-event refreshes, not a synchronous full-user fanout.
- Receipt deletion, schedule revision changes, final-impact transitions, retries,
  and concurrent runners must not lose repair work. Rollback must roll back candidates.
- V1 source triggers signal even when other impacts are still pending. Otherwise
  simultaneous final transitions in separate transactions can both see the other's
  old pending row and lose the only recovery wakeup. Maintenance checks all-final.
- Completed historical populations must not be rescanned on every empty tick.

## 3. Resolution input reuse

- Reuse compatible planning inputs during computation within one worker attempt.
- Reuse only when the same input fingerprint is protected by the existing fresh
  transaction fence. Never cache/reuse the fence read itself.
- Preserve event eligibility, per-user membership cutoffs, future boundaries,
  closure dependency scope, and source-version cache invalidation.
- Fall back to existing reads for unprotected or incomplete snapshots. Retry
  attempts must never reuse a rejected attempt's input data.
- Real HTTP -> queued worker -> HTTP progress tests must prove fewer reads and
  identical results. Concurrent input changes must still reject stale commits.

## Deployment and evidence gates

TDD: record pre-fix integration failures, then pass focused integration and
regression tests. Additive SQL migrations precede code reload; old binaries can
continue using their existing functions/queries while new database triggers run.
Review migrations and implementation before calling this ready. No production
deployment is authorized by this implementation goal.

## Migration/deployment procedure (requires separate approval)

1. Apply the seven additive migrations with `prisma migrate deploy` before code
   reload. Four are standalone `CREATE INDEX CONCURRENTLY` statements on existing
   tables. Do not wrap those files in an outer transaction. All other new indexes
   are on new hint/cursor tables. Clean local migration replay has been exercised.
2. A concurrent index build can fail and leave an invalid index. Do not blindly
   retry or use `IF NOT EXISTS`: it can silently keep an invalid index. Inspect
   `pg_index.indisvalid`, `indisready`, `pg_get_indexdef`, and Prisma migration
   status for the exact failed migration/index. If invalid, drop only that index
   concurrently, mark only its failed migration rolled back using
   `prisma migrate resolve --rolled-back <migration>`, then retry deploy. If the
   index is already valid with the exact expected definition but migration
   bookkeeping failed, mark only that migration applied after verification.
3. Reload the approved production topology without changing concurrency (4),
   pool budgets, API worker count, or starting staging. Old binaries remain
   compatible with the new schema, triggers, and existing compaction function.
4. Verify sync acceptance, completed resolution generations, recovery errors,
   outstanding hint/seed cursor progress, and capture maintenance deadlines.
   Compare clean five-minute statement deltas and database CPU at similar traffic.
   SQL-count improvements in integration tests are not a production CPU forecast.

The local test database was rebuilt to replay revised **unreleased** migrations.
Only disposable test fixtures were removed; production/staging were not accessed.

## Evidence and known baseline failures

- TDD logs: `three-optimizations-compaction-red.log`,
  `three-optimizations-recovery-red2.log`, `three-optimizations-reuse-red.log`
  under the local temporary directory. They show repeated compaction, historical
  recovery discovery/immutable receipt collision, and 4–8 duplicate compute event
  reads respectively before their fixes.
- Additional failing concurrency regressions reproduced parent-key lock inversions
  before their fixes (`three-optimizations-recovery-fk-red.log` and
  `three-optimizations-source-fk-red.log`). They exercise real PostgreSQL sessions.
- Local-event integration assertions at lines 1365 and 1594 fail identically on
  clean deployed baseline `aefa53c`: expected FULL but got DEPENDENCY_CLOSURE;
  expected one display-artifact read but got two. No assertions were changed.
- The 477-player scaling assertion at line 576 also fails identically on that
  baseline: 483 power-ups rather than 1,908. The watchdog timing checks pass.
  This existing behavior is outside these three optimizations and was not changed.
- Continuous-arrival orphan cleanup also reproduced a failing regression before
  the fixed sweep watermark (`three-optimizations-orphan-watermark-red.log`).
- Final focused integration run: **211/211 passed, zero skipped**, across 18
  files covering all three changes, immutable captures, retention, summaries,
  dependency closures, scoring parity, and concurrent transaction fences.
  Evidence: `three-optimizations-integration-release.log`.
  The isolated release checkout repeat also passed **211/211**, zero skipped:
  `three-optimizations-clean-release-integration-final.log`.
- Targeted unit/structural fallback checks: **80/80 passed**, zero skipped.
  Evidence: `three-optimizations-unit-release.log`. These supplement, rather
  than replace, the real HTTP/worker/PostgreSQL integration coverage.
- Clean replay of all migrations, Prisma schema validation, and whitespace
  checks passed. Independent final code review: no blockers, issues, or nits.
- The broader unit run is **not green**: 3,340/3,351 passed in the working tree.
  Five failing cases also fail on clean baseline `aefa53c` (balance structure,
  delivery scheduling, two entitlement-materialization mocks, review prompts).
  Six additional failures concern unrelated uncommitted capacity-harness source
  inventory/runtime-control metadata; those changes are excluded from this release.
  The clean baseline full run itself has seven failures, including two capacity
  checks. Evidence: `three-optimizations-full-unit.log` and
  `three-optimizations-baseline-full-unit.log`. No existing assertions were
  weakened, skipped, or removed to conceal these failures.
- The isolated release checkout's full unit run passes **3,323/3,330** with the
  same seven failing cases as the clean baseline; the three added unit checks
  pass. Evidence: `three-optimizations-clean-release-unit2.log`.
- Repeating integration tests exposed physical fixture residue in the buffer
  assertion: DELETE-based cleanup left 23,692 dead hints until autovacuum.
  The query-plan fixture now performs test-only `VACUUM (ANALYZE)` before
  measurement. All index-choice, row-count, and <100-buffer assertions remain
  unchanged. The result applies to 20,000 live future hints after vacuum, not
  arbitrary production bloat. No production vacuum/configuration is added.
  Independent review accepted this normalization with no remaining issues.
