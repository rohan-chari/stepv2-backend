-- Rename the featured tournament seed "Bara Bracket" -> "Tourneys" so the card
-- title matches the Public Races TOURNEYS tab (display name only; the stable id
-- `seed-tournament-daily-dash` and kind `DAILY_DASH` are unchanged). Follow-up
-- migration rather than editing applied ones, keeping checksums clean.
UPDATE "tournament_seeds"
  SET "name" = 'Tourneys', "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = 'seed-tournament-daily-dash';

-- Rename any live minted lobby so the change shows immediately (the template
-- rename above only affects newly-minted lobbies).
UPDATE "tournaments"
  SET "name" = 'Tourneys'
  WHERE "seed_id" = 'seed-tournament-daily-dash'
    AND "status" IN ('pending', 'active');
