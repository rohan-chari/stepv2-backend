-- Scheduled race auto-start (1.1.7). ADDITIVE ONLY.
--
-- Adds an optional future start time to races. When set and in the future, the
-- race stays PENDING and src/jobs/autoStartScheduledRaces.js starts it once the
-- time passes; manual start (POST /races/:raceId/start) is blocked until then.
--
-- Back-compat: nullable column, no default, no existing column/constraint
-- dropped/renamed/made NOT NULL. Older app binaries and the currently-deployed
-- backend never read or write it and behave exactly as before (manual instant
-- start). Guarded with IF NOT EXISTS so re-applying is a no-op.

ALTER TABLE "races" ADD COLUMN IF NOT EXISTS "scheduled_start_at" TIMESTAMP(3);
