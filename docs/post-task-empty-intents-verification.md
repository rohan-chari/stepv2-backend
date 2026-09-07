# Empty post-task query optimization — 2026-09-07

Production read-only census at 23:26:08 UTC found 998 of the latest 1,000
post-tasks had zero recorded intents. This suggests frequent unnecessary
bookkeeping, but the optimization checks actual intent rows rather than trusting
the recorded count.

Both task claim paths return an indexed EXISTS check for intents. A confirmed
empty task skips intent recovery and listing. Snapshot completion is folded into
the existing task completion and receipt transaction, retaining lease ownership,
pending-intent checks, and snapshot state guards. Nonempty tasks and callers
without the new metadata retain their existing path. Priority snapshot handling
continues to persist completion immediately.

## Verification

The new real HTTP-to-worker integration fixture failed before implementation
with 90 SQL queries, including one empty-intent recovery update, one intent
list read, and one standalone snapshot completion update. After implementation,
the same fixture executes 87 queries, with all three redundant statements absent.
Public race progress and the durable task receipt remain correct.

Five new integration cases cover the empty path, actual pending and attempting
intents despite a stale zero count, expired snapshot attempts, and receipt
collision rollback. Tests use a dedicated local PostgreSQL test database and
ephemeral Redis; no integration writes target production.

All 60 distinct relevant tests passed: five new integration tests, five storage
tests, eleven runner tests, and 39 receipt, expiry publication, handoff, model,
and migration regression tests. Existing assertions were preserved. Independent
code review found no blockers, issues, or nits. git diff --check passed.

Evidence logs: /tmp/post-task-red.log, /tmp/post-task-green.log,
/tmp/post-task-safety.log, /tmp/post-task-regressions.log.

## Compatibility and release

No schema, dependency, API, or client changes. Existing iOS and Android clients
receive the same responses. No new runtime flags. Production deployment is
pending fresh approval; CPU savings have not yet been measured. The three-query
reduction alone does not establish that the database can reach 70% idle.
