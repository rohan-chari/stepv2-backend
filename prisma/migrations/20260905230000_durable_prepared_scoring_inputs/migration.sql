-- Derived, version-keyed scorer inputs. Outcomes are never shared between users.
CREATE TABLE durable_capture_prepared_inputs (
  scope_digest char(64) PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  root_ids uuid[] NOT NULL,
  answers jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX durable_capture_prepared_inputs_collection
  ON durable_capture_prepared_inputs(updated_at,scope_digest);
