CREATE TABLE "hitchhike_attribution_captures" (
  "effect_id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "source_user_id" TEXT NOT NULL,
  "target_user_id" TEXT NOT NULL,
  "scoring_version" INTEGER NOT NULL,
  "race_timezone" TEXT NOT NULL,
  "cast_day_start" TIMESTAMP(3) NOT NULL,
  "cast_daily_steps" INTEGER NOT NULL DEFAULT 0,
  "cast_sample_boundary_at" TIMESTAMP(3) NOT NULL,
  "scoring_input_generation" BIGINT NOT NULL DEFAULT 0,
  "scoring_input_fingerprint" CHAR(64),
  "raw_source_kind" VARCHAR(32) NOT NULL,
  "raw_source_high_water" INTEGER NOT NULL DEFAULT 0,
  "effective_contribution" INTEGER NOT NULL DEFAULT 0,
  "capture_through" TIMESTAMP(3) NOT NULL,
  "frozen_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "hitchhike_attribution_captures_pkey" PRIMARY KEY ("effect_id"),
  CONSTRAINT "hitchhike_attribution_captures_v3_only"
    CHECK ("scoring_version" = 3),
  CONSTRAINT "hitchhike_attribution_captures_cast_daily_steps_nonnegative"
    CHECK ("cast_daily_steps" >= 0),
  CONSTRAINT "hitchhike_attribution_captures_raw_high_water_nonnegative"
    CHECK ("raw_source_high_water" >= 0),
  CONSTRAINT "hitchhike_attribution_captures_effect_id_fkey"
    FOREIGN KEY ("effect_id") REFERENCES "race_active_effects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "hitchhike_attribution_captures_race_id_idx"
  ON "hitchhike_attribution_captures"("race_id");

CREATE INDEX "hitchhike_attribution_captures_target_window_idx"
  ON "hitchhike_attribution_captures"(
    "target_user_id", "cast_sample_boundary_at", "capture_through"
  );
