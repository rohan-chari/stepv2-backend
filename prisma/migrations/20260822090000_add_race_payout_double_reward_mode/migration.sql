-- Expand-only mixed-version migration. Old backend workers omit reward_mode
-- and receive the legacy default; new workers write flat_50 explicitly.
ALTER TABLE "race_payout_double_offers"
  ADD COLUMN "reward_mode" TEXT NOT NULL DEFAULT 'legacy_double';

ALTER TABLE "race_payout_double_offers"
  ADD CONSTRAINT "race_payout_double_offers_reward_mode_check"
  CHECK ("reward_mode" IN ('legacy_double', 'flat_50'));

-- Flat batches can total 50 * N while max_bonus_coins remains the legacy
-- per-race compatibility field (50). Keep the positive/bounded safeguards but
-- remove the obsolete total <= max relationship.
ALTER TABLE "race_payout_double_offers"
  DROP CONSTRAINT "race_payout_double_offers_amount_check";

ALTER TABLE "race_payout_double_offers"
  ADD CONSTRAINT "race_payout_double_offers_amount_check" CHECK (
    "bonus_coins" > 0 AND
    "max_bonus_coins" > 0 AND
    "max_bonus_coins" <= 500 AND
    "rolling_24h_remaining_before_claim" >= 0
  );
