-- Store powerups + IMPOSTER (1.1.7). ADDITIVE ONLY.
--
-- Back-compat: no existing enum value, column, table, or constraint is dropped
-- or renamed; nothing on the cosmetic shop (shop_items / GET /shop/catalog) is
-- touched. Old app versions and the current backend remain compatible. All new
-- objects are guarded with IF NOT EXISTS so re-applying is a no-op.
--
-- NOTE: `ALTER TYPE ... ADD VALUE` cannot run in the same transaction as
-- statements that USE the new value. The CREATE TABLEs below only reference the
-- PowerupType *type* (column definitions), not the new literal value, so they
-- are safe to run after the ALTER TYPE without committing in between. If applied
-- by hand and Postgres complains, run this ALTER TYPE line on its own first.

-- 1) Additive enum value. Purchase-only powerup; never rolls from mystery boxes.
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'imposter' BEFORE 'mystery_box';

-- 2) Coin-purchasable powerup catalog (separate from cosmetic shop_items).
CREATE TABLE IF NOT EXISTS "powerup_shop_items" (
  "id"           TEXT NOT NULL,
  "sku"          TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "description"  TEXT,
  "price_coins"  INTEGER NOT NULL,
  "powerup_type" "PowerupType" NOT NULL,
  "active"       BOOLEAN NOT NULL DEFAULT true,
  "sort_order"   INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "powerup_shop_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "powerup_shop_items_sku_key"
  ON "powerup_shop_items" ("sku");
CREATE INDEX IF NOT EXISTS "powerup_shop_items_active_sort_order_idx"
  ON "powerup_shop_items" ("active", "sort_order");

-- 3) Per-user global powerup inventory (quantity owned per type).
CREATE TABLE IF NOT EXISTS "user_powerup_items" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "powerup_type" "PowerupType" NOT NULL,
  "quantity"     INTEGER NOT NULL DEFAULT 0,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_powerup_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "user_powerup_items_user_id_powerup_type_key"
  ON "user_powerup_items" ("user_id", "powerup_type");
CREATE INDEX IF NOT EXISTS "user_powerup_items_user_id_idx"
  ON "user_powerup_items" ("user_id");

-- 4) Idempotency ledger for powerup-store purchases.
CREATE TABLE IF NOT EXISTS "powerup_purchase_requests" (
  "id"                   TEXT NOT NULL,
  "user_id"              TEXT NOT NULL,
  "idempotency_key"      TEXT NOT NULL,
  "powerup_shop_item_id" TEXT NOT NULL,
  "status"               TEXT NOT NULL,
  "coins_spent"          INTEGER NOT NULL DEFAULT 0,
  "result_json"          JSONB,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "powerup_purchase_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "powerup_purchase_requests_user_id_idempotency_key_key"
  ON "powerup_purchase_requests" ("user_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "powerup_purchase_requests_powerup_shop_item_id_idx"
  ON "powerup_purchase_requests" ("powerup_shop_item_id");

-- 5) Foreign keys (user_powerup_items, powerup_purchase_requests → users).
DO $$ BEGIN
  ALTER TABLE "user_powerup_items"
    ADD CONSTRAINT "user_powerup_items_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "powerup_purchase_requests"
    ADD CONSTRAINT "powerup_purchase_requests_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
