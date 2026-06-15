-- Add Google as a parallel auth provider (Android). Additive + backward-compatible:
-- existing Apple-keyed rows are untouched, and old iOS clients are unaffected.
--
--  * apple_id becomes NULLABLE so a pure-Google user can exist without a fake
--    Apple id. Its UNIQUE index is KEPT — Postgres allows multiple NULLs, so any
--    number of Google-only users (null apple_id) coexist.
--  * google_sub is a new nullable column with its own unique index.
--
-- DROP NOT NULL only — the existing "users_apple_id_key" unique index is left in
-- place. No data is rewritten.
ALTER TABLE "users" ALTER COLUMN "apple_id" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "google_sub" TEXT;
CREATE UNIQUE INDEX "users_google_sub_key" ON "users"("google_sub");
