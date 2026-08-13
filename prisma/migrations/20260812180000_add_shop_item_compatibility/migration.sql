-- Additive and nullable: both the deployed backend and frozen app binaries
-- continue to work while the new code rolls out. Policy enforcement is gated
-- separately by the default-off `accessoryCompatibilityEnforcement` setting.
ALTER TABLE "shop_items" ADD COLUMN "compatibility" JSONB;

-- Seed the initial reusable visual-region policy while enforcement is still
-- dark. The predicates are idempotent in effect and harmless if an environment
-- has not yet cloned these catalog rows.
UPDATE "shop_items"
SET "compatibility" = '{"tags":["full_face"],"blocksTags":["eyewear"]}'::jsonb
WHERE "sku" = 'knight_helmet' AND "compatibility" IS NULL;

UPDATE "shop_items"
SET "compatibility" = '{"tags":["eyewear"]}'::jsonb
WHERE "sku" = 'glasses_3d' AND "compatibility" IS NULL;
