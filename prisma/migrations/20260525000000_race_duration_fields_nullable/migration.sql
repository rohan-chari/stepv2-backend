-- Step-goal-only races: maxDurationDays and durationHours are no longer set by
-- application code. Make the columns nullable and drop the default on
-- races.max_duration_days so new rows persist NULL instead of silently
-- defaulting to 7. Existing rows are left untouched.
ALTER TABLE "races" ALTER COLUMN "max_duration_days" DROP NOT NULL;
ALTER TABLE "races" ALTER COLUMN "max_duration_days" DROP DEFAULT;
ALTER TABLE "race_seeds" ALTER COLUMN "duration_hours" DROP NOT NULL;
