-- Preserve contest qualification without changing the frozen ordinary
-- referral account-deletion contract (referrals.referee_id remains CASCADE).
CREATE TABLE "referral_qualification_facts" (
  "id" TEXT NOT NULL,
  "referral_fact_id" TEXT NOT NULL,
  "referrer_id" TEXT,
  "referee_identity_hash" TEXT NOT NULL,
  "attribution_source" TEXT,
  "qualifying_race_id" TEXT,
  "qualified_at" TIMESTAMP(3) NOT NULL,
  "referral_created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "referrer_was_review" BOOLEAN NOT NULL DEFAULT false,
  "referee_was_review" BOOLEAN NOT NULL DEFAULT false,
  "status" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "referral_qualification_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_qualification_facts_referrer_id_fkey"
    FOREIGN KEY ("referrer_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "referral_qualification_facts_referral_fact_id_key"
  ON "referral_qualification_facts"("referral_fact_id");
CREATE UNIQUE INDEX "referral_qualification_facts_referee_identity_hash_key"
  ON "referral_qualification_facts"("referee_identity_hash");
CREATE INDEX "referral_qualification_facts_referrer_id_qualified_at_idx"
  ON "referral_qualification_facts"("referrer_id", "qualified_at");
CREATE INDEX "referral_qualification_facts_qualifying_race_id_idx"
  ON "referral_qualification_facts"("qualifying_race_id");

-- Work ownership must survive the ordinary Referral's shipped referee-delete
-- CASCADE. Snapshot only the minimum fields needed to finish adjudication.
ALTER TABLE "referral_qualification_intents"
  ADD COLUMN "referral_fact_id" TEXT,
  ADD COLUMN "referrer_id_snapshot" TEXT;

UPDATE "referral_qualification_intents" AS intent
SET "referral_fact_id" = referral."id",
    "referrer_id_snapshot" = referral."referrer_id"
FROM "referrals" AS referral
WHERE referral."id" = intent."referral_id";

ALTER TABLE "referral_qualification_intents"
  ALTER COLUMN "referral_fact_id" SET NOT NULL,
  ALTER COLUMN "referral_id" DROP NOT NULL,
  DROP CONSTRAINT "referral_qualification_intents_referral_id_fkey";

ALTER TABLE "referral_qualification_intents"
  ADD CONSTRAINT "referral_qualification_intents_referral_id_fkey"
  FOREIGN KEY ("referral_id") REFERENCES "referrals"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "referral_qualification_intents_referral_id_qualifying_race__key";
CREATE UNIQUE INDEX "referral_qualification_intents_referral_fact_id_qualifying__key"
  ON "referral_qualification_intents"("referral_fact_id", "qualifying_race_id");
CREATE INDEX "referral_qualification_intents_referrer_id_snapshot_processed_idx"
  ON "referral_qualification_intents"("referrer_id_snapshot", "processed_at", "qualified_at");

-- Keep granted_at as the actual mint audit time. This nullable snapshot gives
-- new workers historical cap chronology without reinterpreting legacy rows.
ALTER TABLE "referral_reward_grants"
  ADD COLUMN "qualified_at_snapshot" TIMESTAMP(3);
CREATE INDEX "referral_reward_grants_user_id_role_qualified_at_snapshot_idx"
  ON "referral_reward_grants"("user_id", "role", "qualified_at_snapshot");
