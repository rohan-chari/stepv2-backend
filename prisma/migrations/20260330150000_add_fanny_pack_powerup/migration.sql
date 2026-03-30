ALTER TYPE "PowerupType" ADD VALUE 'fanny_pack';
ALTER TABLE "race_participants" ADD COLUMN "powerup_slots" INTEGER NOT NULL DEFAULT 3;
