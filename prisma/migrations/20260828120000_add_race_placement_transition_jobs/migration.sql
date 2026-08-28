CREATE TYPE "RacePlacementTransitionJobState" AS ENUM (
  'queued',
  'running',
  'retry',
  'succeeded'
);

CREATE TABLE "race_placement_transition_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "race_id" TEXT NOT NULL,
  "requested_generation" INTEGER NOT NULL,
  "processing_generation" INTEGER,
  "completed_generation" INTEGER,
  "state" "RacePlacementTransitionJobState" NOT NULL DEFAULT 'queued',
  "requested_at" TIMESTAMP(3) NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "processing_observed_at" TIMESTAMP(3),
  "not_before_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retry_at" TIMESTAMP(3),
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "last_completed_at" TIMESTAMP(3),
  "lease_token" VARCHAR(64),
  "lease_expires_at" TIMESTAMP(3),
  "last_error_code" VARCHAR(128),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "race_placement_transition_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_placement_transition_jobs_requested_generation_positive"
    CHECK ("requested_generation" > 0),
  CONSTRAINT "race_placement_transition_jobs_processing_generation_positive"
    CHECK ("processing_generation" IS NULL OR "processing_generation" > 0),
  CONSTRAINT "race_placement_transition_jobs_completed_generation_positive"
    CHECK ("completed_generation" IS NULL OR "completed_generation" > 0),
  CONSTRAINT "race_placement_transition_jobs_processing_not_ahead"
    CHECK ("processing_generation" IS NULL OR "processing_generation" <= "requested_generation"),
  CONSTRAINT "race_placement_transition_jobs_completed_not_ahead"
    CHECK ("completed_generation" IS NULL OR "completed_generation" <= "requested_generation"),
  CONSTRAINT "race_placement_transition_jobs_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "race_placement_transition_jobs_race_id_key"
  ON "race_placement_transition_jobs"("race_id");

CREATE INDEX "race_placement_transition_jobs_claim_idx"
  ON "race_placement_transition_jobs"(
    "state", "not_before_at", "retry_at", "requested_at", "race_id"
  );

CREATE INDEX "race_placement_transition_jobs_expired_lease_idx"
  ON "race_placement_transition_jobs"("state", "lease_expires_at");
