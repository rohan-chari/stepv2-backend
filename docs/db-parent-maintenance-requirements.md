# Indexed global-event parent maintenance

Status: implementation approved and candidate retained after pinned-statistics benchmark review; production deployment remains separately authorized. Part of db-work-reduction-requirements.md. Research baseline 17c8983.

## Summary and user story

As a racer, every scheduled event must remain discoverable until its boundaries finish processing. Make that discovery proportional to relevant pending entitlements instead of repeatedly filtering historical processed rows.

## Research

`src/modules/steps/models/globalStepEvent.js:307–323` implements findLocalParentsForMaintenance; the minute scheduler calls it at globalStepEventScheduler.js:100. The exact predicate is local schedule mode AND (parent ends_at > now OR at least one entitlement with start_processed_at NULL OR end_processed_at NULL). Preserve the parentheses and sorting by starts_at.

Two-hour capture: 120 lookups, 16.38 seconds executor elapsed, 2.81 million shared buffer hits, 519 returned parent rows. Fresh read-only plan: five parents returned, 23 old-parent index probes each filtering about 993 rows, 23,424 shared hits, 31.15 ms. Existing event_id-leading recovery index does not exclude drained rows. Splitting the OR doubled accesses; gathering all pending event IDs once reduced buffers but did not demonstrate faster execution. Neither rewrite is selected.

## Scope and implementation

Add one partial B-tree index, preserving production query behavior:

```sql
CREATE INDEX CONCURRENTLY global_step_event_entitlements_pending_parent_idx
ON global_step_event_entitlements (event_id)
WHERE start_processed_at IS NULL OR end_processed_at IS NULL;
```

No time-dependent predicate, extra INCLUDE columns, removed indexes or query-shape rewrite. Benchmark the actual Prisma-generated SQL and normal planner settings; do not force index use. A small fixture may legitimately select a sequential scan.

Implementation order:

1. Extend real scheduler/HTTP lifecycle integration fixtures and add a synthetic test-DB performance fixture. Write failing structural index/large-history work assertions before creating the index. Existing behavior assertions should stay green; do not invent a behavior failure for an index-only change.
2. Benchmark original query on fixtures with current-size and 10× historical rows, mostly drained rows, many pending rows, future parents without entitlements, and concurrent boundary updates. Record warm/cold runs, median/p95, planning, root-level buffer accesses, actual rows/loops, write/WAL overhead and index bytes. Root buffer totals avoid double-counting nested plan nodes.
3. Add one new timestamped Prisma migration directory ending `_global_event_pending_parent_index`, with migration.sql containing only the standalone CREATE INDEX CONCURRENTLY above (no BEGIN/COMMIT, no IF NOT EXISTS). Follow the replayed concurrent-migration pattern in docs/database-work-reduction.md:68. Add exact index definition/validity verification and migration retry tests. No separate companion script or duplicate DDL runner. Replay with prisma migrate deploy on a disposable PostgreSQL 18 test DB before approving the migration; never mark it applied before verification.
4. The deployment procedure checks existing definition and validity before deciding to skip. IF NOT EXISTS alone is insufficient. State matrix: absent index follows normal migration; valid exact index with failed/unrecorded migration is verified then reconciled with only that migration marked applied; invalid index requires removal/retry. If an invalid same-name artifact remains, stop and document an authorized DROP INDEX CONCURRENTLY + retry sequence; never silently accept it or drop a healthy index.
5. Add deployment instructions with direct database connection (not transaction-pooled application URL), statement/lock bounds appropriate to index construction, pg_stat_progress_create_index monitoring, cancellation/invalid-index recovery, and exact post-build verification. A failed concurrent build is not successful migration completion.

Partial-index eligibility depends on the query predicate implying the index predicate; verify against actual emitted SQL. Concurrent index creation avoids blocking ordinary writes but entails extra scans and can leave an invalid index if it fails. PostgreSQL 18 references: [partial indexes](https://www.postgresql.org/docs/18/indexes-partial.html), [CREATE INDEX](https://www.postgresql.org/docs/18/sql-createindex.html).

## API/data/frontend compatibility

No endpoints, request/response JSON, statuses, policy fields, stored entitlements, defaults or backfill change. The index is additive and usable by old/new binaries; old writers maintain it automatically. Keep the index on application rollback unless measured write cost justifies separately authorized removal. Neither iOS nor Android requires a code change/build. Existing missing/null handling and every UI state remain unchanged; no UI-placement checklist applies. No feature flag or capacity change.

## Tests first and acceptance

Extend test/integration/global-event-enrollment-query.test.js and test/integration/local-global-step-event-entitlements.test.js via exported scheduler/boundary lifecycle plus HTTP responses. Add dedicated schema/plan tests where the property cannot be expressed by HTTP alone.

- Future parent with no entitlements; active parent; ended parent with only start pending, only end pending, both pending, both drained; legacy parent; equal ends_at boundary.
- Same row set and ordering before/after migration; boundary drain transitions remove only fully drained ended parents; no lost event opportunities or altered steps.
- Concurrent inserts/drains, old writer compatibility, migration retry/invalid artifact test on disposable PostgreSQL.
- Keep historical-work buffer ceilings in existing tests. Performance test must fail baseline for the intended absent index/work reduction; never weaken the ceiling to get green.

Acceptance: on the mostly-drained large-history fixture, at least 80% fewer root shared buffer accesses for parent discovery and no median/p95 read regression beyond declared benchmark noise. This is an engineering target, not a measured result. Before running benchmarks pin at least 10 paired runs, report spread, and treat >5% repeatable whole-tick or boundary-write p95 regression as material. Report pending-heavy and write-heavy tradeoffs; do not ship if material write latency/WAL regression outweighs observed read saving. No host-CPU saving percentage is promised.

Backend developer owns SQL/schema verification, tests, benchmarks and deployment docs. Dedicated *_test DB only; relevant integration suite and npm run test:unit, reviewer approval before done. Flutter analyze is part of the cross-repo done checklist, though native builds are unnecessary for this backend-only change. Production index creation needs separate in-the-moment deployment authorization; exactly two HTTP workers, staging off.

## Revision log

- Draft: selected predicate-matching index rather than unproven query rewrites; preserved ended-but-undrained lifecycle.
- Gap pass 1: fixed one migration execution path using the existing standalone concurrent Prisma migration convention; added actual prepared-query and write-cost validation.
- Gap pass 2: retained exact OR predicate, old-writer maintenance and failed-index recovery; no production build authorized.
- Architect review: APPROVE; suggestions incorporated for explicit migration-state reconciliation and predeclared regression thresholds.

## Final benchmark decision

Retain the index. Pinned ANALYZE of all source tables shows16,127→55root accesses for the mostly-drained27k fixture and155,214→55at252k. Pending-heavy27k work stayed4520; pending-heavy252k median work stayed9508, with one7527→9571regressing pair among variable plans. Start-boundary WAL increased~7%, with controlled paired p95 latency within5%. The normal observed mostly-drained read reduction outweighs that documented cost. Earlier cheap-plan observations with stale parent-table statistics are superseded and do not prove that pagination causes scan reduction. No planner force, flag, or added index variant is introduced. Watch backlog composition during matched post-release observation.
