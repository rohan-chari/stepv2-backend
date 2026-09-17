-- Phase 2 is expand-only. These rows are additive, have no effect on old
-- readers, and are intentionally not backfilled. The worker initializes a
-- projection lazily from race_effect_impacts when it first sees an eligible
-- post-Phase-2 intent.
CREATE TABLE historical_effect_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_id TEXT NOT NULL REFERENCES races(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effect_id TEXT NOT NULL,
  powerup_type VARCHAR(32) NOT NULL,
  current_delta_steps INTEGER NOT NULL DEFAULT 0,
  source_generation BIGINT NOT NULL,
  calculation_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT historical_effect_contributions_key
    UNIQUE (race_id, user_id, effect_id, calculation_version)
);
CREATE INDEX historical_effect_contributions_race_user_idx
  ON historical_effect_contributions(race_id, user_id);
CREATE INDEX historical_effect_contributions_effect_idx
  ON historical_effect_contributions(effect_id);

CREATE TABLE historical_effect_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  projection_id UUID NOT NULL,
  race_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  from_delta_steps INTEGER NOT NULL,
  to_delta_steps INTEGER NOT NULL,
  correction_delta_steps INTEGER NOT NULL,
  source_generation BIGINT NOT NULL,
  calculation_version INTEGER NOT NULL DEFAULT 1,
  source_revision VARCHAR(128) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT historical_effect_corrections_transition_key
    UNIQUE (projection_id, source_generation, calculation_version)
);
CREATE INDEX historical_effect_corrections_race_user_created_idx
  ON historical_effect_corrections(race_id, user_id, created_at);
CREATE INDEX historical_effect_corrections_effect_created_idx
  ON historical_effect_corrections(effect_id, created_at);
