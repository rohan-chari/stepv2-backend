-- AlterTable
ALTER TABLE "users" ADD COLUMN     "appearance_revision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "character_wardrobes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "character_key" TEXT NOT NULL,
    "character_shop_item_id" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "character_wardrobes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_wardrobe_items" (
    "wardrobe_id" TEXT NOT NULL,
    "slot" "AccessorySlot" NOT NULL,
    "shop_item_id" TEXT NOT NULL,

    CONSTRAINT "character_wardrobe_items_pkey" PRIMARY KEY ("wardrobe_id","slot")
);

-- CreateTable
CREATE TABLE "shop_item_character_fits" (
    "accessory_shop_item_id" TEXT NOT NULL,
    "character_key" TEXT NOT NULL,
    "character_shop_item_id" TEXT,

    CONSTRAINT "shop_item_character_fits_pkey" PRIMARY KEY ("accessory_shop_item_id","character_key")
);

-- CreateIndex
CREATE INDEX "character_wardrobes_character_shop_item_id_idx" ON "character_wardrobes"("character_shop_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_wardrobes_user_id_character_key_key" ON "character_wardrobes"("user_id", "character_key");

-- CreateIndex
CREATE INDEX "character_wardrobe_items_shop_item_id_idx" ON "character_wardrobe_items"("shop_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "character_wardrobe_items_wardrobe_id_shop_item_id_key" ON "character_wardrobe_items"("wardrobe_id", "shop_item_id");

-- CreateIndex
CREATE INDEX "shop_item_character_fits_character_key_accessory_shop_item__idx" ON "shop_item_character_fits"("character_key", "accessory_shop_item_id");

-- AddForeignKey
ALTER TABLE "character_wardrobes" ADD CONSTRAINT "character_wardrobes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_wardrobes" ADD CONSTRAINT "character_wardrobes_character_shop_item_id_fkey" FOREIGN KEY ("character_shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_wardrobe_items" ADD CONSTRAINT "character_wardrobe_items_wardrobe_id_fkey" FOREIGN KEY ("wardrobe_id") REFERENCES "character_wardrobes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_wardrobe_items" ADD CONSTRAINT "character_wardrobe_items_shop_item_id_fkey" FOREIGN KEY ("shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_item_character_fits" ADD CONSTRAINT "shop_item_character_fits_accessory_shop_item_id_fkey" FOREIGN KEY ("accessory_shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shop_item_character_fits" ADD CONSTRAINT "shop_item_character_fits_character_shop_item_id_fkey" FOREIGN KEY ("character_shop_item_id") REFERENCES "shop_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "users" ADD CONSTRAINT "users_appearance_revision_nonnegative" CHECK (appearance_revision >= 0);
ALTER TABLE "character_wardrobes" ADD CONSTRAINT "wardrobe_revision_nonnegative" CHECK (revision >= 0), ADD CONSTRAINT "wardrobe_character_identity" CHECK ((character_key = 'default' AND character_shop_item_id IS NULL) OR (character_key <> 'default' AND character_key = character_shop_item_id AND character_shop_item_id IS NOT NULL));
ALTER TABLE "shop_item_character_fits" ADD CONSTRAINT "fit_character_identity" CHECK ((character_key = 'default' AND character_shop_item_id IS NULL) OR (character_key <> 'default' AND character_key = character_shop_item_id AND character_shop_item_id IS NOT NULL));
ALTER TABLE "character_wardrobe_items" ADD CONSTRAINT "wardrobe_accessory_slots" CHECK (slot::text IN ('HEAD','FACE','NECK','BACK','FEET'));
