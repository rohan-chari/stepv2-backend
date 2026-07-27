-- Batch 2026-07-26.
--
-- Item 16: when a participant's persisted total was last written, so GET /races
-- can surface `teams.asOf` without recomputing live totals on the hottest screen.
-- Nullable + additive: existing rows read NULL and the client hides the
-- staleness affordance, exactly as it does against an older backend.
ALTER TABLE "race_participants" ADD COLUMN "totals_updated_at" TIMESTAMP(3);

-- Item 9: per-local-day character snapshot. `animal` NULL = the default
-- capybara. localDayKey '1970-01-01' is the reserved baseline row. A user with
-- no rows resolves to their live equip (pre-migration behaviour), so this table
-- starts empty and backfills itself as users switch characters.
CREATE TABLE "user_character_days" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "local_day_key" TEXT NOT NULL,
    "animal" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_character_days_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_character_days_user_id_local_day_key_idx" ON "user_character_days"("user_id", "local_day_key");

CREATE UNIQUE INDEX "user_character_days_user_id_local_day_key_key" ON "user_character_days"("user_id", "local_day_key");

ALTER TABLE "user_character_days" ADD CONSTRAINT "user_character_days_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
