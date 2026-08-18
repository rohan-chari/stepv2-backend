-- Payout-rounding v1 is additive. Existing races/tournaments retain version 0
-- forever; new creation code decides whether to stamp version 1.
ALTER TABLE "races"
  ADD COLUMN "payout_rounding_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payout_rounding_metadata" JSONB;

ALTER TABLE "tournaments"
  ADD COLUMN "payout_rounding_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "payout_rounding_metadata" JSONB;

-- Per-recipient durable settlement artifact. It is metadata on the one
-- idempotent existing coin credit, never a second economic ledger entry.
ALTER TABLE "coin_transactions"
  ADD COLUMN "payout_metadata" JSONB;
