-- Additive, no speculative backfill: old terminal effects do not prove a pop.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "race_active_effects" ADD COLUMN "decoy_consumed_at" TIMESTAMP(3);
-- Preserve all other catalog settings and every live race-box balance value.
UPDATE "powerup_shop_items"
   SET "price_coins" = 150, "active" = true
 WHERE "sku" = 'POWERUP_DECOY';
UPDATE "powerup_copy"
   SET "description" = 'The next single-target attack aimed at you is redirected to a random rival. Lasts until it triggers or 24 hours. Wait 1 hour after it pops before using another Decoy in this race', "updated_at" = CURRENT_TIMESTAMP
 WHERE "powerup_type" = 'decoy'::"PowerupType";
UPDATE "powerup_shop_items"
   SET "description" = 'The next single-target attack aimed at you is redirected to a random rival. Lasts until it triggers or 24 hours. Wait 1 hour after it pops before using another Decoy in this race'
 WHERE "sku" = 'POWERUP_DECOY';
COMMIT;
