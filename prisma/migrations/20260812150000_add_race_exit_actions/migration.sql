-- Opt-in ordinary-race leave/forfeit policy.  The NOT NULL default preserves
-- every pre-deploy race as legacy behavior during mixed-version rollout.
ALTER TABLE "races"
  ADD COLUMN "exit_actions_enabled" BOOLEAN NOT NULL DEFAULT false;
