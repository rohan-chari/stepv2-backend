-- CDN-served art (remote assets).
--
-- Additive + NULLABLE on purpose: every existing row keeps `NULL`, which means
-- "the PNG is bundled in the app binary" — the historical behaviour. Old
-- deployed backend code never selects the column, and no shipped app binary
-- knows it exists, so this migration is a no-op for every client in the wild.

ALTER TABLE "shop_items" ADD COLUMN "asset_version" TEXT;
ALTER TABLE "powerup_shop_items" ADD COLUMN "asset_version" TEXT;
