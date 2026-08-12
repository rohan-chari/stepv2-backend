ALTER TABLE "ad_reward_grants" ADD COLUMN "context_id" TEXT;

CREATE TABLE "race_payout_double_offers" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "base_coins" INTEGER NOT NULL,
  "bonus_coins" INTEGER NOT NULL,
  "max_bonus_coins" INTEGER NOT NULL,
  "rolling_24h_remaining_before_claim" INTEGER NOT NULL,
  "provider_sub_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "claimed_at" TIMESTAMP(3),
  "forfeited_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_payout_double_offers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_payout_double_offers_status_check" CHECK ("status" IN ('PENDING','CLAIMED','FORFEITED')),
  CONSTRAINT "race_payout_double_offers_amount_check" CHECK (
    "bonus_coins" > 0 AND
    "bonus_coins" <= "max_bonus_coins" AND
    "max_bonus_coins" <= 500 AND
    "rolling_24h_remaining_before_claim" >= 0
  )
);

CREATE TABLE "race_payout_double_offer_items" (
  "id" TEXT NOT NULL,
  "offer_id" TEXT NOT NULL,
  "race_participant_id" TEXT,
  "race_id" TEXT,
  "race_id_snapshot" TEXT NOT NULL,
  "eligible_coins" INTEGER NOT NULL,
  "source_reason" TEXT NOT NULL,
  "source_ref_id" TEXT NOT NULL,
  CONSTRAINT "race_payout_double_offer_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_payout_double_offer_items_eligible_coins_check" CHECK ("eligible_coins" > 0)
);

CREATE TABLE "race_payout_double_identities" (
  "provider_sub_hash" TEXT NOT NULL,
  "cohort_bucket" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_payout_double_identities_pkey" PRIMARY KEY ("provider_sub_hash"),
  CONSTRAINT "race_payout_double_identities_bucket_check" CHECK ("cohort_bucket" BETWEEN 0 AND 99)
);

CREATE TABLE "race_payout_double_velocity_grants" (
  "id" TEXT NOT NULL,
  "provider_sub_hash" TEXT NOT NULL,
  "offer_id" TEXT NOT NULL,
  "bonus_coins" INTEGER NOT NULL,
  "claimed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_payout_double_velocity_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_payout_double_velocity_grants_bonus_check" CHECK ("bonus_coins" > 0)
);

CREATE TABLE "race_payout_double_claim_receipts" (
  "offer_id" TEXT NOT NULL,
  "provider_sub_hash" TEXT NOT NULL,
  "bonus_coins" INTEGER NOT NULL,
  "claimed_at" TIMESTAMP(3) NOT NULL,
  "account_deleted_at" TIMESTAMP(3),
  CONSTRAINT "race_payout_double_claim_receipts_pkey" PRIMARY KEY ("offer_id"),
  CONSTRAINT "race_payout_double_claim_receipts_bonus_check" CHECK ("bonus_coins" > 0)
);

CREATE UNIQUE INDEX "ad_reward_grants_user_id_reward_kind_context_id_key"
  ON "ad_reward_grants"("user_id", "reward_kind", "context_id");
CREATE INDEX "ad_reward_grants_reward_kind_consumed_at_idx"
  ON "ad_reward_grants"("reward_kind", "consumed_at");
CREATE INDEX "coin_transactions_reason_created_at_idx"
  ON "coin_transactions"("reason", "created_at");
CREATE INDEX "race_payout_double_offers_user_id_status_created_at_idx"
  ON "race_payout_double_offers"("user_id", "status", "created_at");
CREATE INDEX "race_payout_double_offers_status_claimed_at_idx"
  ON "race_payout_double_offers"("status", "claimed_at");
CREATE UNIQUE INDEX "race_payout_double_offers_one_pending_per_user"
  ON "race_payout_double_offers"("user_id") WHERE "status" = 'PENDING';
CREATE UNIQUE INDEX "race_payout_double_offer_items_race_participant_id_key"
  ON "race_payout_double_offer_items"("race_participant_id");
CREATE UNIQUE INDEX "race_payout_double_offer_items_offer_id_race_id_snapshot_key"
  ON "race_payout_double_offer_items"("offer_id", "race_id_snapshot");
CREATE UNIQUE INDEX "race_payout_double_velocity_grants_offer_id_key"
  ON "race_payout_double_velocity_grants"("offer_id");
CREATE INDEX "race_payout_double_velocity_grants_provider_sub_hash_claimed_at_idx"
  ON "race_payout_double_velocity_grants"("provider_sub_hash", "claimed_at");
CREATE INDEX "race_payout_double_velocity_grants_claimed_at_idx"
  ON "race_payout_double_velocity_grants"("claimed_at");
CREATE INDEX "race_payout_double_claim_receipts_claimed_at_idx"
  ON "race_payout_double_claim_receipts"("claimed_at");

ALTER TABLE "race_payout_double_offers"
  ADD CONSTRAINT "race_payout_double_offers_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_payout_double_offer_items"
  ADD CONSTRAINT "race_payout_double_offer_items_offer_id_fkey"
  FOREIGN KEY ("offer_id") REFERENCES "race_payout_double_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_payout_double_offer_items"
  ADD CONSTRAINT "race_payout_double_offer_items_race_participant_id_fkey"
  FOREIGN KEY ("race_participant_id") REFERENCES "race_participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "race_payout_double_offer_items"
  ADD CONSTRAINT "race_payout_double_offer_items_race_id_fkey"
  FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE SET NULL ON UPDATE CASCADE;
