-- Remove the character-powers feature (Bara herd bonus, Corgi Zoomies, Turtle Shell).
--
-- Both tables existed ONLY to serve character-power scoring:
--   * character_effect_windows — materialized Corgi Zoomies windows, already
--     pruned on a 45-day retention job, never read by any client.
--   * user_character_days      — per-local-day character snapshots, written on
--     equip solely so herd/Zoomies could score by day.
--
-- No app version, current or frozen, reads either table: they were only ever
-- touched server-side by scoring code that this change deletes. Dropping them is
-- therefore invisible to clients on any release.
DROP TABLE IF EXISTS "character_effect_windows";
DROP TABLE IF EXISTS "user_character_days";
