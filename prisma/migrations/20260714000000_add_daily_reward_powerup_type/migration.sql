-- Daily-box shop-powerup prize: record which powerup was won on the claim /
-- extra-spin audit rows. Nullable + additive: existing rows and older backend
-- code (which never writes this column) are unaffected.
ALTER TABLE "daily_reward_claims" ADD COLUMN "powerup_type" TEXT;
ALTER TABLE "ad_reward_grants" ADD COLUMN "powerup_type" TEXT;
