-- Keyset terminal-task retention. Additive and mixed-version safe: old
-- binaries ignore the index while the new cleanup avoids scanning queued and
-- recoverable task history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "race_resolution_post_tasks_state_completed_at_id_idx"
ON "race_resolution_post_tasks"("state", "completed_at", "id");
