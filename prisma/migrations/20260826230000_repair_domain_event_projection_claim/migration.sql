-- Keep the projection claimer's per-aggregate ordering check proportional to
-- the active queue. The previous full index accumulated every completed
-- placement event and forced repeated scans over historical rows whenever a
-- parent event was stranded in PROJECTING.
CREATE INDEX CONCURRENTLY "domain_event_outbox_active_aggregate_order_idx"
  ON "domain_event_outbox"("aggregate_type", "aggregate_id", "occurred_at", "id")
  WHERE "status" NOT IN ('COMPLETED', 'SUPPRESSED', 'FAILED_TERMINAL');
