-- Backfill: set all users with null or below-minimum step goal to 5000
UPDATE "users" SET "step_goal" = 5000 WHERE "step_goal" IS NULL OR "step_goal" < 5000;

-- Set default and make non-nullable
ALTER TABLE "users" ALTER COLUMN "step_goal" SET DEFAULT 5000;
ALTER TABLE "users" ALTER COLUMN "step_goal" SET NOT NULL;
