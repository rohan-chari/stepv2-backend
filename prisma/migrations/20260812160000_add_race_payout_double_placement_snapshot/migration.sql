-- Nullable for mixed-version safety: an older backend process may still omit
-- the new snapshot while rolling deploys overlap. New code always writes it,
-- and reconciliation fails closed for a claimed row where it is absent.
ALTER TABLE "race_payout_double_offer_items"
  ADD COLUMN "placement_snapshot" INTEGER;

ALTER TABLE "race_payout_double_offer_items"
  ADD CONSTRAINT "race_payout_double_offer_items_placement_snapshot_check"
  CHECK ("placement_snapshot" IS NULL OR "placement_snapshot" > 0);
