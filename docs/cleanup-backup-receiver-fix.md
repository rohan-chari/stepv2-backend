# Resume receipt-aware cleanup with a WAL backup receiver

Production's only observed replication-monitoring connection was PGHoard: a responsive streaming backup receiver, no replay position, and about133hours of reported replay lag. The shared cleanup guard treated it as an unhealthy standby and skipped every deletion page. Completed post-tasks from August26 remained despite the current seven-day retention cutoff.

The guard now exempts only the known PGHoard receiver with no replay position, streaming state, known sent/write/flush positions and a reply within30seconds. Other receivers must supply a replay position and fresh streaming evidence. Actual standby lag above the existing five-second limit still stops cleanup. A caught-up idle standby may have NULL replay_lag; a behind standby with missing lag cannot authorize deletion. A sender named PGHoard that supplies a replay position receives the ordinary standby checks. Missing/invalid monitoring results stop cleanup.

This retains one monitoring roundtrip per pre/post-page snapshot and scans only the small replication view. It adds no feature flag, schema migration, dependency, API change, application query listener or native app build. Current and older iOS/Android clients use unchanged contracts. The post-task candidate-query optimization remains separate and is not part of this release.

## Retention scope and operating bounds

This shared guard serves post-task cleanup, domain-event retention (including schedule payloads/receipts) and seeded-challenge retention. Fixing the guard can resume all three, so this is not described as only a post-task deletion change.

No retention cutoff acceptance record was present in production at00:20UTC September14. Existing post-task retention remains seven days (one day only if its existing acceptance stamp is present), up to two500-row pages every ten minutes. Domain-event payload retention remains30days without that stamp, with ten-page shared budgets; seeded receipts retain their30-day cutoff and500-row pages. No cutoff stamp, runtime controls, scheduling or batch limits are modified.

Existing safeguards remain:16MiB WAL/page,64MiB WAL/run,500ms page-duration continuation limit and five-second real-standby lag. Post-task deletion verifies terminal state, no unfinished intents and matching durable task/delivery receipts; it skips locked rows and has100ms lock/2s statement/3s transaction limits. Older payloads without receipts must first obtain valid receipts inside the deletion transaction. Conflicts continue to prevent deletion. No manual bulk delete or VACUUM is authorized by this code change.

## Verification

Tests first: the initial real-worker suite failed four cases on the prior implementation—backup blocked deletion, and unknown/stale standby evidence incorrectly permitted it. Final17 tests pass against dedicated local PostgreSQL18, exercising the real entrypoint/scheduler, budget SQL and deletion SQL. Only external replication data comes from a test schema and the ten-minute timer is accelerated. Cases cover no senders, backups, healthy/lagging/idle/unknown/stale standbys, missing evidence, mixed senders, retry without process restart, receipt creation/conflicts, unfinished work, current/two-day-old retention and unchanged public race totals.

An additional52 existing integration tests pass for post-task processing/storage, durable receipts and domain-event receipt lifecycle;19 focused unit checks pass for existing budgets and workers. Flutter analysis is clean. Mandatory code review: SHIP, with additional requested cases implemented and green. Existing assertions unchanged.

The candidate monitoring SELECT was also run READ ONLY in production and returned replicaLagSeconds0 with replicationEvidenceUnavailable=false for the observed PGHoard receiver. No production deletion was performed during development. The full database cleanup backlog has not been exhaustively audited; the guard correction does not bypass downstream eligibility/receipt checks.

## Release plan

Back up deployment configuration and preserve the existing remote lockfile edit; ship the reviewed commit and use the guarded two-HTTP/one-resolution/one-cron reload with staging stopped. No migrations, dependency install or settings changes. Verify health and old/current read contracts, then watch at least one natural ten-minute post-task cleanup tick. Record actual deletes and guard/cleanup errors, rather than claiming the entire backlog is gone or a CPU percentage saved. A timeout or receipt blocker must be investigated rather than bypassed. Rollback application code restores the prior gate but does not resurrect legitimately deleted payloads; durable receipts remain according to the existing deletion contract.

Evidence: [verification](evidence/cleanup-backup-receiver/verification.json) and compressed test logs in the same directory.


## First production tick and bounded receipt lookup follow-up

Guard commit `6b164a6` deployed September 14. Health and authenticated old/current client reads passed; the topology remained two HTTP workers, one resolution worker and one cron worker, with staging stopped. Configuration and the pre-existing lockfile edit were preserved.

At the first natural cleanup tick around 00:45:42 UTC, the guard allowed cleanup but the existing deletion SQL exceeded its two-second statement timeout. Its transaction rolled back; the 00:35–00:48 observation recorded zero task deletions. Thus the guard correction alone did not restore cleanup. Sampled CPU averaged 61.6% during that observation; this is not evidence of a CPU reduction.

Read-only `EXPLAIN`, without `ANALYZE`, found a sequential scan of an estimated 771,490 historical task receipts. The outer equality filters on a UNION of historical receipts and newly inserted receipts had become a large hash join. The follow-up places the composite primary-key filter inside the historical branch and uses `OFFSET 0` to prevent flattening. PostgreSQL now plans one indexed historical receipt lookup per candidate. The batch remains at most 500 candidates; the newly inserted receipt CTE remains bounded to the batch. All existing receipt identity/state/count/timestamp checks and transaction limits are unchanged. No new query roundtrips, migration, timer, retention change or timeout increase.

Tests first: a real scheduled-worker test seeded 100,000 retained receipts and 500 conflicting tasks. The original query failed the plan assertion with a 100,000-row sequential scan. The follow-up passed with indexed, single-row lookups, preserved all conflicting tasks and unchanged public race totals. All 70 relevant integration tests pass on dedicated local PostgreSQL 18. Read-only production planning confirms the same index access; estimated total plan cost changed from 89,912.88 to 9,148.11. Planner cost is not measured execution time. Required code review found no blockers. Actual cleanup execution must still be verified after the follow-up deployment.
