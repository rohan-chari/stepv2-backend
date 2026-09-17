CREATE TABLE "social_reward_claims" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "opened_at" TIMESTAMP(3),
    "claimed_at" TIMESTAMP(3),
    "reward_amount" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "social_reward_claims_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "social_reward_claims_user_id_platform_key" ON "social_reward_claims"("user_id", "platform");
CREATE INDEX "social_reward_claims_user_id_idx" ON "social_reward_claims"("user_id");
ALTER TABLE "social_reward_claims" ADD CONSTRAINT "social_reward_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
