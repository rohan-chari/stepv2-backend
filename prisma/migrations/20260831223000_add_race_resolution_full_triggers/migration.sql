-- Large shared races cannot safely append every uploader to the one mutable
-- race-resolution job row. This append-only handoff lets source transactions
-- commit without contending on that row; the dedicated resolution owner folds
-- committed triggers into one FULL generation in bounded batches.
CREATE TABLE "race_resolution_full_triggers" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "race_id" text NOT NULL,
  "resolution_time_zone" text,
  "requested_at" timestamp(3) NOT NULL,
  "created_at" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_resolution_full_triggers_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "race_resolution_full_triggers_race_id_requested_at_id_idx"
  ON "race_resolution_full_triggers"("race_id", "requested_at", "id");

CREATE INDEX "race_resolution_full_triggers_requested_at_id_idx"
  ON "race_resolution_full_triggers"("requested_at", "id");
