ALTER TABLE "global_step_events"
  ADD COLUMN "schedule_mode" TEXT NOT NULL DEFAULT 'LEGACY_GLOBAL',
  ADD COLUMN "event_day" TEXT,
  ADD COLUMN "local_start_minute" INTEGER,
  ADD COLUMN "duration_minutes" INTEGER;

CREATE UNIQUE INDEX "global_step_events_event_day_key"
  ON "global_step_events"("event_day");

ALTER TABLE "users"
  ADD COLUMN "global_event_timezone" TEXT,
  ADD COLUMN "global_event_timezone_candidate" TEXT,
  ADD COLUMN "global_event_timezone_candidate_since" TIMESTAMP(3);

UPDATE "users"
   SET "global_event_timezone" = "timezone"
 WHERE "timezone" IS NOT NULL
   AND EXISTS (
     SELECT 1
       FROM pg_timezone_names z
      WHERE z.name = "timezone"
   );

CREATE TABLE "global_step_event_entitlements" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "timezone" TEXT NOT NULL,
  "local_date" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "ends_at" TIMESTAMP(3) NOT NULL,
  "start_outcome" TEXT NOT NULL DEFAULT 'PENDING',
  "start_processed_at" TIMESTAMP(3),
  "end_processed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_event_entitlements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "global_step_event_entitlements_window_check" CHECK ("ends_at" > "starts_at"),
  CONSTRAINT "global_step_event_entitlements_outcome_check" CHECK (
    "start_outcome" IN (
      'PENDING',
      'ACTIVATED_ON_TIME',
      'ACTIVATED_LATE_JOIN',
      'NO_ACTIVE_RACES',
      'SKIPPED_STALE'
    )
  )
);

CREATE UNIQUE INDEX "global_step_event_entitlements_event_id_user_id_key"
  ON "global_step_event_entitlements"("event_id", "user_id");
CREATE INDEX "global_step_event_entitlements_starts_at_start_processed_at_idx"
  ON "global_step_event_entitlements"("starts_at", "start_processed_at");
CREATE INDEX "global_step_event_entitlements_ends_at_end_processed_at_idx"
  ON "global_step_event_entitlements"("ends_at", "end_processed_at");
CREATE INDEX "global_step_event_entitlements_user_id_starts_at_ends_at_idx"
  ON "global_step_event_entitlements"("user_id", "starts_at", "ends_at");

ALTER TABLE "global_step_event_entitlements"
  ADD CONSTRAINT "global_step_event_entitlements_event_id_fkey"
  FOREIGN KEY ("event_id") REFERENCES "global_step_events"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "global_step_event_entitlements"
  ADD CONSTRAINT "global_step_event_entitlements_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "global_step_event_cron_owners" (
  "owner_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "local_aware" BOOLEAN NOT NULL DEFAULT FALSE,
  "heartbeat_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_event_cron_owners_pkey" PRIMARY KEY ("owner_id")
);

CREATE INDEX "global_step_event_cron_owners_expires_at_idx"
  ON "global_step_event_cron_owners"("expires_at");

CREATE TABLE "global_step_event_operational_snapshots" (
  "id" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "due_starts" INTEGER NOT NULL,
  "due_ends" INTEGER NOT NULL,
  "stale_pending_starts" INTEGER NOT NULL,
  "invalid_local_parents" INTEGER NOT NULL,
  "active_parents" INTEGER NOT NULL,
  "active_entitlements" INTEGER NOT NULL,
  "exposure_zero_races" INTEGER NOT NULL,
  "exposure_one_races" INTEGER NOT NULL,
  "exposure_multiple_races" INTEGER NOT NULL,
  "exposure_buckets" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "entitlements_by_offset" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "rollout_counters" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "healthy" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_event_operational_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "global_step_event_operational_snapshots_observed_at_idx"
  ON "global_step_event_operational_snapshots"("observed_at" DESC);

CREATE TABLE "global_step_event_operational_counters" (
  "metric" TEXT NOT NULL,
  "value" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_event_operational_counters_pkey" PRIMARY KEY ("metric")
);
