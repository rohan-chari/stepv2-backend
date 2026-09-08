-- Keep this as a single statement, outside any transaction: PostgreSQL requires
-- CREATE INDEX CONCURRENTLY to run in its own transaction. Do not use IF NOT
-- EXISTS: an invalid index from an interrupted build must not be accepted.
CREATE INDEX CONCURRENTLY "race_post_snapshot_success_lookup_idx"
ON "race_resolution_post_tasks" ("race_id", "source_generation")
WHERE "snapshot_state" = 'succeeded';
