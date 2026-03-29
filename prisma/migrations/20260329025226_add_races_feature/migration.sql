-- CreateEnum
CREATE TYPE "RaceStatus" AS ENUM ('pending', 'active', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "RaceParticipantStatus" AS ENUM ('invited', 'accepted', 'declined');

-- CreateTable
CREATE TABLE "races" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_steps" INTEGER NOT NULL,
    "status" "RaceStatus" NOT NULL DEFAULT 'pending',
    "max_duration_days" INTEGER NOT NULL DEFAULT 7,
    "started_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "winner_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "races_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "race_participants" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "status" "RaceParticipantStatus" NOT NULL DEFAULT 'invited',
    "total_steps" INTEGER NOT NULL DEFAULT 0,
    "finished_at" TIMESTAMP(3),
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "race_participants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "races_creator_id_idx" ON "races"("creator_id");

-- CreateIndex
CREATE INDEX "races_status_idx" ON "races"("status");

-- CreateIndex
CREATE INDEX "races_winner_user_id_idx" ON "races"("winner_user_id");

-- CreateIndex
CREATE INDEX "race_participants_user_id_status_idx" ON "race_participants"("user_id", "status");

-- CreateIndex
CREATE INDEX "race_participants_race_id_status_idx" ON "race_participants"("race_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "race_participants_race_id_user_id_key" ON "race_participants"("race_id", "user_id");

-- AddForeignKey
ALTER TABLE "races" ADD CONSTRAINT "races_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "races" ADD CONSTRAINT "races_winner_user_id_fkey" FOREIGN KEY ("winner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_participants" ADD CONSTRAINT "race_participants_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_participants" ADD CONSTRAINT "race_participants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
