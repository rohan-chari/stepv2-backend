-- DropForeignKey
ALTER TABLE "races" DROP CONSTRAINT "races_creator_id_fkey";

-- DropForeignKey
ALTER TABLE "step_milestone_claims" DROP CONSTRAINT "step_milestone_claims_user_id_fkey";

-- DropIndex
DROP INDEX "users_is_review_account_idx";

-- AlterTable
ALTER TABLE "powerup_purchase_requests" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "race_participants" ALTER COLUMN "results_seen_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ranked_cohort_members" ALTER COLUMN "results_seen_at" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "user_powerup_items" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ad_reward_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "ad_unit" TEXT,
    "transaction_id" TEXT NOT NULL,
    "reward_kind" TEXT NOT NULL DEFAULT 'extra_daily_spin',
    "granted_date" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "reward_type" TEXT,
    "rarity" TEXT,
    "coin_amount" INTEGER,
    "shop_item_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_reward_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ad_reward_grants_transaction_id_key" ON "ad_reward_grants"("transaction_id");

-- CreateIndex
CREATE INDEX "ad_reward_grants_user_id_granted_date_idx" ON "ad_reward_grants"("user_id", "granted_date");

-- AddForeignKey
ALTER TABLE "step_milestone_claims" ADD CONSTRAINT "step_milestone_claims_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_reward_grants" ADD CONSTRAINT "ad_reward_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "races" ADD CONSTRAINT "races_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "race_participants_user_invite_expires_idx" RENAME TO "race_participants_user_id_status_invite_expires_at_idx";
