CREATE TYPE "RacePayoutPreset" AS ENUM (
  'winner_takes_all',
  'top3_70_20_10',
  'top3_80_15_5'
);

CREATE TYPE "RaceBuyInStatus" AS ENUM (
  'none',
  'held',
  'committed',
  'refunded'
);

ALTER TABLE "races"
ADD COLUMN "buy_in_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "payout_preset" "RacePayoutPreset" NOT NULL DEFAULT 'winner_takes_all',
ADD COLUMN "pot_coins" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "race_participants"
ADD COLUMN "buy_in_amount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "buy_in_status" "RaceBuyInStatus" NOT NULL DEFAULT 'none',
ADD COLUMN "payout_coins" INTEGER NOT NULL DEFAULT 0;
