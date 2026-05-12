-- Add upgrade_level column to race_powerups
ALTER TABLE "race_powerups"
ADD COLUMN "upgrade_level" INTEGER NOT NULL DEFAULT 0;

-- New audit table for powerup upgrade events
CREATE TABLE "powerup_upgrade_events" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "powerup_id" TEXT NOT NULL,
    "powerup_type" "PowerupType" NOT NULL,
    "tier" INTEGER NOT NULL,
    "cost_coins" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "target_user_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "powerup_upgrade_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "powerup_upgrade_events_user_id_created_at_idx" ON "powerup_upgrade_events"("user_id", "created_at");
CREATE INDEX "powerup_upgrade_events_race_id_created_at_idx" ON "powerup_upgrade_events"("race_id", "created_at");
