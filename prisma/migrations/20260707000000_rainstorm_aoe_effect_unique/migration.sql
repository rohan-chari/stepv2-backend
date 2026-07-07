-- Rainstorm (and any future AoE powerup) fans ONE purchased powerup out to N
-- victims, creating N race_active_effects rows that share the same powerup_id.
-- The original schema made powerup_id globally UNIQUE (1 powerup -> 1 effect),
-- so the 2nd victim's insert threw a unique-constraint violation and usePowerup
-- 500'd whenever a race had 2+ affectable participants.
--
-- Fix: drop the single-column uniqueness; enforce uniqueness on
-- (powerup_id, target_participant_id) instead — still forbids double-applying
-- the same storm to the same participant, while allowing the fan-out.
--
-- Back-compat: every existing row already has a globally-unique powerup_id, so
-- it trivially satisfies the new compound key — no data conflicts. Old app
-- versions are unaffected (this only relaxes an insert-time constraint).
DROP INDEX "race_active_effects_powerup_id_key";

CREATE UNIQUE INDEX "race_active_effects_powerup_id_target_participant_id_key" ON "race_active_effects"("powerup_id", "target_participant_id");
