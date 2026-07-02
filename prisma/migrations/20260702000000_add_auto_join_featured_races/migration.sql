-- Auto-join preference for the seeded daily/weekly featured challenges.
-- Additive and backward-compatible: defaults false so existing accounts and
-- older clients (which never read or send this column) are unaffected. When
-- true, the seeded-race renewal cron enrolls the user into each newly created
-- daily/weekly race, and flipping the toggle on opts them into the
-- already-pending "next" race. Mirrors users.hidden_from_leaderboard.
ALTER TABLE "users" ADD COLUMN "auto_join_featured_races" BOOLEAN NOT NULL DEFAULT false;
