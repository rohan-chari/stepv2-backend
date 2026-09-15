# Race post-task redundant index removal

Migration `20260915120000_drop_redundant_race_post_task_generation_index`
drops only the non-unique
`race_resolution_post_tasks_race_id_source_generation_idx` index.

The migration deliberately retains:

- `race_resolution_post_tasks_race_id_source_generation_key`, the unique
  `(race_id, source_generation)` index used by the post-task insert conflict
  arbiter and generation identity lookups.
- `race_resolution_post_tasks_dedupe_key_key`, the unique dedupe-key index.
- Every queue, lease, snapshot, and cleanup index.

The SQL uses `DROP INDEX CONCURRENTLY` and contains no `BEGIN`/`COMMIT`.
Concurrent drop avoids taking the normal blocking index-drop lock while live
writers continue. The migration must run through the repository's normal
`prisma migrate deploy` path, which supports standalone concurrent-index
migrations.

## Pre-deployment verification

On the target database, verify the target exists with the exact definition and
that both retained unique indexes also exist with their exact definitions:

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'race_resolution_post_tasks'
  AND indexname IN (
    'race_resolution_post_tasks_race_id_source_generation_idx',
    'race_resolution_post_tasks_race_id_source_generation_key',
    'race_resolution_post_tasks_dedupe_key_key'
  )
ORDER BY indexname;
```

Do not proceed if the target is absent, invalid, or has a different
definition. Do not substitute either retained unique index for the target.

## Rollback plan

Prisma migrations are forward-only. If the removed index is needed again, add a
new migration containing the exact standalone statement below and deploy it
through the normal migration process:

```sql
CREATE INDEX CONCURRENTLY
  race_resolution_post_tasks_race_id_source_generation_idx
ON race_resolution_post_tasks (race_id, source_generation);
```

If a concurrent operation is interrupted, inspect `pg_index.indisvalid` and
`indisready` for this exact index name before retrying. Drop only an invalid
artifact concurrently; never drop either retained unique index.
