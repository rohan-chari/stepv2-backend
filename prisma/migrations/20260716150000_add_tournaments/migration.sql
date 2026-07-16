-- CreateEnum
CREATE TYPE "TournamentStatus" AS ENUM ('pending', 'active', 'completed', 'cancelled');

-- CreateTable
CREATE TABLE "tournaments" (
  "id" TEXT NOT NULL,
  "creator_id" TEXT,
  "seed_id" TEXT,
  "name" TEXT NOT NULL,
  "status" "TournamentStatus" NOT NULL DEFAULT 'pending',
  "bracket_size" INTEGER NOT NULL,
  "matchup_duration_days" INTEGER NOT NULL,
  "buy_in_amount" INTEGER NOT NULL DEFAULT 0,
  "pot_coins" INTEGER NOT NULL DEFAULT 0,
  "powerups_enabled" BOOLEAN NOT NULL DEFAULT false,
  "powerup_step_interval" INTEGER,
  "is_public" BOOLEAN NOT NULL DEFAULT false,
  "share_token" TEXT,
  "timezone" TEXT,
  "current_round" INTEGER NOT NULL DEFAULT 0,
  "total_rounds" INTEGER NOT NULL,
  "champion_user_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),

  CONSTRAINT "tournaments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_seeds" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "bracket_size" INTEGER NOT NULL,
  "matchup_duration_days" INTEGER NOT NULL,
  "powerups_enabled" BOOLEAN NOT NULL DEFAULT false,
  "powerup_step_interval" INTEGER,
  "champion_prize_coins" INTEGER NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "tournament_seeds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tournament_participants" (
  "id" TEXT NOT NULL,
  "tournament_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" "RaceParticipantStatus" NOT NULL DEFAULT 'invited',
  "seed" INTEGER,
  "eliminated_in_round" INTEGER,
  "buy_in_amount" INTEGER NOT NULL DEFAULT 0,
  "buy_in_status" "RaceBuyInStatus" NOT NULL DEFAULT 'none',
  "buy_in_version" INTEGER NOT NULL DEFAULT 0,
  "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "tournament_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tournaments_share_token_key" ON "tournaments"("share_token");

-- CreateIndex
CREATE INDEX "tournaments_is_public_status_idx" ON "tournaments"("is_public", "status");

-- CreateIndex
CREATE INDEX "tournaments_creator_id_status_idx" ON "tournaments"("creator_id", "status");

-- CreateIndex
CREATE INDEX "tournaments_seed_id_status_idx" ON "tournaments"("seed_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_seeds_kind_key" ON "tournament_seeds"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "tournament_participants_tournament_id_user_id_key" ON "tournament_participants"("tournament_id", "user_id");

-- CreateIndex
CREATE INDEX "tournament_participants_user_id_status_idx" ON "tournament_participants"("user_id", "status");

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_champion_user_id_fkey" FOREIGN KEY ("champion_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournaments" ADD CONSTRAINT "tournaments_seed_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "tournament_seeds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tournament_participants" ADD CONSTRAINT "tournament_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: link matchup races to their tournament round (NULL for ordinary races)
ALTER TABLE "races" ADD COLUMN "tournament_id" TEXT,
ADD COLUMN "tournament_round" INTEGER,
ADD COLUMN "tournament_match_index" INTEGER;

-- AddForeignKey
ALTER TABLE "races" ADD CONSTRAINT "races_tournament_id_fkey" FOREIGN KEY ("tournament_id") REFERENCES "tournaments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex: advancement idempotency backstop — one race per (tournament, round, match)
CREATE UNIQUE INDEX "races_tournament_id_tournament_round_tournament_match_index_key" ON "races"("tournament_id", "tournament_round", "tournament_match_index");

-- CreateIndex
CREATE INDEX "races_tournament_id_status_idx" ON "races"("tournament_id", "status");

-- Seed the launch featured tournament template: "Daily Dash" (D11) — 4-bracket,
-- 1-day matchups, powerups off, free, 150-coin minted champion prize.
INSERT INTO "tournament_seeds"
  ("id", "kind", "name", "bracket_size", "matchup_duration_days", "powerups_enabled", "powerup_step_interval", "champion_prize_coins", "active", "created_at", "updated_at")
VALUES
  ('seed-tournament-daily-dash', 'DAILY_DASH', 'Daily Dash', 4, 1, false, NULL, 150, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
