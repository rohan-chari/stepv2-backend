-- Race results "seen" acknowledgment. Purely additive + display-only (does NOT
-- feed the box/powerup roll gate). Old app builds never read/ack this field.
ALTER TABLE "race_participants" ADD COLUMN "results_seen_at" TIMESTAMP;

-- Backfill: mark every already-ended race as seen so only races that finish
-- AFTER this ships trigger the popup. Only COMPLETED/CANCELLED races are "ended";
-- ACTIVE/PENDING participants stay NULL so future completions still show.
UPDATE "race_participants" rp
SET "results_seen_at" = NOW()
FROM "races" r
WHERE rp."race_id" = r."id"
  AND r."status" IN ('COMPLETED', 'CANCELLED');
