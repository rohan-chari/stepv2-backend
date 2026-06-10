-- Daily reward v2 (mystery-box roll). Purely additive — old app builds keep
-- using the legacy 6-day ladder via daily_streak_day; both columns default
-- safely for existing rows.
ALTER TABLE "users" ADD COLUMN "daily_login_streak" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "daily_reward_claims" ADD COLUMN "rarity" TEXT;
