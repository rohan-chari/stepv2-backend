-- Step goals are removed from the product. Make users.step_goal nullable
-- and drop the default(5000) so no new rows silently inherit a goal.
-- The column is intentionally left in place for backward compat with
-- existing rows; new code paths must not read or write it.
ALTER TABLE "users" ALTER COLUMN "step_goal" DROP NOT NULL;
ALTER TABLE "users" ALTER COLUMN "step_goal" DROP DEFAULT;
