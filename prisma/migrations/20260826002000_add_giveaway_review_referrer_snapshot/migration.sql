-- Immutable server-owned entrant/referrer identity for direct, bounded review
-- activity reads. Nullable keeps old workers compatible during rolling deploy.
ALTER TABLE "giveaway_point_reviews"
  ADD COLUMN IF NOT EXISTS "referrer_id_snapshot" TEXT;

UPDATE "giveaway_point_reviews" review
SET "referrer_id_snapshot" = fact."referrer_id"
FROM "referral_qualification_facts" fact
WHERE review."referrer_id_snapshot" IS NULL
  AND fact."referral_fact_id" = review."referral_fact_id"
  AND fact."referrer_id" IS NOT NULL;

-- Old workers can review a legacy live Referral before a durable qualification
-- fact exists. Only terminal/reviewable live states are ownership-safe; PENDING
-- weak attribution is deliberately excluded because it can still be replaced.
UPDATE "giveaway_point_reviews" review
SET "referrer_id_snapshot" = referral."referrer_id"
FROM "referrals" referral
WHERE review."referrer_id_snapshot" IS NULL
  AND referral."id" = review."referral_fact_id"
  AND referral."referrer_id" IS NOT NULL
  AND referral."qualified_at" IS NOT NULL
  AND referral."status" IN ('FLAGGED', 'QUALIFIED', 'REWARDED');

CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "giveaway_reviews_referrer_recent_idx"
  ON "giveaway_point_reviews"(
    "contest_id",
    "referrer_id_snapshot",
    "decided_at",
    "id"
  );
