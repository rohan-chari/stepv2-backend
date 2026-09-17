-- Publish the existing Gold powerup rows to capable production clients and
-- allow them into the Daily Spin display/eligible catalog. Acquisition remains
-- server-gated by the Gold policy; mystery/race-box exclusion remains owned by
-- balanceConfig.storeOnlyTypes.
UPDATE "powerup_shop_items"
SET "test_only" = false,
    "daily_reward_eligible" = true
WHERE "powerup_type" IN ('hitchhike', 'leech', 'quicksand');
