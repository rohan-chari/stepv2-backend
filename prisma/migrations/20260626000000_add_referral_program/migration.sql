-- Friend referral program — attribution + payout ledgers. All additive: the new
-- columns on "users" are nullable and the new tables are standalone. NULLs do
-- not collide in a Postgres UNIQUE index, so adding "users_referral_code_key"
-- never fails on existing prod rows. Old app versions read none of this.
--
-- Locked design decisions (see REFERRAL_FEATURE_RESEARCH.md §11):
--   * 11.5 account-deletion FK shape: "referrals".referrer_id is nullable with
--     ON DELETE SET NULL, so deleting a referrer never destroys the attribution
--     row or the referee's pending reward; referee_id is ON DELETE CASCADE.
--   * 11.7 link namespace: codes carry a reserved "BARA-" prefix and reuse /r/*.
-- The exactly-once payout guard is referral_reward_grants(referee_sub_hash,
-- role), keyed on the referee's provider-sub hash (stable across delete +
-- reinstall), NOT on the reinstallable referral/referee id. Mirrors
-- onboarding_box_grant's insert-first idempotency.
--
-- NOTE: the @@unique([userId, reason, refId]) hardening on coin_transactions is
-- intentionally NOT in this migration — it can fail on historical duplicate
-- rows and requires a prod dedupe scan first (REFERRAL_FEATURE_RESEARCH.md
-- §4D/§10). The primary payout guard above does not depend on it.

-- AlterTable: this user's own invite code + the audit-only code they signed up with
ALTER TABLE "users" ADD COLUMN "referral_code" TEXT;
ALTER TABLE "users" ADD COLUMN "referred_by_code" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_referral_code_key" ON "users"("referral_code");

-- CreateTable: attribution ledger (who referred whom; written once at signup, M1)
CREATE TABLE "referrals" (
    "id" TEXT NOT NULL,
    "referrer_id" TEXT,
    "referee_id" TEXT NOT NULL,
    "referee_sub_hash" TEXT NOT NULL,
    "code" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referrals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referrals_referee_id_key" ON "referrals"("referee_id");
CREATE UNIQUE INDEX "referrals_referee_sub_hash_key" ON "referrals"("referee_sub_hash");
CREATE INDEX "referrals_referrer_id_idx" ON "referrals"("referrer_id");

-- CreateTable: payout ledger (which side was paid; minted at first qualifying
-- race completion, M2). Insert-first inside the grant txn => exactly-once per
-- human per role across delete+reinstall.
CREATE TABLE "referral_reward_grants" (
    "id" TEXT NOT NULL,
    "referral_id" TEXT,
    "user_id" TEXT,
    "role" TEXT NOT NULL,
    "referee_sub_hash" TEXT NOT NULL,
    "coins" INTEGER,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_reward_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_reward_grants_referee_sub_hash_role_key" ON "referral_reward_grants"("referee_sub_hash", "role");
CREATE INDEX "referral_reward_grants_referee_sub_hash_idx" ON "referral_reward_grants"("referee_sub_hash");
CREATE INDEX "referral_reward_grants_user_id_idx" ON "referral_reward_grants"("user_id");

-- AddForeignKey
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_fkey"
    FOREIGN KEY ("referrer_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referee_id_fkey"
    FOREIGN KEY ("referee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_reward_grants" ADD CONSTRAINT "referral_reward_grants_referral_id_fkey"
    FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- user_id is SET NULL (not CASCADE) so the abuse-dedup row outlives the account
-- and a delete+reinstall human cannot re-farm a reward (see schema comment / §8.2).
ALTER TABLE "referral_reward_grants" ADD CONSTRAINT "referral_reward_grants_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
