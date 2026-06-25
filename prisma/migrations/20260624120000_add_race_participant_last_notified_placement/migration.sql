-- Live placement broadcast (Phase 0): last live rank we notified this
-- participant about, enabling idempotent change detection in the
-- placementRecompute job. NULL = baseline not yet seeded (first observation
-- seeds it silently). Additive + nullable and never returned by any API
-- response, so already-shipped app versions are unaffected.
ALTER TABLE "race_participants" ADD COLUMN "last_notified_placement" INTEGER;
