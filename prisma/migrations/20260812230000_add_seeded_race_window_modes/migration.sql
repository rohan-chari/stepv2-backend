-- Durable, additive window policy for seeded Daily/Weekly placement. Existing
-- code treats an absent row as LEGACY during the schema-present/code-old gap.
CREATE TYPE "SeededRaceWindowMode" AS ENUM ('LEGACY', 'BUCKET');

CREATE TABLE "seeded_race_window_modes" (
  "seed_id" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "mode" "SeededRaceWindowMode" NOT NULL,
  "window_end" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seeded_race_window_modes_pkey" PRIMARY KEY ("seed_id", "window_start"),
  CONSTRAINT "seeded_race_window_modes_seed_id_fkey"
    FOREIGN KEY ("seed_id") REFERENCES "race_seeds"("id") ON DELETE RESTRICT
);

CREATE INDEX "seeded_race_window_modes_window_start_mode_idx"
  ON "seeded_race_window_modes"("window_start", "mode");

-- The automatic bucket-election predicate is append-only capability + opt-in.
-- A partial GIN avoids indexing every legacy account while preserving the
-- existing empty-array default for frozen clients.
CREATE INDEX "users_seeded_bucket_autojoin_capability_idx"
  ON "users" USING GIN ("client_features")
  WHERE "auto_join_featured_races" = TRUE;

-- Classify every still-live legacy window before the new code ever selects a
-- stream. A pre-existing private bucket or BUCKET ledger wins; otherwise the
-- window is LEGACY. Historical/completed windows are intentionally untouched.
INSERT INTO "seeded_race_window_modes" ("seed_id", "window_start", "mode", "window_end")
SELECT DISTINCT ON (r."seed_id", COALESCE(r."scheduled_start_at", r."started_at"))
  r."seed_id",
  COALESCE(r."scheduled_start_at", r."started_at") AS "window_start",
  CASE WHEN EXISTS (
    SELECT 1 FROM "seeded_race_buckets" b
    WHERE b."seed_id" = r."seed_id"
      AND b."window_start" = COALESCE(r."scheduled_start_at", r."started_at")
  ) OR EXISTS (
    SELECT 1 FROM "seeded_race_window_memberships" m
    WHERE m."seed_id" = r."seed_id"
      AND m."window_start" = COALESCE(r."scheduled_start_at", r."started_at")
      AND m."stream" = 'BUCKET'::"SeededRaceWindowStream"
  ) THEN 'BUCKET'::"SeededRaceWindowMode" ELSE 'LEGACY'::"SeededRaceWindowMode" END,
  MAX(r."ends_at") OVER (PARTITION BY r."seed_id", COALESCE(r."scheduled_start_at", r."started_at"))
FROM "races" r
JOIN "race_seeds" s ON s."id" = r."seed_id"
WHERE s."kind" IN ('DAILY_10K', 'WEEKLY_50K')
  AND r."status" IN ('pending'::"RaceStatus", 'active'::"RaceStatus")
  AND COALESCE(r."scheduled_start_at", r."started_at") IS NOT NULL
ORDER BY r."seed_id", COALESCE(r."scheduled_start_at", r."started_at"), r."created_at" ASC
ON CONFLICT ("seed_id", "window_start") DO NOTHING;
