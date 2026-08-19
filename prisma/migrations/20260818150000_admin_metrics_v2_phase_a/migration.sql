-- Phase A is additive and default-safe. No telemetry is backfilled.
ALTER TABLE "users"
  ADD COLUMN "metrics_v2_eligible_at" TIMESTAMP(3),
  ADD COLUMN "metrics_v2_eligible_epoch_id" TEXT,
  ADD COLUMN "metrics_v2_signup_eligible" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "metrics_v2_signup_epoch_id" TEXT;

ALTER TABLE "device_tokens"
  ADD COLUMN "admin_metrics_open_capable" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "admin_metrics_open_epoch_id" TEXT;

ALTER TABLE "link_opens"
  ADD COLUMN "ip_hash_version" INTEGER,
  ADD COLUMN "ip_net_hash_version" INTEGER;

CREATE TABLE "admin_metrics_collection_epochs" (
  "id" TEXT NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "admin_metrics_collection_epochs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "admin_metrics_collection_epochs_started_at_ended_at_idx"
  ON "admin_metrics_collection_epochs"("started_at", "ended_at");
CREATE UNIQUE INDEX "admin_metrics_collection_epochs_one_open_idx"
  ON "admin_metrics_collection_epochs" ((1)) WHERE "ended_at" IS NULL;

CREATE TABLE "metric_coverage_starts" (
  "metric" TEXT NOT NULL,
  "operational_at" TIMESTAMP(3) NOT NULL,
  "confirmed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "metric_coverage_starts_pkey" PRIMARY KEY ("metric")
);

CREATE TABLE "user_activity_days" (
  "user_id" TEXT NOT NULL,
  "activity_date" DATE NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL,
  "last_seen_at" TIMESTAMP(3) NOT NULL,
  "app_version" TEXT NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'foreground',
  "metadata_occurred_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "user_activity_days_pkey" PRIMARY KEY ("user_id", "activity_date"),
  CONSTRAINT "user_activity_days_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "user_activity_days_activity_date_idx"
  ON "user_activity_days"("activity_date");

CREATE TABLE "push_deliveries" (
  "id" TEXT NOT NULL,
  "public_id" TEXT NOT NULL,
  "delivery_key" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "notification_type" TEXT NOT NULL,
  "open_capable" BOOLEAN NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "provider_accepted_at" TIMESTAMP(3),
  "opened_at" TIMESTAMP(3),
  CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "push_deliveries_user_id_fkey" FOREIGN KEY ("user_id")
    REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "push_deliveries_public_id_key" ON "push_deliveries"("public_id");
CREATE UNIQUE INDEX "push_deliveries_delivery_key_key" ON "push_deliveries"("delivery_key");
CREATE INDEX "push_deliveries_provider_accepted_at_notification_type_idx"
  ON "push_deliveries"("provider_accepted_at", "notification_type");
CREATE INDEX "push_deliveries_user_id_created_at_idx"
  ON "push_deliveries"("user_id", "created_at");

CREATE TABLE "analytics_cleanup_runs" (
  "id" TEXT NOT NULL,
  "job_key" TEXT NOT NULL,
  "day_key" DATE NOT NULL,
  "state" TEXT NOT NULL,
  "fence" BIGINT NOT NULL DEFAULT 1,
  "lease_owner" TEXT NOT NULL,
  "lease_expires_at" TIMESTAMP(3) NOT NULL,
  "cursor" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "analytics_cleanup_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "analytics_cleanup_runs_state_check" CHECK ("state" IN ('running', 'complete'))
);
CREATE UNIQUE INDEX "analytics_cleanup_runs_job_key_day_key_key"
  ON "analytics_cleanup_runs"("job_key", "day_key");
CREATE INDEX "analytics_cleanup_runs_state_lease_expires_at_idx"
  ON "analytics_cleanup_runs"("state", "lease_expires_at");
