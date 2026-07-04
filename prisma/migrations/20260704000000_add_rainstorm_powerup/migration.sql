-- RAINSTORM powerup. ADDITIVE ONLY.
--
-- Purchase-only powerup (coin store, like IMPOSTER): never rolls from a
-- mystery box, so no rarity-tier data changes. Untargeted AoE debuff — halves
-- every other participant's step accrual for 1 hour.
--
-- Back-compat: single additive enum value; no column/table/constraint is
-- dropped or renamed. Old app versions render unknown powerup types with a
-- fallback icon and read names/descriptions from the API, so they keep working.
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'rainstorm' BEFORE 'mystery_box';
