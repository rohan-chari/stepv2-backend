ALTER TABLE onboarding_box_grant DROP CONSTRAINT onboarding_box_grant_delivery_progress;
ALTER TABLE onboarding_box_grant ADD CONSTRAINT onboarding_box_grant_delivery_progress
  CHECK ((target_box_count IS NULL AND granted_box_count IS NULL) OR
    (target_box_count IS NOT NULL AND granted_box_count IS NOT NULL AND
     target_box_count BETWEEN 0 AND 3 AND granted_box_count BETWEEN 0 AND target_box_count));
