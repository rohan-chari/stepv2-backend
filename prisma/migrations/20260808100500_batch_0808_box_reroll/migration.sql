-- Batch 2026-08-08 item 11: rewarded-ad mystery box reroll (once per roll).
--
-- Additive + NULLABLE with no backfill. NULL means "this powerup has never
-- been rerolled", which is true of every row that already exists — so the
-- once-per-roll guard (`rerolled_at IS NOT NULL` -> 409 ALREADY_REROLLED)
-- reads correctly for historical rows with no data migration.
--
-- The feature ships DARK behind ADS_BOX_REROLL_ENABLED, which defaults OFF
-- (checked `=== 'true'`, read at call time). No shipped app binary knows the
-- reroll endpoint exists, so this column is inert until both the switch is
-- flipped and the carrying App Store build has rolled out.

ALTER TABLE "race_powerups" ADD COLUMN "rerolled_at" TIMESTAMP(3);
