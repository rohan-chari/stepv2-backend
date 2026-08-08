-- Batch 2026-08-08 item 1: discard powerups for coins.
--
-- No columns change. The feature adds a per-user, per-local-day cap on
-- `powerup_discard` coin awards, and the cap query sums
-- coin_transactions for one user / one reason / one local calendar day.
--
-- coin_transactions today carries only @@index([user_id]), so that sum would
-- scan a heavy user's ENTIRE ledger on every discard — the hot path of a
-- button a user can tap repeatedly. This composite index makes the cap query
-- an index range scan instead.
--
-- Purely additive: an index is invisible to old backend code and to every app
-- version. No backfill, no lock beyond the index build itself.

CREATE INDEX "coin_transactions_user_id_reason_created_at_idx"
  ON "coin_transactions"("user_id", "reason", "created_at");
