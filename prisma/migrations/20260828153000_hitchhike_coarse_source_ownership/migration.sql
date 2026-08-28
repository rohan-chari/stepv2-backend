ALTER TABLE "hitchhike_attribution_captures"
  ADD COLUMN "coarse_source_from" INTEGER,
  ADD COLUMN "coarse_source_through" INTEGER,
  ADD COLUMN "coarse_raw_attributed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "coarse_effective_contribution" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "hitchhike_attribution_captures"
  ADD CONSTRAINT "hitchhike_attribution_captures_coarse_source_from_nonnegative"
    CHECK ("coarse_source_from" IS NULL OR "coarse_source_from" >= 0),
  ADD CONSTRAINT "hitchhike_attribution_captures_coarse_source_through_nonnegative"
    CHECK ("coarse_source_through" IS NULL OR "coarse_source_through" >= 0),
  ADD CONSTRAINT "hitchhike_attribution_captures_coarse_raw_nonnegative"
    CHECK ("coarse_raw_attributed" >= 0),
  ADD CONSTRAINT "hitchhike_attribution_captures_coarse_source_ordered"
    CHECK (
      "coarse_source_from" IS NULL OR
      "coarse_source_through" IS NULL OR
      "coarse_source_through" >= "coarse_source_from"
    );

CREATE INDEX "hitchhike_attribution_captures_coarse_owner_idx"
  ON "hitchhike_attribution_captures"(
    "target_user_id", "cast_day_start", "coarse_source_through"
  );
