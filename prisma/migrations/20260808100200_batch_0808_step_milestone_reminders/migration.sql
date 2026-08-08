-- Batch 2026-08-08 item 3: evening reminder for uncollected step-milestone coins.
--
-- Additive with a NOT NULL DEFAULT true, mirroring
-- `daily_reward_reminders_enabled` (migration 20260719000000) exactly. The
-- default is `true` because the job itself ships DARK behind
-- STEP_MILESTONE_REMINDERS_DISABLED — the column existing does not send
-- anything.
--
-- Old clients never PATCH this field, so they keep the default; the additive
-- GET field they don't read is ignored. Frozen clients therefore receive this
-- new push type with no in-app opt-out until they update — the same accepted
-- precedent as the daily-reward reminder launch (spec item 3).
--
-- No backfill: DEFAULT true fills every existing row in place.

ALTER TABLE "users"
  ADD COLUMN "step_milestone_reminders_enabled" BOOLEAN NOT NULL DEFAULT true;
