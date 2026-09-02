-- Exact due-time recovery probes for summary rows with an active lease. The
-- ordinary WAITING_RACES/WAITING_SYNC boundaries are already covered by the
-- compact indexes introduced in 1210. Keeping lease recovery separate avoids
-- evaluating MIN(GREATEST(...)) across the whole active set after every drain.
CREATE INDEX CONCURRENTLY "global_event_summary_work_ready_lease_v2_idx"
  ON "global_event_summary_work"("lease_until", "id")
  WHERE "status"='WAITING_RACES'
    AND "ready_at" IS NOT NULL
    AND "lease_until" IS NOT NULL;

CREATE INDEX CONCURRENTLY "global_event_summary_work_sync_lease_v2_idx"
  ON "global_event_summary_work"("lease_until", "id")
  WHERE "status"='WAITING_SYNC'
    AND "lease_until" IS NOT NULL;
