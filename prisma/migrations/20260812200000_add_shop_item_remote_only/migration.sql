-- Remote-only accessory art is capability-gated. The non-null default keeps
-- all existing remote-backed rows visible to old bundled-art clients, and
-- keeps old deployed code safe while this migration rolls out.
ALTER TABLE "shop_items"
  ADD COLUMN "remote_only" BOOLEAN NOT NULL DEFAULT FALSE;
