-- Canonical timezone for a race's step-bucket day boundaries. NULL = legacy
-- behavior (user-created races: live in requester tz, settlement in UTC).
-- Seeded daily/weekly races set this to 'America/New_York' so midnight is the
-- same instant for every participant and live totals match settled totals.
ALTER TABLE "races" ADD COLUMN "timezone" TEXT;

-- Raise the seeded daily/weekly participant cap from 100 to 500. Pre-registration
-- lets users opt into the next race before it starts, which can fill slots ahead
-- of time; 100 is too low for the flagship public challenges.
UPDATE "race_seeds" SET "max_participants" = 500 WHERE "kind" IN ('DAILY_10K', 'WEEKLY_50K');
