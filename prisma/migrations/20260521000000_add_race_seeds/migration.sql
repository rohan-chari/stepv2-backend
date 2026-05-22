-- CreateEnum
CREATE TYPE "RaceSeedCadence" AS ENUM ('daily', 'weekly');

-- CreateTable
CREATE TABLE "race_seeds" (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "target_steps" INTEGER NOT NULL,
  "duration_hours" INTEGER NOT NULL,
  "cadence" "RaceSeedCadence" NOT NULL,
  "max_participants" INTEGER NOT NULL DEFAULT 100,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "race_seeds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "race_seeds_kind_key" ON "race_seeds"("kind");

-- AlterTable: allow seeded races to have no creator
ALTER TABLE "races" DROP CONSTRAINT "races_creator_id_fkey";
ALTER TABLE "races" ALTER COLUMN "creator_id" DROP NOT NULL;
ALTER TABLE "races" ADD CONSTRAINT "races_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: link races to their seed (NULL for user-created races)
ALTER TABLE "races" ADD COLUMN "seed_id" TEXT;

-- AddForeignKey
ALTER TABLE "races" ADD CONSTRAINT "races_seed_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "race_seeds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "races_seed_id_status_idx" ON "races"("seed_id", "status");

-- Seed initial recurring races
INSERT INTO "race_seeds" ("id", "kind", "name", "target_steps", "duration_hours", "cadence", "max_participants", "active", "created_at", "updated_at") VALUES
  ('seed-daily-10k',  'DAILY_10K',  'Daily 10K Sprint',     10000, 24,  'daily',  100, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('seed-weekly-50k', 'WEEKLY_50K', 'Weekly 50K Challenge', 50000, 168, 'weekly', 100, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
