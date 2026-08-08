-- Batch 2026-08-08 item 7: in-app suggestion box.
--
-- A brand-new table: nothing existing reads or writes it, so this is inert for
-- every deployed backend and every app version in the wild.
--
-- ON DELETE CASCADE on the user FK is REQUIRED, not incidental. Account
-- deletion already runs against a 5s transaction timeout (see
-- deleteUserAccount); a RESTRICT/NO ACTION FK here would make a user with
-- feedback rows undeletable. The table is additionally added to
-- deleteUserAccount's explicit deletion set so the delete stays inside one
-- transaction rather than relying on cascade ordering.
--
-- PII stance: `text` is free-form user writing, retained until account
-- deletion, admin-only read access, and cascade-deleted with the account.

CREATE TABLE "suggestions" (
  "id"         TEXT NOT NULL,
  "user_id"    TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  "category"   TEXT,
  "app_version" TEXT,
  "platform"   TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "suggestions_pkey" PRIMARY KEY ("id")
);

-- Backs both reads: the admin list (newest first) and the per-user per-UTC-day
-- rate limit (5/day), which counts a single user's rows in a date range.
CREATE INDEX "suggestions_user_id_created_at_idx" ON "suggestions"("user_id", "created_at");
CREATE INDEX "suggestions_created_at_idx" ON "suggestions"("created_at");

ALTER TABLE "suggestions"
  ADD CONSTRAINT "suggestions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
