-- Powerups Wave 5 (11 new store-only powerup types). Additive only: old backend
-- binaries continue to understand every prior value, and old app clients never
-- receive these types (gated behind the `powerups5` X-Client-Features token).
-- Each value is inserted BEFORE 'mystery_box' to match the schema's declared
-- ordering.
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'uprising' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'ghost_pepper' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'coin_flip' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'mystery_potion' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'decoy' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'power_outage' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'umbrella' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'rally_flag' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'drill_sergeant' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'piggy_bank' BEFORE 'mystery_box';
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'bounty' BEFORE 'mystery_box';
