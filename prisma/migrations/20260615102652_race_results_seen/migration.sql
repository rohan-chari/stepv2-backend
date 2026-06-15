-- Race results "seen" acknowledgment. Purely additive + display-only (does NOT
-- feed the box/powerup roll gate). Old app builds never read/ack this field.
-- IF NOT EXISTS: a prior deploy attempt committed this ADD COLUMN before the
-- backfill failed, so this migration must be safe to re-apply.
ALTER TABLE "race_participants" ADD COLUMN IF NOT EXISTS "results_seen_at" TIMESTAMP;

-- Backfill: mark every already-ended race as seen so only races that finish
-- AFTER this ships trigger the popup. Only COMPLETED/CANCELLED races are "ended";
-- ACTIVE/PENDING participants stay NULL so future completions still show.
-- RaceStatus enum is @map-ed to lowercase values in Postgres, so compare against
-- 'completed'/'cancelled' (not the uppercase Prisma identifiers).
UPDATE "race_participants" rp
SET "results_seen_at" = NOW()
FROM "races" r
WHERE rp."race_id" = r."id"
  AND r."status" IN ('completed', 'cancelled');
