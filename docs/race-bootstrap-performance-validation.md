# Race bootstrap performance validation

## Scope

Backend-only implementation of the five approved changes in
`race-bootstrap-performance-requirements.md`. No production/staging access,
deployment, capacity change, runtime flag, app binary, or economy change is part
of this validation. Unrelated capacity-harness and frontend edits are excluded.

## Evidence and limits

- On the same isolated compact HTTP fixture, deployed baseline `5bf9422`
  executed 34 SQL statements; the candidate executed 23. Both returned 7,555
  response bytes. Noncompact paged bootstrap went from 33 to 26 statements with
  the same 13,313 response bytes. These are query-count observations, not a
  sustained capacity benchmark or a production latency/CPU promise.
- Compact bootstrap performs no discarded details-page read. Progress and
  details reuse one aggregate; access/progress/details reuse one race-core
  read. Frozen unpaged responses and noncompact visible details pages remain.
- Real HTTP-captured cold standings queries were explained at 50, 500, and
  5,000 accepted participants. First-page scans visited 15 index entries in
  each case; observed local execution was approximately 0.03–0.05 ms with
  2–3 shared-buffer hits. The fixture is vacuumed/reindexed between field-size
  probes to remove artificial preceding-test bloat. PostgreSQL still chooses
  its plan; this does not guarantee an index scan for every production state.
- Page and maintained accepted count share one SQL snapshot, including empty
  and out-of-range pages. Legacy OFFSET costs O(offset + page size), not O(1).
- Money aggregates still scan race membership. The complete compatibility
  `participantUserIds` array remains O(N); this release does not make the whole
  endpoint constant-time. No historical step-sample replay was added.
- Durable pending DISPLAY_REFRESH coverage skips queue-row rewrites, including
  unchanged xmin, while retaining new viewers and source work. Processing-only
  scope cannot suppress a pending followup. Redis is not an admission authority.
- The expression index adds score-write maintenance. Membership-count triggers
  avoid counter writes/locks for score-only updates, but statement transition
  tables still have processing cost. In three rolled-back local EXPLAIN ANALYZE
  updates of a 5,000-row field, candidate times were 191.96/172.76/214.74 ms;
  the same fixture with the new index and UPDATE trigger transactionally
  disabled took 143.48/141.22/158.80 ms. The transition trigger itself took
  2.01–3.01 ms; most additional work is index maintenance. The index/trigger
  were restored by rollback after each comparison. This is a material
  read/write tradeoff, not a production CPU win: monitor both resolution
  writes and bootstrap reads after any separately approved deployment.

## Tests-first and compatibility verification

All database tests use isolated local databases ending in `_test`; setup guards
run before fixture/settings writes. Real HTTP routes, Prisma handlers and
PostgreSQL are used for the new behavior tests.

Final combined candidate run: **101/101 focused integration tests passed,
zero skipped**, across the three new suites and the five existing compatibility
suites listed below. Prisma schema validation and `git diff --check` also passed.

- `race-bootstrap-performance.test.js`: 20 passing cases. The corrected tests
  were also run on untouched `5bf9422`: 16 parity cases passed and the two
  intended query-elimination/reuse assertions failed. The new count-dependency
  fault-injection and viewer isolation cases were exercised on the candidate.
  Coverage includes old/full and compact payloads, one shared aggregate/core,
  progress failure fallback, denied/forfeited access, all-member IDs, HELD
  legacy money, pending/cancelled states, seeded finish rewards, fixed/team/solo
  payout stamps, zero/positive-step forfeits and 0–3 quick-race qualifiers.
- `race-bootstrap-persisted-standings.test.js`: 12 passing real-HTTP cases,
  including ordering/ties/finished rows, requester/page semantics, deep offsets,
  empty counts, membership moves/status/deletes, rollbacks, concurrent snapshots,
  bulk backfill/cascade and score writes while the counter is separately locked.
