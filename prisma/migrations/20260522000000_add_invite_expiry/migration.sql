-- AlterTable: add invite expiry timestamp (idempotent for partial re-runs)
ALTER TABLE "race_participants" ADD COLUMN IF NOT EXISTS "invite_expires_at" TIMESTAMP(3);

-- Backfill: give existing INVITED rows a 24h window from when they joined
-- so they don't all appear "expired" immediately after deploy.
UPDATE "race_participants"
SET "invite_expires_at" = "joined_at" + INTERVAL '24 hours'
WHERE "status" = 'invited' AND "invite_expires_at" IS NULL;

-- CreateIndex: fast lookup for "user's soonest-expiring invite"
CREATE INDEX IF NOT EXISTS "race_participants_user_invite_expires_idx"
  ON "race_participants"("user_id", "status", "invite_expires_at");
