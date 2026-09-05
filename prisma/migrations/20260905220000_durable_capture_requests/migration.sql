-- Pending captures are deliberately separate from the schema-1 artifact path:
-- rolling old summary workers must not mistake uncomputed captures for corrupt
-- artifacts. Existing summary work is parked with a lease through its deadline.
CREATE TABLE durable_global_event_capture_requests (
  id uuid PRIMARY KEY,
  work_id text NOT NULL UNIQUE REFERENCES global_event_summary_work(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','COMPLETE','EXPIRED','FAILED')),
  context jsonb NOT NULL,
  context_digest char(64) NOT NULL,
  available_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamp NOT NULL,
  lease_token uuid,
  lease_until timestamp,
  attempt_count integer NOT NULL DEFAULT 0,
  last_error_code text,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamp
);
CREATE INDEX durable_capture_pending_due_idx
  ON durable_global_event_capture_requests(available_at,id) WHERE status='PENDING';
CREATE INDEX durable_capture_lease_due_idx
  ON durable_global_event_capture_requests(lease_until,id) WHERE status='PROCESSING';
CREATE INDEX durable_capture_expiry_idx
  ON durable_global_event_capture_requests(expires_at,id) WHERE status IN ('PENDING','PROCESSING');
CREATE INDEX durable_capture_completed_idx
  ON durable_global_event_capture_requests(completed_at,id) WHERE status IN ('COMPLETE','EXPIRED','FAILED');
