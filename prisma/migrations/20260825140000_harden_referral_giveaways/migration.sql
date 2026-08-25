-- Exactly one contest may own the published lifecycle globally. This is a
-- database invariant rather than an application-level check so two workers
-- cannot publish different drafts concurrently.
CREATE UNIQUE INDEX "giveaway_contests_one_published_idx"
  ON "giveaway_contests" ((1))
  WHERE "lifecycle_status" = 'PUBLISHED';

-- Idempotency receipts survive independent of a contest/audit row and serialize
-- simultaneous first use of the same key across every admin mutation.
CREATE TABLE "giveaway_idempotency_receipts" (
  "id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "method" TEXT NOT NULL,
  "contest_id" TEXT,
  "request_hash" TEXT NOT NULL,
  "response_body" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_idempotency_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "giveaway_idempotency_receipts_actor_id_idempotency_key_key"
  ON "giveaway_idempotency_receipts"("actor_id", "idempotency_key");
CREATE INDEX "giveaway_idempotency_receipts_created_at_idx"
  ON "giveaway_idempotency_receipts"("created_at");

-- A review is durable evidence, not an ownership relationship to live social
-- data. Snapshot the minimal fact and remove the FK that prevented deletion of
-- either participant through the referral cascade.
ALTER TABLE "giveaway_point_reviews"
  ADD COLUMN "qualified_at_snapshot" TIMESTAMP(3),
  ADD COLUMN "qualifying_race_id_snapshot" TEXT,
  ADD COLUMN "referral_status_snapshot" TEXT;

UPDATE "giveaway_point_reviews" AS review
SET "qualified_at_snapshot" = referral."qualified_at",
    "qualifying_race_id_snapshot" = referral."qualifying_race_id",
    "referral_status_snapshot" = referral."status"
FROM "referrals" AS referral
WHERE referral."id" = review."referral_fact_id";

-- Historical rows without a stamped qualification should not normally exist;
-- decided_at is the safest immutable fallback during a mixed-version rollout.
UPDATE "giveaway_point_reviews"
SET "qualified_at_snapshot" = "decided_at"
WHERE "qualified_at_snapshot" IS NULL;
UPDATE "giveaway_point_reviews"
SET "referral_status_snapshot" = 'UNKNOWN'
WHERE "referral_status_snapshot" IS NULL;

ALTER TABLE "giveaway_point_reviews"
  ALTER COLUMN "qualified_at_snapshot" SET NOT NULL,
  ALTER COLUMN "referral_status_snapshot" SET NOT NULL;
ALTER TABLE "giveaway_point_reviews"
  DROP CONSTRAINT "giveaway_point_reviews_referral_fact_id_fkey";
