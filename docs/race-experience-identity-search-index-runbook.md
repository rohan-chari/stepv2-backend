# Race identity search indexes runbook

This is the required out-of-transaction companion to Prisma migration
`20260811190000_race_identity_and_auto_link`. The Prisma migration atomically
adds the schema and declined-pair backfill. This runbook separately installs
`pg_trgm` and builds the two GIN indexes without blocking writes to `users`.

Do not run this against production without explicit, in-the-moment deploy
approval. Run it on staging first. Set `IDENTITY_INDEX_DATABASE_URL` to the
direct PostgreSQL connection, not a transaction-pooling URL, and verify the
database name before continuing.

## Apply

The SQL is idempotent and must not be wrapped in a transaction because
`CREATE INDEX CONCURRENTLY` is illegal inside a transaction block.

```sh
psql "$IDENTITY_INDEX_DATABASE_URL" \
  --set=ON_ERROR_STOP=1 \
  --file=scripts/race-experience-identity-search-indexes.sql
```

Run the same command a second time on staging. It must complete successfully
without creating duplicate indexes.

## Verify

Verify the extension, exact index definitions, and validity/readiness:

```sql
SELECT extname
FROM pg_extension
WHERE extname = 'pg_trgm';

SELECT
  i.relname AS index_name,
  x.indisvalid,
  x.indisready,
  pg_get_indexdef(x.indexrelid) AS index_definition,
  pg_get_expr(x.indpred, x.indrelid) AS predicate
FROM pg_index x
JOIN pg_class i ON i.oid = x.indexrelid
WHERE i.relname IN (
  'users_display_name_search_trgm_idx',
  'users_discoverable_name_search_trgm_idx'
)
ORDER BY i.relname;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND indexname IN (
    'users_display_name_search_trgm_idx',
    'users_discoverable_name_search_trgm_idx'
  )
ORDER BY indexname;
```

Both rows must have `indisvalid = true` and `indisready = true`. Definitions
must match the predicates in the SQL file exactly.

On production-like staging data, verify both search predicates choose their GIN
indexes before enabling identity rollout flags:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM users
WHERE is_review_account = false
  AND display_name IS NOT NULL
  AND lower(display_name) LIKE '%nathan%'
LIMIT 20;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id
FROM users
WHERE is_review_account = false
  AND name_setup_completed_at IS NOT NULL
  AND discoverable_name_search IS NOT NULL
  AND discoverable_name_search LIKE '%nathan%'
LIMIT 20;
```

## Recover an interrupted concurrent build

An interrupted `CREATE INDEX CONCURRENTLY` can leave an invalid index. Do not
enable the rollout while either verification row is missing or `indisvalid` /
`indisready` is false. Drop only the invalid named index outside a transaction,
then rerun the idempotent apply command:

```sql
DROP INDEX CONCURRENTLY IF EXISTS users_display_name_search_trgm_idx;
DROP INDEX CONCURRENTLY IF EXISTS users_discoverable_name_search_trgm_idx;
```

If extension creation fails for privileges, stop and have the database owner
install `pg_trgm`; do not mark the rollout verified until the extension and both
valid indexes are present. Schema/backfill recovery remains governed by the
normal Prisma failed-migration procedure in `DEPLOY_RUNBOOK.md`.
