-- NULL preserves completed delivery for every historical/immediate ledger row.
-- Recovery claims explicitly pin target and delivered count atomically.
ALTER TABLE onboarding_box_grant
  ADD COLUMN target_box_count INTEGER,
  ADD COLUMN granted_box_count INTEGER;
ALTER TABLE onboarding_box_grant ADD CONSTRAINT onboarding_box_grant_delivery_progress
  CHECK ((target_box_count IS NULL AND granted_box_count IS NULL) OR
    (target_box_count BETWEEN 0 AND 3 AND granted_box_count BETWEEN 0 AND target_box_count));
