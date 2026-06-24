-- Tutorial onboarding step + one-time 100-coin completion reward. Additive and
-- backward-compatible.

-- Account-scoped flag: has the user seen (completed or skipped) the tutorial
-- onboarding step. Defaults false so the new step shows for brand-new accounts;
-- older clients ignore the field. The 100-coin reward itself is NOT gated by
-- this column — it is protected by the CoinTransaction ledger
-- (reason="tutorial_complete"), so this flag only controls the onboarding UI.
ALTER TABLE "users" ADD COLUMN "tutorial_onboarding_seen" BOOLEAN NOT NULL DEFAULT false;

-- Backfill existing accounts to "seen" so users who already finished onboarding
-- are not thrown back into the tutorial step on their next launch. New signups
-- (created after this migration) get the default false and see the step. Anyone
-- backfilled here can still earn the one-time reward later via the in-app
-- "view tutorial" replay button (the reward is ledger-protected, not flag-gated).
UPDATE "users" SET "tutorial_onboarding_seen" = true;
