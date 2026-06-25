-- Per-item "bobble" flag: whether the accessory rides the capybara head-bob.
-- Default false so the column add is safe and any future row is explicit.
ALTER TABLE "shop_items" ADD COLUMN "bobble" BOOLEAN NOT NULL DEFAULT false;

-- Backfill to preserve the historical slot-derived behavior EXACTLY:
-- HEAD/FACE/NECK accessories bobbed with the head; BACK/FEET did not. Existing
-- bobbing items therefore become true; everything else (incl. the BACK backpack
-- and FEET shoes) stays false. Admins can flip individual items afterward.
UPDATE "shop_items" SET "bobble" = true WHERE "slot" IN ('HEAD', 'FACE', 'NECK');
