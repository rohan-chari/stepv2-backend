-- A deleted account/request detaches exactly one tiny owner row. Its scoring
-- scratch pages become immediately eligible for bounded GC, never a huge
-- account-deletion cascade. Checkpoints remain fenced by the live request.
CREATE TABLE durable_capture_score_owners (
  id uuid PRIMARY KEY,
  live_request_id uuid UNIQUE REFERENCES durable_global_event_capture_requests(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX durable_score_orphan_owners_idx ON durable_capture_score_owners(created_at,id)
  WHERE live_request_id IS NULL;
INSERT INTO durable_capture_score_owners(id,live_request_id)
  SELECT request_id,request_id FROM durable_capture_score_progress
  UNION SELECT request_id,request_id FROM durable_capture_score_plans
  UNION SELECT request_id,request_id FROM durable_capture_score_transfers;
ALTER TABLE durable_capture_score_progress DROP CONSTRAINT durable_capture_score_progress_request_id_fkey,
  ADD FOREIGN KEY(request_id) REFERENCES durable_capture_score_owners(id) ON DELETE RESTRICT;
ALTER TABLE durable_capture_score_plans DROP CONSTRAINT durable_capture_score_plans_request_id_fkey,
  ADD FOREIGN KEY(request_id) REFERENCES durable_capture_score_owners(id) ON DELETE RESTRICT;
ALTER TABLE durable_capture_score_transfers DROP CONSTRAINT durable_capture_score_transfers_request_id_fkey,
  ADD FOREIGN KEY(request_id) REFERENCES durable_capture_score_owners(id) ON DELETE RESTRICT;
ALTER TABLE durable_capture_score_points DROP CONSTRAINT durable_capture_score_points_request_id_race_id_plan_key_fkey,
  ADD FOREIGN KEY(request_id,race_id,plan_key)
    REFERENCES durable_capture_score_plans(request_id,race_id,plan_key) ON DELETE RESTRICT;
