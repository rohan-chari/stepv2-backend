-- Additive queue-priority expand migration. Existing workers ignore these
-- columns and continue using dirty_priority; LIVE is the safe default for all
-- rows created before this migration.
ALTER TABLE "race_resolution_jobs_v2"
  ADD COLUMN "queue_priority" VARCHAR(16) NOT NULL DEFAULT 'LIVE',
  ADD COLUMN "processing_queue_priority" VARCHAR(16) NOT NULL DEFAULT 'LIVE';

ALTER TABLE "race_resolution_jobs_v2"
  ADD CONSTRAINT "race_resolution_jobs_v2_queue_priority_check"
    CHECK ("queue_priority" IN ('SETTLEMENT', 'RECOVERY', 'LIVE', 'MAINTENANCE')),
  ADD CONSTRAINT "race_resolution_jobs_v2_processing_queue_priority_check"
    CHECK ("processing_queue_priority" IN ('SETTLEMENT', 'RECOVERY', 'LIVE', 'MAINTENANCE'));

CREATE INDEX "race_resolution_jobs_v2_state_queue_priority_requested_at_idx"
  ON "race_resolution_jobs_v2"("state", "queue_priority", "requested_at");
