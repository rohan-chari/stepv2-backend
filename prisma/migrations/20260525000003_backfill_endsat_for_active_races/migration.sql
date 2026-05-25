-- Backfill ACTIVE races created during the step-goal-only window where
-- endsAt is NULL. Set endsAt to startedAt + 7 days and maxDurationDays = 7
-- so the raceExpiry cron can settle them.
UPDATE "races"
SET "ends_at" = "started_at" + INTERVAL '7 days', "max_duration_days" = 7
-- RaceStatus enum is @map-ed to lowercase in the DB (pending/active/completed).
WHERE status = 'active' AND "started_at" IS NOT NULL AND "ends_at" IS NULL;
