-- Additive internal worker state. Parent ownership is RESTRICT, not CASCADE:
-- age-based maintenance must reclaim endpoint/transfer pages before requests.
CREATE TABLE durable_capture_score_progress (
  request_id uuid NOT NULL REFERENCES durable_global_event_capture_requests(id) ON DELETE RESTRICT,
  race_id text NOT NULL,
  stage text NOT NULL DEFAULT 'PLAN',
  state jsonb NOT NULL,
  state_digest text NOT NULL,
  revision bigint NOT NULL DEFAULT 0,
  completed_operations integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(request_id,race_id)
);
CREATE TABLE durable_capture_score_plans (
  request_id uuid NOT NULL REFERENCES durable_global_event_capture_requests(id) ON DELETE RESTRICT,
  race_id text NOT NULL,
  plan_key text NOT NULL,
  metadata jsonb NOT NULL,
  metadata_digest text NOT NULL,
  pending_points jsonb,
  pending_digest text,
  build_cursor integer NOT NULL DEFAULT 0,
  point_count integer NOT NULL,
  PRIMARY KEY(request_id,race_id,plan_key)
);
CREATE TABLE durable_capture_score_points (
  request_id uuid NOT NULL,
  race_id text NOT NULL,
  plan_key text NOT NULL,
  position integer NOT NULL,
  time_ms bigint NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL,
  PRIMARY KEY(request_id,race_id,plan_key,time_ms),
  UNIQUE(request_id,race_id,plan_key,position),
  FOREIGN KEY(request_id,race_id,plan_key)
    REFERENCES durable_capture_score_plans(request_id,race_id,plan_key) ON DELETE RESTRICT
);
CREATE TABLE durable_capture_score_transfers (
  request_id uuid NOT NULL REFERENCES durable_global_event_capture_requests(id) ON DELETE RESTRICT,
  race_id text NOT NULL,
  effect_id text NOT NULL,
  starts_ms bigint NOT NULL,
  payload jsonb NOT NULL,
  payload_digest text NOT NULL,
  PRIMARY KEY(request_id,race_id,effect_id)
);
CREATE INDEX durable_score_transfer_order_idx
  ON durable_capture_score_transfers(request_id,race_id,starts_ms,effect_id);
