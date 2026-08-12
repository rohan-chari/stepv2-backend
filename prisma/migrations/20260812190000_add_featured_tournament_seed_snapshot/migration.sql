-- Featured tournament configuration is data, but a lobby must keep the prize
-- it advertised even if its seed is edited before the final settles. Nullable
-- preserves every in-flight legacy lobby's seed-based payout behavior.
ALTER TABLE "tournaments"
  ADD COLUMN "champion_prize_coins_snapshot" INTEGER;

-- A rollout may encounter lobbies minted before this constraint existed. Do
-- not guess which one to cancel: fail before creating the unique index so the
-- operator can inspect and resolve the duplicate safely.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "tournaments"
    WHERE "seed_id" IS NOT NULL
      AND "status" = 'pending'::"TournamentStatus"
    GROUP BY "seed_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'cannot add featured pending-lobby uniqueness: duplicate PENDING tournaments exist per seed; resolve duplicates before retrying migration';
  END IF;
END $$;

-- The database, not renewal timing, is the authority for exactly one open
-- lobby per featured seed. User-created tournaments have a NULL seed_id and
-- remain unconstrained.
CREATE UNIQUE INDEX "tournaments_one_pending_per_seed_key"
  ON "tournaments" ("seed_id")
  WHERE "seed_id" IS NOT NULL
    AND "status" = 'pending'::"TournamentStatus";

-- Keep the original stable id/kind for installed clients and operational
-- controls; only the display label changes.
UPDATE "tournament_seeds"
SET "name" = '4 Racer Tourney',
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-tournament-daily-dash';

-- Insert-only/idempotent configuration for the staged eight-player feature.
-- It ships inactive until the carrying app release has rolled out.
INSERT INTO "tournament_seeds" (
  "id", "kind", "name", "bracket_size", "matchup_duration_days",
  "powerups_enabled", "powerup_step_interval", "champion_prize_coins",
  "active", "created_at", "updated_at"
)
VALUES (
  'seed-tournament-weekly-showdown', 'WEEKLY_SHOWDOWN', '8 Racer Tourney', 8,
  2, TRUE, 2000, 300, FALSE, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO UPDATE
SET "name" = EXCLUDED."name",
    "bracket_size" = EXCLUDED."bracket_size",
    "matchup_duration_days" = EXCLUDED."matchup_duration_days",
    "powerups_enabled" = EXCLUDED."powerups_enabled",
    "powerup_step_interval" = EXCLUDED."powerup_step_interval",
    "champion_prize_coins" = EXCLUDED."champion_prize_coins",
    "active" = EXCLUDED."active",
    "updated_at" = CURRENT_TIMESTAMP;
