-- AlterTable
ALTER TABLE "races"
  ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "max_participants" INTEGER NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "race_participants"
  ADD COLUMN "max_bonus_steps" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "races_is_public_status_idx" ON "races"("is_public", "status");
