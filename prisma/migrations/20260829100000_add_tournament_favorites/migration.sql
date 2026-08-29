-- Additive, nullable, mixed-version-safe tournament favorite state.
-- Existing memberships remain unpinned (NULL); no backfill is required.
ALTER TABLE "tournament_participants"
  ADD COLUMN "favorited_at" TIMESTAMP(3);

CREATE INDEX "tournament_participants_user_id_favorited_at_idx"
  ON "tournament_participants"("user_id", "favorited_at");
