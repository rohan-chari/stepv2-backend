-- Time-based race flag. Additive and backward-compatible.
--
-- When time_based = true, a race never finishes on reaching target_steps
-- (target_steps becomes a display-only goal); the winner is decided by step
-- count when ends_at passes (src/jobs/raceExpiry.js). Defaults false so all
-- existing races/seeds and older app clients behave exactly as before: legacy
-- target races keep finishing on target.

ALTER TABLE "races" ADD COLUMN "time_based" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "race_seeds" ADD COLUMN "time_based" BOOLEAN NOT NULL DEFAULT false;
