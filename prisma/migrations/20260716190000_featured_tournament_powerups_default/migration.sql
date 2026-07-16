-- Enable powerups by default on the featured tournament seed (Bara Bracket) so
-- newly-minted featured lobbies grant powerup boxes. Also flip any currently-open
-- PENDING featured lobby so the change takes effect immediately (the live ACTIVE
-- bracket that already started keeps whatever it was minted with).
UPDATE "tournament_seeds"
  SET "powerups_enabled" = true,
      "powerup_step_interval" = 2500,
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "id" = 'seed-tournament-daily-dash';

UPDATE "tournaments"
  SET "powerups_enabled" = true,
      "powerup_step_interval" = 2500
  WHERE "seed_id" = 'seed-tournament-daily-dash'
    AND "status" = 'pending';
