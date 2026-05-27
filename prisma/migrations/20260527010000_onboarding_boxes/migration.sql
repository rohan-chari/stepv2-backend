-- "Join your first race" onboarding. Additive and backward-compatible.

-- Account-scoped flag: has the user seen (joined or skipped) the first-race
-- onboarding step. Defaults false so existing rows and older clients (which
-- ignore the field) are unaffected.
ALTER TABLE "users" ADD COLUMN "first_race_onboarding_seen" BOOLEAN NOT NULL DEFAULT false;

-- One-time ledger of the bonus mystery-box grant, keyed on a SHA-256 hash of
-- the Apple sub (never the raw sub). Survives account deletion (rows here are
-- never removed), which is what makes the one-time grant abuse-proof.
CREATE TABLE "onboarding_box_grant" (
  "apple_sub_hash" TEXT PRIMARY KEY,
  "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
