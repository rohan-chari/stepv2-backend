-- Additive durable retry state: failed rows remain pending and retryable.
ALTER TABLE global_step_event_entitlements
  ADD COLUMN end_attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN end_next_attempt_at timestamp(3),
  ADD COLUMN end_last_error_code text;
-- Build without blocking entitlement inserts/updates on a large existing table.
CREATE INDEX CONCURRENTLY global_step_event_entitlements_pending_end_idx
  ON global_step_event_entitlements (ends_at,id)
  WHERE end_processed_at IS NULL;
