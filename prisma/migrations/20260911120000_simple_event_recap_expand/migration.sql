-- Additive only. Compatible with the running old backend. Retirement/copy is
-- a separately guarded cutover; final DROP is deliberately outside migrations.
SET lock_timeout = '5s';
CREATE TABLE event_recaps (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES global_step_events(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calculation_version TEXT NOT NULL CHECK (calculation_version IN ('SIMPLE_RAW_V1','LEGACY_SAVED')),
  raw_steps INT,
  race_count INT NOT NULL CHECK (race_count >= 0),
  extra_race_steps INT NOT NULL,
  settled_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP(3),
  acknowledged_at TIMESTAMP(3),
  suppressed BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT event_recaps_source_check CHECK (
    (calculation_version='LEGACY_SAVED' AND raw_steps IS NULL) OR
    (calculation_version='SIMPLE_RAW_V1' AND expires_at IS NOT NULL AND raw_steps IS NOT NULL AND raw_steps >= 0
      AND extra_race_steps=raw_steps::bigint*race_count AND suppressed=(extra_race_steps=0))),
  UNIQUE(event_id,user_id)
);
CREATE INDEX event_recaps_user_latest_idx ON event_recaps(user_id,settled_at DESC,id);
CREATE INDEX event_recaps_expiry_idx ON event_recaps(expires_at);
ALTER TABLE global_step_event_entitlements
  ADD COLUMN recap_race_count INT CHECK (recap_race_count >= 0),
  ADD COLUMN recap_count_policy_version SMALLINT,
  ADD COLUMN recap_window_revision INT,
  ADD CONSTRAINT global_step_event_entitlements_recap_stamp_check CHECK (
    (recap_race_count IS NULL AND recap_count_policy_version IS NULL AND recap_window_revision IS NULL)
    OR (recap_race_count IS NOT NULL AND recap_count_policy_version IS NOT NULL
      AND recap_count_policy_version=1 AND recap_window_revision IS NOT NULL));
CREATE INDEX global_step_event_entitlements_user_end_idx
  ON global_step_event_entitlements(user_id,ends_at DESC,id DESC);
RESET lock_timeout;
