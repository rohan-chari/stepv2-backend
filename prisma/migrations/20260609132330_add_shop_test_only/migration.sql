-- Add a test-only visibility gate to the cosmetic and powerup catalogs.
-- Purely additive and non-breaking: default false means every existing row
-- stays prod-visible, and old app binaries (which never send X-Release-Channel)
-- resolve to the prod channel and see exactly the same item set as before.
ALTER TABLE "shop_items" ADD COLUMN "test_only" boolean NOT NULL DEFAULT false;
ALTER TABLE "powerup_shop_items" ADD COLUMN "test_only" boolean NOT NULL DEFAULT false;
