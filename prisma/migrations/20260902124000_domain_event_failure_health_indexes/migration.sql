-- Compact failure-health probes avoid scanning terminal projection children.
CREATE INDEX CONCURRENTLY IF NOT EXISTS domain_event_receipts_failed_terminal_idx
  ON domain_event_receipts (completed_at,event_key)
  WHERE terminal_status='FAILED_TERMINAL';

CREATE INDEX CONCURRENTLY IF NOT EXISTS domain_event_outbox_failed_projection_count_idx
  ON domain_event_outbox (failed_projection_count,id)
  WHERE projection_counts_valid_at IS NOT NULL AND failed_projection_count>0;
