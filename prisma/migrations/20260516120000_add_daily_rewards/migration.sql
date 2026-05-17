ALTER TABLE "users"
  ADD COLUMN "last_daily_claim_date" TEXT,
  ADD COLUMN "daily_streak_day" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "daily_reward_claims" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "claimed_date" TEXT NOT NULL,
  "cycle_day" INTEGER NOT NULL,
  "reward_type" TEXT NOT NULL,
  "coin_amount" INTEGER,
  "shop_item_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "daily_reward_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "daily_reward_claims_user_id_claimed_date_key"
  ON "daily_reward_claims"("user_id", "claimed_date");

CREATE INDEX "daily_reward_claims_user_id_created_at_idx"
  ON "daily_reward_claims"("user_id", "created_at");

ALTER TABLE "daily_reward_claims"
  ADD CONSTRAINT "daily_reward_claims_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
