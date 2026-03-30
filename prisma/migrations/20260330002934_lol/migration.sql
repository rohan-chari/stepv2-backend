-- CreateEnum
CREATE TYPE "PowerupType" AS ENUM ('leg_cramp', 'red_card', 'banana_peel', 'compression_socks', 'protein_shake', 'runners_high', 'second_wind', 'stealth_mode');

-- CreateEnum
CREATE TYPE "PowerupRarity" AS ENUM ('common', 'uncommon', 'rare');

-- CreateEnum
CREATE TYPE "PowerupStatus" AS ENUM ('held', 'used', 'discarded', 'expired');

-- CreateEnum
CREATE TYPE "ActiveEffectStatus" AS ENUM ('active_effect', 'expired_effect', 'blocked');

-- AlterTable
ALTER TABLE "race_participants" ADD COLUMN     "bonus_steps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "next_box_at_steps" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "races" ADD COLUMN     "powerup_step_interval" INTEGER,
ADD COLUMN     "powerups_enabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "step_samples" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "steps" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "step_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_powerups" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "PowerupType" NOT NULL,
    "rarity" "PowerupRarity" NOT NULL,
    "status" "PowerupStatus" NOT NULL DEFAULT 'held',
    "earned_at_steps" INTEGER NOT NULL,
    "used_at" TIMESTAMP(3),
    "target_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "race_powerups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_active_effects" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "target_participant_id" TEXT NOT NULL,
    "target_user_id" TEXT NOT NULL,
    "source_user_id" TEXT NOT NULL,
    "powerup_id" TEXT NOT NULL,
    "type" "PowerupType" NOT NULL,
    "status" "ActiveEffectStatus" NOT NULL DEFAULT 'active_effect',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "race_active_effects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_powerup_events" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "powerup_type" "PowerupType",
    "target_user_id" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "race_powerup_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "step_samples_user_id_period_start_period_end_idx" ON "step_samples"("user_id", "period_start", "period_end");

-- CreateIndex
CREATE UNIQUE INDEX "step_samples_user_id_period_start_key" ON "step_samples"("user_id", "period_start");

-- CreateIndex
CREATE INDEX "race_powerups_participant_id_status_idx" ON "race_powerups"("participant_id", "status");

-- CreateIndex
CREATE INDEX "race_powerups_race_id_user_id_idx" ON "race_powerups"("race_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "race_powerups_participant_id_earned_at_steps_key" ON "race_powerups"("participant_id", "earned_at_steps");

-- CreateIndex
CREATE UNIQUE INDEX "race_active_effects_powerup_id_key" ON "race_active_effects"("powerup_id");

-- CreateIndex
CREATE INDEX "race_active_effects_target_participant_id_status_idx" ON "race_active_effects"("target_participant_id", "status");

-- CreateIndex
CREATE INDEX "race_active_effects_race_id_status_idx" ON "race_active_effects"("race_id", "status");

-- CreateIndex
CREATE INDEX "race_powerup_events_race_id_created_at_idx" ON "race_powerup_events"("race_id", "created_at");

-- AddForeignKey
ALTER TABLE "step_samples" ADD CONSTRAINT "step_samples_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_powerups" ADD CONSTRAINT "race_powerups_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_powerups" ADD CONSTRAINT "race_powerups_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "race_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_active_effects" ADD CONSTRAINT "race_active_effects_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_active_effects" ADD CONSTRAINT "race_active_effects_target_participant_id_fkey" FOREIGN KEY ("target_participant_id") REFERENCES "race_participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_active_effects" ADD CONSTRAINT "race_active_effects_powerup_id_fkey" FOREIGN KEY ("powerup_id") REFERENCES "race_powerups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_powerup_events" ADD CONSTRAINT "race_powerup_events_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;
