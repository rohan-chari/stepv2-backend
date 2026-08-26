-- Exact keyset order for the fixed recent-referral candidate pool. Including
-- id avoids sorting every attribution for a high-volume referrer when several
-- referrals share the same creation instant.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "referrals_referrer_id_created_at_id_idx"
  ON "referrals"("referrer_id", "created_at", "id");
