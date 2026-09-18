# Database work reduction release and measurement

Production deployment requires fresh authorization after review of the exact scoped diff and validation. Preserve exactly two HTTP workers, existing dedicated workers/pool budgets and stopped staging. No iOS/Android build or upload is required.

## Concurrent index migration

The sole migration is `20260914010000_global_event_pending_parent_index`: one standalone `CREATE INDEX CONCURRENTLY`. Use the direct PostgreSQL connection, not transaction-pooled PgBouncer. Never wrap the migration in an outer transaction. Use approved session statement/lock bounds appropriate to construction(suggested30min statement/5sec lock), check long transactions and disk, and monitor `pg_stat_progress_create_index` from a separate read-only connection. No persistent database setting is changed.

Before and after deployment inspect:

```sql
SELECT i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid)
FROM pg_index i
WHERE i.indexrelid = to_regclass('public.global_step_event_entitlements_pending_parent_idx');
```

Expected definition is a B-tree on `global_step_event_entitlements(event_id)` with predicate `start_processed_at IS NULL OR end_processed_at IS NULL` and no included columns.

| State | Authorized recovery |
|---|---|
|Absent, migration unapplied|Normal `prisma migrate deploy` on the direct connection.|
|Valid+ready, exact definition, failed/unrecorded migration|Verify the precise ledger entry and resolve only that migration as applied.|
|Invalid/not ready|Stop; remove only the invalid artifact with `DROP INDEX CONCURRENTLY`, mark only its failed migration rolled back, then retry deploy.|
|Healthy same-name index with different definition|Stop and investigate; never silently accept or drop it.|
|Ledger applied but index missing/invalid/different|Stop and investigate drift; the ledger is insufficient proof.|

Do not use `IF NOT EXISTS` to mask an invalid index or reconcile bookkeeping before verification. Cancellation requires identifying the exact build backend; a canceled build may leave an invalid index and is not a successful deployment. Keep the additive index on application rollback unless separately authorized removal is justified. The final pinned-statistics read/write tradeoffs are documented in the implementation record.

## Application rollback and observation

Apply the index before code reload. No other migration, data backfill, configuration flag, Redis format or wake-payload change. Application rollback preserves durable entitlements, obligations, deadlines, repair intents and generations. Advisory lane state can safely restart from the head. Existing v1 raw keys retain ten-minute expiry and unchanged bounds. Never delete durable rows to roll back process state.

After separately authorized release, capture a comparable two-hour window with complete60-second process-identified counters, query deltas, direct managed DB CPU idle/user/system/I/O/steal, memory/zram and traffic/event/race/backlog dimensions. Capture a midnight-spanning window before selecting cutoff-specific cache policy. Report missing final intervals, restarts, statement evictions/resets, nested-query counting and monitoring overhead. Query execution elapsed is not CPU time or HTTP requests.

B1 requires legacy full-timeline admission rejection to explain at least10%of full-reload rows plus at least20%source-row savings in that cohort's replay. C requires its separate coverage gate and architecture review. Neither is selected because telemetry merely exists. The70%idle target is an observation goal, not a promised saving.
