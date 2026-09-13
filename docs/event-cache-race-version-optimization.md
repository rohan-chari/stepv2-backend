# Event-cache race-version optimization

Status: implemented and reviewed locally on `perf/event-cache-race-version`; not deployed. Base: `7d38ce9`. Review verdict: SHIP, with the ordered deployment below. This is not a claim that the entire repository test suite is green.

## Behavior and scope

The existing protected planning cache previously rebuilt a local event witness by reading up to 8,193 impacts, joining entitlement revisions, sorting JSON and hashing it. The monitored combined race/roster query made 3,748 calls, spent 87.6 seconds in execution and accessed 3.50 million buffers over approximately 95 minutes. Those production numbers include roster work and waits; they are not entirely removable or a CPU measurement.

The reader now folds an indexed `race_event_fingerprint_versions` lookup into the same roster query. PostgreSQL maintains a race incarnation, revision and exact impact count. Node hashes that small identity, and the existing event cache uses isolated `event-fingerprint:v4` keys. Cold fills read the version and event data from the same SQL snapshot. The three warm planning SELECTs and four final-validation SELECTs remain; the optimization reduces work inside queries, not their number.

This change does not add a second Redis cache or change the display roster cache. It keeps the 30-second maximum event TTL, 8,192-row/2-MiB limits, coverage checks, canonical ordering, historical events, future boundaries, SQL fallback and final transactional fingerprint validation. No new client contract, flags, toggles, infrastructure or capacity changes. Frozen iOS/Android requests still work; no app binary is required.

## Writers and concurrency

Additive database triggers cover current, old and raw SQL writers. Existing row-local stamps and catalog/cursor checks remain, so old readers continue to work. Statement transition tables discard no-op/lease-only changes, group affected identities and update each affected race once per statement. Impact moves update old and new race counts. Entitlement edits find every race impacted by the changed event/user pair. Parent event changes still use the existing catalog revision.

A race stamp alone is unsafe when an entitlement edit overlaps a new, uncommitted impact. `event_fingerprint_pair_versions` serializes changed event/user pairs before discovering affected races in a subsequent SQL command. RC takes a fresh snapshot; RR/Serializable conflicts must retry their entire transaction. Pair and race locks are acquired in sorted order within statements. Pair guards deliberately have no parent FKs: acquiring a parent lock after a source-row lock would invert account deletion's order. Indexed parent cleanup removes old guard identities on deletion/rename. Existing parent-ID restrictions are preserved. Source-table TRUNCATE invalidates versions.

The new locks can still deadlock across multi-statement transactions with opposite source-row orders. A deterministic two-session test reproduces impact deletion versus entitlement update and verifies rollback/retry without count drift. Background processing already records/retries failed work. Account deletion now retries PostgreSQL deadlock/serialization conflicts, including Prisma adapter wrappers, within its existing three-attempt budget. External raw maintenance writers must also retry whole transactions after SQLSTATE 40P01/40001; never retry just the failed command in an aborted transaction.

This explicitly supersedes the earlier cache design's ban on shared race counters. The approved optimization trades repeated history reads for statement-batched writes; it does not put all local changes behind the global catalog row.

## Measured local costs

Final recorded synthetic fixture: one roster participant and 513 historical impact rows. On identical data, the frozen legacy roster SQL accessed 510 buffers in 1.629 ms; the new query accessed 20 buffers in 0.048 ms. Plans varied across runs, so these are fixture measurements, not a host-CPU or production latency prediction.

A relevant single entitlement update writes its source row, one pair guard and one race version. The final sample spent 3.182 ms including existing triggers; the new entitlement-version trigger accounted for 0.966 ms of that sample. A 25-impact bulk insert added 25 pair-guard writes and one race-version update. Lease/no-op edits added no version change. Thus the read benefit is strongest when many resolution attempts reuse largely unchanged events; frequent event changes and shared-user race fanout require watching write cost and lock retries after deployment.

[Sanitized local measurements](evidence/event-cache-race-version/local-validation.json).

## Validation

- New no-history-read assertion failed on the old implementation before the reader changed.
- Deletion conflict tests failed before bounded retries were added, then passed through real HTTP and PostgreSQL triggers.
- 66 focused integration tests passed: event cache, planning-input reuse, account-deletion retries, tournament deletion and seeded deletion.
- Cases cover cold/warm/Redis failures, old/current client responses, historical/upcoming events, malformed/old-schema vectors, ABA replacement, raw writers, impact moves, no-op/bulk updates, rollback, missing versions, supported parent renames, both RC overlap orders, RR conflict/retry, real deadlock recovery, TRUNCATE, cache-fill races and final scoring validation.
- The passive test observer now wraps the particular fingerprint client instead of overwriting a root-bound Prisma method. This preserves actual transaction identity in the tests; existing scoring assertions remain.
- Existing expectations requiring the old witness scan were replaced by assertions requiring a maintained version in the same query and prohibiting impact/entitlement scans, JSON aggregation and SQL hashing. Row bounds/counts and final SQL checks remain.
- The preparatory retry commit also passed both HTTP conflict tests against the old schema, before the versioning migration.
- Prisma validation and frontend `flutter analyze --no-pub` passed; no frontend source changes or native builds.
- Broader closure parity: 16/21 passed, five failed. All five failures also occur on unchanged `7d38ce9`, in a separate database without the migration. That baseline had eight failures total. The shared failures concern actor/target parity, Trail Mine escalation/frozen totals and the onCommitted roster. No assertions were weakened or skipped. Full unit/integration suites were not run.

## Ordered deployment and recovery

1. Deploy preparation commit `1c176f9` (bounded account-deletion retries) and refresh all HTTP workers before enabling the new triggers. It works without the new schema.
2. Apply `20260913010000_event_fingerprint_race_versions`, regenerate Prisma Client, then deploy the v4 reader. Keep exactly two production HTTP workers and existing cron/resolution topology. This requires fresh production authorization; nothing here was applied to production or staging.
3. The migration installs atomically under write-blocking source-table locks, seeds race versions/counts once without rewriting historical impacts or entitlements, and creates database-owned triggers. Lock timeout is five seconds; statement timeout is sixty seconds. A timeout rolls back the installation. Use an appropriate low-traffic window and inspect migration outcome before restarting readers.
4. Monitor warm hits, fallback rates, roster-query buffers/time, event-boundary write time and deadlock/retry counts under real traffic. Do not claim a production saving before measuring it.

Missing version rows fail closed to canonical SQL. To rebuild versions, use an explicitly authorized maintenance transaction with the same source-table locks: recompute counts from impacts, insert missing race versions, and rotate incarnation UUIDs on every repaired row so old Redis entries cannot become current. Never reset revisions under an unchanged incarnation. Restore procedures must also preserve/rotate the database cache epoch as appropriate. Pair rows are synchronization state, not scoring authority.

A reader rollback may use the prior v3 code while leaving the additive tables/triggers in place; retain the preparatory retry fix. Do not deploy new readers before their migration, drop source history, or perform destructive rollback during live traffic.
