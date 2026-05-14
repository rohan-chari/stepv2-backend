CREATE TYPE "AccessorySlot" AS ENUM ('HEAD', 'FACE', 'NECK', 'BACK');

CREATE TABLE "shop_items" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "slot" "AccessorySlot" NOT NULL,
    "price_coins" INTEGER NOT NULL,
    "asset_key" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shop_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_shop_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "shop_item_id" TEXT NOT NULL,
    "purchased_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_shop_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_equipped_accessories" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "slot" "AccessorySlot" NOT NULL,
    "shop_item_id" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_equipped_accessories_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "shop_purchase_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "shop_item_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "coins_spent" INTEGER NOT NULL DEFAULT 0,
    "result_json" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shop_purchase_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shop_items_sku_key" ON "shop_items"("sku");
CREATE INDEX "shop_items_active_sort_order_idx" ON "shop_items"("active", "sort_order");

CREATE UNIQUE INDEX "user_shop_items_user_id_shop_item_id_key" ON "user_shop_items"("user_id", "shop_item_id");
CREATE INDEX "user_shop_items_shop_item_id_idx" ON "user_shop_items"("shop_item_id");

CREATE UNIQUE INDEX "user_equipped_accessories_user_id_slot_key" ON "user_equipped_accessories"("user_id", "slot");
CREATE INDEX "user_equipped_accessories_shop_item_id_idx" ON "user_equipped_accessories"("shop_item_id");

CREATE UNIQUE INDEX "shop_purchase_requests_user_id_idempotency_key_key" ON "shop_purchase_requests"("user_id", "idempotency_key");
CREATE INDEX "shop_purchase_requests_shop_item_id_idx" ON "shop_purchase_requests"("shop_item_id");

ALTER TABLE "user_shop_items" ADD CONSTRAINT "user_shop_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_shop_items" ADD CONSTRAINT "user_shop_items_shop_item_id_fkey" FOREIGN KEY ("shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_equipped_accessories" ADD CONSTRAINT "user_equipped_accessories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_equipped_accessories" ADD CONSTRAINT "user_equipped_accessories_shop_item_id_fkey" FOREIGN KEY ("shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shop_purchase_requests" ADD CONSTRAINT "shop_purchase_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shop_purchase_requests" ADD CONSTRAINT "shop_purchase_requests_shop_item_id_fkey" FOREIGN KEY ("shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "shop_items" (
    "id",
    "sku",
    "name",
    "description",
    "slot",
    "price_coins",
    "asset_key",
    "active",
    "sort_order"
) VALUES (
    'shop-cowboy-hat',
    'cowboy_hat',
    'Cowboy Hat',
    'A trail-ready hat for race day.',
    'HEAD',
    0,
    'cowboy_hat',
    true,
    10
);
