-- Expand-only indexes for the bounded joined-contest activity queries.
-- CONCURRENTLY avoids blocking referral attribution and race joins while the
-- migration builds on a live mixed-version deployment.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "referrals_referrer_id_created_at_idx"
  ON "referrals"("referrer_id", "created_at");
