-- Additive occurrence identity for reinviting a declined tournament
-- participant. Old backend binaries ignore this default-safe column.
ALTER TABLE "tournament_participants"
  ADD COLUMN "invite_version" INTEGER NOT NULL DEFAULT 0;
