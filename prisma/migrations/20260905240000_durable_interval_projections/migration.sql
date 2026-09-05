-- Derived immutable scalar answers, independently namespaced by source kind,
-- exact method/window, ownership day set, scorer semantics, and chunk revision.
-- No source-writer registry or trigger fanout is introduced.
CREATE TABLE durable_capture_interval_projections (
  semantic_digest text NOT NULL,
  root_id uuid NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  revision bigint NOT NULL,
  result jsonb NOT NULL,
  result_digest text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(semantic_digest,root_id)
);
CREATE INDEX durable_capture_interval_projection_latest
  ON durable_capture_interval_projections(semantic_digest,revision DESC);
CREATE INDEX durable_capture_interval_projection_retention
  ON durable_capture_interval_projections(created_at,semantic_digest,root_id);
