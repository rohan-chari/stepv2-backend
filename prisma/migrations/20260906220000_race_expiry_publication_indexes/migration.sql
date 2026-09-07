-- Existing retained task/history tables: build without blocking their writers.
-- Do not wrap this migration in BEGIN/COMMIT. On interrupted index builds,
-- inspect pg_index.indisvalid and drop ONLY invalid indexes concurrently before
-- resolving/retrying the migration (see docs/race-effect-expiry-deployment.md).
CREATE INDEX CONCURRENTLY IF NOT EXISTS race_post_snapshot_pending_idx
 ON race_resolution_post_tasks(requested_at,id)
 WHERE snapshot_state='pending' AND state IN ('queued','running');
CREATE INDEX CONCURRENTLY IF NOT EXISTS race_post_snapshot_failure_census_idx
 ON race_resolution_post_tasks(id)
 WHERE snapshot_state IN ('failed_no_retry','ambiguous_at_most_once');
CREATE INDEX CONCURRENTLY IF NOT EXISTS race_post_receipt_failure_census_idx
 ON race_resolution_post_task_receipts(race_id,source_generation)
 WHERE snapshot_state IN ('failed_no_retry','ambiguous_at_most_once');
