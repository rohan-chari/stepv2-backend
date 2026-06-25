-- Per-race opt-out for live placement-change pushes (Phase 0). When true, the
-- placementRecompute job keeps this participant's lastNotifiedPlacement baseline
-- in sync but emits no PLACEMENT_CHANGED event, so they receive neither the
-- visible alert nor the silent refresh for this race. Additive + NOT NULL with a
-- false default, so already-shipped app versions (which never set it) behave
-- exactly as before.
ALTER TABLE "race_participants" ADD COLUMN "placement_alerts_muted" BOOLEAN NOT NULL DEFAULT false;
