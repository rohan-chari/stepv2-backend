ALTER TABLE "global_step_events"
  ADD COLUMN "summary_attribution_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "global_event_race_impacts"
  ADD COLUMN "capture_kind" TEXT,
  ADD COLUMN "capture_sync_request_id" TEXT,
  ADD COLUMN "capture_completed_at" TIMESTAMP(3),
  ADD COLUMN "capture_coverage_through" TIMESTAMP(3),
  ADD COLUMN "source_scoring_input_generation" BIGINT,
  ADD COLUMN "source_resolution_generation" INTEGER,
  ADD COLUMN "terminal_reason" TEXT,
  ADD COLUMN "terminal_at" TIMESTAMP(3);

ALTER TABLE "step_sync_requests"
  ADD COLUMN "completed_at" TIMESTAMP(3),
  ADD COLUMN "canonical_coverage_through" TIMESTAMP(3),
  ADD COLUMN "scoring_input_generation" BIGINT;

ALTER TABLE "global_event_user_summaries"
  ADD COLUMN "expires_at" TIMESTAMP(3);

CREATE INDEX "global_event_user_summaries_user_id_acknowledged_at_expires_idx"
  ON "global_event_user_summaries"("user_id", "acknowledged_at", "expires_at", "settled_at" DESC);

CREATE TABLE "global_event_summary_work" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "event_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'WAITING_SYNC',
  "expires_at" TIMESTAMP(3) NOT NULL,
  "capture_sync_request_id" TEXT,
  "capture_completed_at" TIMESTAMP(3),
  "capture_coverage_through" TIMESTAMP(3),
  "source_scoring_input_generation" BIGINT,
  "required_race_count" INTEGER NOT NULL DEFAULT 0,
  "final_race_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "lease_token" TEXT,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_event_summary_work_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "global_event_summary_work_counts_check"
    CHECK ("required_race_count" >= 0 AND "final_race_count" >= 0),
  CONSTRAINT "global_event_summary_work_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "global_step_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "global_event_summary_work_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "global_event_summary_work_event_id_user_id_key"
  ON "global_event_summary_work"("event_id", "user_id");
CREATE INDEX "global_event_summary_work_status_available_at_lease_until_idx"
  ON "global_event_summary_work"("status", "available_at", "lease_until");
CREATE INDEX "global_event_summary_work_user_id_status_expires_at_idx"
  ON "global_event_summary_work"("user_id", "status", "expires_at");

CREATE TABLE "global_event_capture_artifacts" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "work_id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "capture_sync_request_id" TEXT NOT NULL,
  "capture_completed_at" TIMESTAMP(3) NOT NULL,
  "capture_coverage_through" TIMESTAMP(3) NOT NULL,
  "source_scoring_input_generation" BIGINT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_digest" CHAR(64) NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_event_capture_artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "global_event_capture_artifacts_work_id_fkey"
    FOREIGN KEY ("work_id") REFERENCES "global_event_summary_work"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "global_event_capture_artifacts_event_id_fkey"
    FOREIGN KEY ("event_id") REFERENCES "global_step_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "global_event_capture_artifacts_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "global_event_capture_artifacts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "global_event_capture_artifacts_work_id_race_id_key"
  ON "global_event_capture_artifacts"("work_id", "race_id");
CREATE INDEX "global_event_capture_artifacts_event_id_user_id_idx"
  ON "global_event_capture_artifacts"("event_id", "user_id");
