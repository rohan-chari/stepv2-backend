-- Allow race_powerups.earned_at_steps to be NULL. Powerups that have been
-- transferred between participants via Sneaky Swap are no longer tied to a
-- milestone, so they have no earned_at_steps. The existing unique index
-- (participant_id, earned_at_steps) keeps working because Postgres treats
-- NULL values as distinct in unique indexes by default.
ALTER TABLE "race_powerups" ALTER COLUMN "earned_at_steps" DROP NOT NULL;
