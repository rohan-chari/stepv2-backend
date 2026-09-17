-- Forward-only Phase 2 eligibility. Existing Phase 1 intents remain durable
-- but are not consumed by the correction worker unless a new admission updates
-- them after Phase 2 is deployed.
ALTER TABLE historical_race_reconciliation_intents
  ADD COLUMN phase2_eligible BOOLEAN NOT NULL DEFAULT FALSE;
