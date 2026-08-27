BEGIN;

ALTER TABLE "global_step_events"
  ADD COLUMN "schedule_policy_version" INTEGER;

UPDATE "global_step_events"
SET "schedule_policy_version" = 1
WHERE "schedule_mode" = 'LOCAL_ENTITLEMENTS'
  AND "schedule_policy_version" IS NULL;

COMMIT;
