ALTER TABLE race_resolution_jobs_v2
  ADD COLUMN dirty_source_start_at TIMESTAMP,
  ADD COLUMN dirty_source_end_at TIMESTAMP,
  ADD COLUMN dirty_source_generation BIGINT,
  ADD COLUMN processing_source_start_at TIMESTAMP,
  ADD COLUMN processing_source_end_at TIMESTAMP,
  ADD COLUMN processing_source_generation BIGINT;

CREATE TYPE "HistoricalRaceReconciliationState" AS ENUM ('queued','running','succeeded','failed');

CREATE TABLE historical_race_reconciliation_intents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_kind VARCHAR(32) NOT NULL DEFAULT 'PARTICIPANT',
  changed_start TIMESTAMP NOT NULL,
  changed_end TIMESTAMP NOT NULL,
  requested_source_generation BIGINT NOT NULL,
  status "HistoricalRaceReconciliationState" NOT NULL DEFAULT 'queued',
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_expires_at TIMESTAMP,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error_code VARCHAR(128),
  terminal_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (changed_end > changed_start)
);

CREATE UNIQUE INDEX historical_race_reconciliation_intents_race_user_key
  ON historical_race_reconciliation_intents(race_id,user_id);
CREATE INDEX historical_race_reconciliation_intents_claim_idx
  ON historical_race_reconciliation_intents(status,available_at,race_id);
CREATE INDEX historical_race_reconciliation_intents_race_status_idx
  ON historical_race_reconciliation_intents(race_id,status);