- Existing `team-races.test.js`: 11 passing cases.
- `race-bootstrap-refresh-coalescing.test.js`: 13 passing real-HTTP cases,
  including concurrent first/repeated reads, another viewer, processing versus
  pending work, source/timezone/artifact changes, terminal/retry states, preview
  read-only behavior, failed enqueue retry, Redis outage/admission, legacy
  unpaged viewers, real step-sync source input and lost-wakeup republishing.
  Paging + refresh + existing queue scope/lock-order and large-sync regression
  suites passed 56/56 in the separate queue test database.
- Existing details-paging, public-preview, payout-rounding and weekly-page
  projection integration suites: 45 passing, zero skipped; isolated Redis was
  available for cache scenarios.
- Focused progress/query/snapshot/payout unit coverage: 100 passing. These
  supplement, not replace, the HTTP integration tests.
- Shared Flutter client verification: 79 passing tests and clean `flutter
  analyze`; see `race-bootstrap-client-validation.md`. Both platforms retain
  the same API contract. No native builds were needed or claimed.

The independent money review found no predicate/serializer mismatch and ran
10,000 deterministic parity comparisons. Its required extra HTTP cases (fixed
team stamp, lobby, seeded reward, progress HELD compatibility, buyInAmount)
are included above. Independent code review returned SHIP with no remaining
blockers and the write-overhead measurement caveat above. It checked access isolation,
partial-vs-full preload safety, migrations, count/page consistency and durable
queue coverage. A pre-settings test-database guard issue found in review was
fixed before readiness.

## Existing failures, not hidden or weakened

The following failures were reproduced on untouched deployed `5bf9422` with the
same local database and environment. Existing assertions were not changed.

- `api-contract-payload-cleanup-contracts.test.js`: two paged-vs-full standings
  prefix/order assertions (lines 465 and 514; inspect current source for shifts).
- `race-leave-capability.test.js`: legacy team lifecycle expects LEAVE after
  join but receives FORFEIT because the race has already started (line 233).
- `redis-cache-c3-standings.test.js`: seven historical request-replay/worker
  artifact, refresh, snapshot-replacement and box-toast assertions also fail on
  baseline. Candidate and baseline had the same seven failures.

The repository-wide suite is not claimed green. Full suites were not run for
this scoped performance change. The above baseline failures are distinct from
the new integration suites and must remain visible in any release decision.

## Deployment considerations — approval still required

1. Apply the additive `20260906010000_persisted_standings_order_index` migration
   first. CREATE INDEX CONCURRENTLY is deliberately outside a transaction;
   existing application workers remain compatible while the index builds.
2. Apply `20260906010100_accepted_participant_counts`. Trigger installation and
   backfill are atomic under SHARE ROW EXCLUSIVE on race_participants, which
   blocks membership and score writers for the backfill duration. Reads remain
   available. A 5-second local lock timeout bounds lock acquisition; it does
   not cap the backfill execution duration. Measure/inspect table size and choose the deployment window before
   running it; do not equate an additive migration with zero operational cost.
3. Only after both migrations succeed, deploy backend code and preserve the
   existing two HTTP PM2 workers plus separately configured workers. No app
   update, feature flag or staging start is needed.

On concurrent-index failure, inspect PostgreSQL index validity first. Remove
only an identified invalid candidate index concurrently, mark that failed
migration rolled back, and retry deliberately. Never drop a healthy existing
index blindly. A failed transactional count migration must be confirmed rolled
back and resolved before retrying. Do not reload candidate code against a
partially migrated schema. An application rollback may leave these additive
objects installed; the previous code is compatible with them.

After fresh deployment authorization, monitor real bootstrap status codes,
progressError incidence, p50/p95/p99, query calls/rows/buffers, DB CPU, worker
queue age/retries and sync success. Compare equivalent traffic windows and
separate lock waiting from CPU; do not infer production improvement from local
test timings alone.
