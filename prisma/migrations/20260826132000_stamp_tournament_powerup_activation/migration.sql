-- Replay identity for prospective tournament powerup activation. Nullable and
-- additive, so old binaries and every non-matchup race remain unchanged.
ALTER TABLE "races"
  ADD COLUMN "tournament_powerups_activated_at" TIMESTAMPTZ(3);
