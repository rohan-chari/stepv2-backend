-- Global-leaderboard opt-out preference. Additive and backward-compatible.

-- Account-scoped flag: when true, the user is hidden from OTHER users' GLOBAL
-- step leaderboard (both the top list and the rank count). They remain visible
-- to their friends, and still see their own global rank via the self-rank
-- fallback in getLeaderboard. Defaults false so existing accounts stay visible
-- and older clients (which never read this column) are unaffected. New signups
-- also get the default false. Mirrors users.is_review_account.
ALTER TABLE "users" ADD COLUMN "hidden_from_leaderboard" BOOLEAN NOT NULL DEFAULT false;
