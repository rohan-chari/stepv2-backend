-- C0 EXPAND phase (Redis derived-data spec §5a item 1).
-- Creates the race-keyed resolution queue ALONGSIDE the per-user
-- `race_resolution_jobs` table, which is deliberately left untouched so old
-- binaries draining it during the pm2 reload overlap keep working against the
-- schema they were built for. The CONTRACT migration (dropping the old table)
-- ships in a separate deploy >= 1 week later.

CREATE TABLE "race_resolution_jobs_v2" (
    "id" TEXT NOT NULL,
    "race_id" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "processing_generation" INTEGER,
    "resolution_time_zone" VARCHAR(255),
    "processing_time_zone" VARCHAR(255),
    "state" "RaceResolutionJobState" NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "last_completed_at" TIMESTAMP(3),
    "retry_at" TIMESTAMP(3),
    "not_before_at" TIMESTAMP(3),
    "lease_expires_at" TIMESTAMP(3),
    "lease_token" TEXT,
    "last_error_code" TEXT,
    "triggered_by_user_ids" JSONB NOT NULL DEFAULT '[]',
    "processing_triggered_by_user_ids" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "race_resolution_jobs_v2_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "race_resolution_jobs_v2_race_id_key" ON "race_resolution_jobs_v2"("race_id");
CREATE INDEX "race_resolution_jobs_v2_state_retry_at_idx" ON "race_resolution_jobs_v2"("state", "retry_at");
CREATE INDEX "race_resolution_jobs_v2_lease_expires_at_idx" ON "race_resolution_jobs_v2"("lease_expires_at");
CREATE INDEX "race_resolution_jobs_v2_state_not_before_at_idx" ON "race_resolution_jobs_v2"("state", "not_before_at");
CREATE INDEX "race_resolution_jobs_v2_requested_at_idx" ON "race_resolution_jobs_v2"("requested_at");

ALTER TABLE "race_resolution_jobs_v2"
  ADD CONSTRAINT "race_resolution_jobs_v2_race_id_fkey"
  FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;
