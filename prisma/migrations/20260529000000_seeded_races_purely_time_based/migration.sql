-- Make the seeded daily/weekly races purely time-based.
--
-- When races moved to time-based, the DAILY_10K / WEEKLY_50K RaceSeed rows were
-- never migrated: they kept target_steps (10000 / 50000) and time_based stayed
-- at the false default. Two consequences for every seeded race minted since:
--   1. It still carried a non-zero target_steps, which the app renders as a step
--      goal ("Goal: 10k") even though the race is meant to be time-based.
--   2. Because time_based = false, raceStateResolution still finished the race
--      the instant a runner crossed target_steps, instead of running the full
--      24h / 168h window.
--
-- Fix the seed templates (so future renewals are correct) and the currently
-- live PENDING/ACTIVE instances. Setting target_steps = 0 makes the goal vanish
-- on EVERY app version (the UI only draws a goal when targetSteps > 0), and
-- time_based = true stops early step-based completion. COMPLETED history is left
-- untouched.

UPDATE "race_seeds"
SET "time_based" = true, "target_steps" = 0
WHERE "kind" IN ('DAILY_10K', 'WEEKLY_50K');

-- RaceStatus enum is @map-ed to lowercase in the DB (pending/active/completed).
UPDATE "races"
SET "time_based" = true, "target_steps" = 0
WHERE "seed_id" IN ('seed-daily-10k', 'seed-weekly-50k')
  AND "status" IN ('pending', 'active');
