-- Activate the existing canonical featured 8-person seed. Preserve its stable
-- id and kind so installed clients and operational references remain valid.
UPDATE "tournament_seeds"
SET "name" = '8 Racer Tourney',
    "bracket_size" = 8,
    "matchup_duration_days" = 2,
    "powerups_enabled" = FALSE,
    "powerup_step_interval" = NULL,
    "champion_prize_coins" = 150,
    "active" = TRUE,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-tournament-weekly-showdown'
  AND "kind" = 'WEEKLY_SHOWDOWN';
