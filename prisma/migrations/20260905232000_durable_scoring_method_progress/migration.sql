CREATE TABLE durable_capture_method_progress (
  scope_digest char(64) NOT NULL,
  method_digest char(64) NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(scope_digest,method_digest)
);
CREATE INDEX durable_capture_method_progress_collection
  ON durable_capture_method_progress(updated_at,scope_digest,method_digest);
