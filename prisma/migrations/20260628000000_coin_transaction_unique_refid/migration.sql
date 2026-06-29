-- Defense-in-depth: make awardCoins' (userId, reason, refId) idempotency a
-- DATABASE invariant, not just an app-level findFirst-then-create (which can
-- double-grant under concurrency). Replaces the historical NON-unique index with
-- a UNIQUE one. Rows with ref_id IS NULL never collide (Postgres treats NULLs as
-- distinct in a unique index), so coin grants that pass no refId are unaffected.
--
-- ⚠️ PREREQUISITE: this migration ERRORS if duplicate (user_id, reason, ref_id)
-- rows already exist in the target DB. Run the dedupe scan FIRST:
--     node scripts/dedupe-coin-transactions.js --db=prod        (dry run)
--     node scripts/dedupe-coin-transactions.js --db=prod --fix  (clean)
-- See REFERRAL_FEATURE_RESEARCH.md §4D/§10.

-- DropIndex
DROP INDEX "coin_transactions_user_id_reason_ref_id_idx";

-- CreateIndex
CREATE UNIQUE INDEX "coin_transactions_user_id_reason_ref_id_key" ON "coin_transactions"("user_id", "reason", "ref_id");
