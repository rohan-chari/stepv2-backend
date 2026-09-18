-- Queue-first race recovery indexes.
-- Keep recovery scans bounded to the tiny actionable subset even when the
-- state table contains millions of historical terminal rows.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_resolution_jobs_v2_queued_requested
ON race_resolution_jobs_v2 (state, requested_at, race_id)
WHERE state = 'queued';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_resolution_jobs_v2_running_lease
ON race_resolution_jobs_v2 (state, lease_expires_at, race_id)
WHERE state = 'running' AND lease_expires_at IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_race_resolution_jobs_v2_terminal_updated
ON race_resolution_jobs_v2 (updated_at, id)
WHERE state IN ('succeeded', 'failed');
