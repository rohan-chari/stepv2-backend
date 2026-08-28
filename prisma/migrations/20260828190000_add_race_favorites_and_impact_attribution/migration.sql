-- Additive, rolling-deploy-safe presentation/preference fields. Existing rows
-- stay NULL and old application versions ignore both columns.
ALTER TABLE "race_participants"
  ADD COLUMN "favorited_at" TIMESTAMP(3);

ALTER TABLE "race_impact_events"
  ADD COLUMN "attacker_display_name" TEXT;
