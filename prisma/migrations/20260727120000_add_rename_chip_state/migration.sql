-- Home SETUP section — persist the rename-chip nudge state on the ACCOUNT.
--
-- The chip's "shown count" / "dismissed" state used to live in device-scoped
-- SharedPreferences, which AuthService.signOut() deliberately wipes, so the chip
-- re-appeared after every sign-out/sign-in cycle. Moving it onto the user row
-- mirrors the existing profile_photo_prompt_dismissed_at column.
--
-- Additive and back-compatible in both directions:
--   * Old app builds (<= 2.0.1) never read or write these columns; they keep
--     using their local prefs. Behavior byte-for-byte unchanged.
--   * The currently-deployed backend code ignores unknown columns, so this is
--     safe to apply before the new code rolls out.
--
-- No backfill (docs/home-setup-section-requirements.md §5): every existing row
-- starts at 0 / NULL, i.e. eligible. Users who already dismissed the chip locally
-- may see it up to 3 more times, once — deliberately preferred over backfilling
-- dismissed_at = now() for the whole base, which would silently retire the nudge
-- for users who never saw it.
--
-- ADD COLUMN ... DEFAULT does not rewrite the table on Postgres 11+, so this is a
-- fast, non-locking migration on the prod users table.
ALTER TABLE "users"
  ADD COLUMN "rename_chip_shown_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rename_chip_dismissed_at" TIMESTAMP(3);
