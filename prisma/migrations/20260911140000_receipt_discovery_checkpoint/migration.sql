-- A bounded discovery page and its checkpoint commit together. This is data
-- progress, not a release toggle. No production history is scanned here.
CREATE TABLE domain_event_receipt_discovery (
  id TEXT PRIMARY KEY,
  cutoff TIMESTAMP(3) NOT NULL,
  cursor_created_at TIMESTAMP(3),
  cursor_id UUID,
  scanned BIGINT NOT NULL DEFAULT 0,
  discovered BIGINT NOT NULL DEFAULT 0,
  completed_at TIMESTAMP(3),
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((cursor_created_at IS NULL) = (cursor_id IS NULL))
);
