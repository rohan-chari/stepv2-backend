-- Rename the featured tournament seed "Daily Dash" -> "Bara Bracket" (display name
-- only; the stable id `seed-tournament-daily-dash` and kind `DAILY_DASH` are unchanged).
-- Done as a follow-up migration (not by editing the applied add_tournaments migration)
-- so already-migrated environments keep a clean checksum.
UPDATE "tournament_seeds"
  SET "name" = 'Bara Bracket', "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = 'seed-tournament-daily-dash';

-- Rename any live minted lobby so the change shows immediately (the template rename
-- above only affects newly-minted lobbies).
UPDATE "tournaments"
  SET "name" = 'Bara Bracket'
  WHERE "seed_id" = 'seed-tournament-daily-dash'
    AND "status" IN ('pending', 'active');
