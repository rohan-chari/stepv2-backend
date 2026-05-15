ALTER TABLE "shop_items" ADD COLUMN "render_metadata" JSONB;

UPDATE "shop_items"
SET "render_metadata" = '{"offsetX":-0.015,"offsetY":0.03,"rotation":-0.14}'::jsonb
WHERE "sku" = 'cowboy_hat';

INSERT INTO "shop_items" (
    "id",
    "sku",
    "name",
    "description",
    "slot",
    "price_coins",
    "asset_key",
    "render_metadata",
    "active",
    "sort_order"
) VALUES (
    'shop-baseball-cap',
    'baseball_cap',
    'Baseball Cap',
    'A clean cap for race day.',
    'HEAD',
    0,
    'baseball_cap',
    '{"offsetX":-0.01,"offsetY":0.02,"rotation":-0.08}'::jsonb,
    true,
    20
)
ON CONFLICT ("sku") DO UPDATE SET
    "name" = EXCLUDED."name",
    "description" = EXCLUDED."description",
    "slot" = EXCLUDED."slot",
    "price_coins" = EXCLUDED."price_coins",
    "asset_key" = EXCLUDED."asset_key",
    "render_metadata" = EXCLUDED."render_metadata",
    "active" = EXCLUDED."active",
    "sort_order" = EXCLUDED."sort_order";
