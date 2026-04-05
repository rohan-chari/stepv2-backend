-- Delete any existing switcheroo powerups, effects, and feed events
DELETE FROM race_active_effects WHERE type = 'switcheroo';
DELETE FROM race_powerups WHERE type = 'switcheroo';
DELETE FROM race_powerup_events WHERE powerup_type = 'switcheroo';

-- Remove switcheroo from PowerupType enum
ALTER TYPE "PowerupType" RENAME TO "PowerupType_old";
CREATE TYPE "PowerupType" AS ENUM ('leg_cramp', 'red_card', 'shortcut', 'compression_socks', 'protein_shake', 'runners_high', 'second_wind', 'stealth_mode', 'wrong_turn', 'fanny_pack', 'trail_mix', 'detour_sign', 'mystery_box');

ALTER TABLE "race_powerups" ALTER COLUMN "type" TYPE "PowerupType" USING ("type"::text::"PowerupType");
ALTER TABLE "race_active_effects" ALTER COLUMN "type" TYPE "PowerupType" USING ("type"::text::"PowerupType");
ALTER TABLE "race_powerup_events" ALTER COLUMN "powerup_type" TYPE "PowerupType" USING ("powerup_type"::text::"PowerupType");

DROP TYPE "PowerupType_old";
