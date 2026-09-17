CREATE TABLE historical_race_discovery_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  changed_start TIMESTAMP NOT NULL,
  changed_end TIMESTAMP NOT NULL,
  requested_source_generation BIGINT NOT NULL,
  cursor_race_id TEXT,
  cursor_participant_id TEXT,
  status "HistoricalRaceReconciliationState" NOT NULL DEFAULT 'queued',
  available_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lease_token UUID,
  lease_expires_at TIMESTAMP,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX historical_race_discovery_cursors_claim_idx
  ON historical_race_discovery_cursors(status, available_at, user_id);
