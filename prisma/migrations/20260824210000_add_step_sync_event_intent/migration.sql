-- Additive durable event classification for COMPLETE sync-v2 replay recovery.
-- NULL preserves mixed-version behavior for reservations finalized by an old
-- worker; new workers only recover an event when the locked classification is
-- known.
ALTER TABLE "step_sync_requests"
ADD COLUMN "daily_existed" BOOLEAN;
