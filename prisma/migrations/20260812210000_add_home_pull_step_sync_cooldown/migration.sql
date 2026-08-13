-- Additive nullable timestamp. No backfill: only a capable client explicitly
-- opting into `X-Step-Sync-Intent: home-pull` may ever consume the cooldown.
ALTER TABLE "users"
  ADD COLUMN "last_home_pull_step_sync_at" TIMESTAMP(3);
