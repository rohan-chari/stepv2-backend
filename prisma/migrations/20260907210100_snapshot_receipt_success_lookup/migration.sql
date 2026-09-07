-- Separate migration so each concurrent build is sent as a single statement.
-- If interrupted, inspect/drop the invalid index before resolving and retrying.
CREATE INDEX CONCURRENTLY "race_post_receipt_success_lookup_idx"
ON "race_resolution_post_task_receipts" ("race_id", "source_generation")
WHERE "snapshot_state" = 'succeeded';
