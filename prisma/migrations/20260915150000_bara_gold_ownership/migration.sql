-- Bara Gold is additive. Historical UserShopItem rows and billing records are
-- deliberately left untouched; nullable provenance is safe during a mixed
-- old/new deployment.
ALTER TABLE "billing_purchases"
  ADD COLUMN "benefit_contract" TEXT;

ALTER TABLE "billing_subscriptions"
  ADD COLUMN "benefit_contract" TEXT;

CREATE TABLE "shop_item_ownership_sources" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "shop_item_id" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "verified_transaction_ref" TEXT,
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "shop_item_ownership_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_item_ownership_sources_verified_transaction_ref_key"
  ON "shop_item_ownership_sources"("verified_transaction_ref");
CREATE UNIQUE INDEX "shop_item_ownership_sources_user_id_shop_item_id_source_key"
  ON "shop_item_ownership_sources"("user_id", "shop_item_id", "source");
CREATE INDEX "shop_item_ownership_sources_user_id_shop_item_id_revoked_at_idx"
  ON "shop_item_ownership_sources"("user_id", "shop_item_id", "revoked_at");
CREATE INDEX "shop_item_ownership_sources_shop_item_id_revoked_at_idx"
  ON "shop_item_ownership_sources"("shop_item_id", "revoked_at");

ALTER TABLE "shop_item_ownership_sources"
  ADD CONSTRAINT "shop_item_ownership_sources_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_item_ownership_sources"
  ADD CONSTRAINT "shop_item_ownership_sources_shop_item_id_fkey"
  FOREIGN KEY ("shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Populate only rows that are already present. This is a server-side
-- compatibility matrix, not a catalog seeder; absent Gold character rows are
-- intentionally not invented by this migration.
INSERT INTO "shop_item_character_fits"("accessory_shop_item_id", "character_key", "character_shop_item_id")
SELECT accessory.id, character.id, character.id
FROM "shop_items" accessory
JOIN "shop_items" character ON character.slot = 'CHARACTER'
WHERE character.sku IN ('mouse', 'hedgehog', 'sea_lion')
  AND accessory.slot <> 'CHARACTER'
  AND accessory.sku <> 'football_helmet'
  AND (character.sku <> 'sea_lion' OR accessory.sku <> 'trail_shoes')
ON CONFLICT DO NOTHING;
