-- The immutable CDN object is deployed before this pointer is published.
-- Frozen clients without remote-assets support continue using bundled art.
UPDATE "powerup_shop_items"
SET "asset_version" = '41ae2b8a805a'
WHERE "powerup_type" = 'hitchhike'::"PowerupType";
