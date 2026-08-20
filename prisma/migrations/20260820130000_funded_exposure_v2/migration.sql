-- Additive, mixed-version-safe funded-prize version stamps. Existing rows keep
-- version 1/null values and therefore retain the historical unit-20 formula.
ALTER TABLE "races"
  ADD COLUMN "prize_coin_unit" INTEGER,
  ADD COLUMN "prize_pool_max_coins" INTEGER,
  ADD COLUMN "prize_calculation_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "tournaments"
  ADD COLUMN "prize_coin_unit" INTEGER,
  ADD COLUMN "tournament_champion_max_coins" INTEGER,
  ADD COLUMN "prize_calculation_version" INTEGER NOT NULL DEFAULT 1;

-- Nullable during the dual-write window. The guarded activation audit must
-- prove zero nulls among live accepted funded memberships before enforcement.
ALTER TABLE "race_participants"
  ADD COLUMN "funded_exposure_millicoins" INTEGER,
  ADD COLUMN "funded_exposure_rate_millicoins_per_day" INTEGER;

ALTER TABLE "tournament_participants"
  ADD COLUMN "funded_exposure_millicoins" INTEGER,
  ADD COLUMN "funded_exposure_rate_millicoins_per_day" INTEGER;

CREATE TABLE "funded_exposure_guards" (
  "user_id" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "funded_exposure_guards_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "funded_exposure_guards_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
