-- Expand-only, mixed-version-safe phase one. Old binaries ignore every added
-- nullable/defaulted column and retain their existing unique write path.
ALTER TABLE "global_step_event_entitlements"
  ADD COLUMN "timezone_relocated_at" TIMESTAMP(3),
  ADD COLUMN "timezone_relocated_from" TEXT,
  ADD COLUMN "schedule_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "start_attempt_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "start_next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "start_last_error_code" TEXT,
  ADD COLUMN "start_failed_at" TIMESTAMP(3);

ALTER TABLE "notification_schedules"
  ADD COLUMN "source_revision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "inbox_delivery_outbox"
  ADD COLUMN "expires_at" TIMESTAMP(3);

ALTER TABLE "device_tokens"
  ADD COLUMN "installation_id" TEXT,
  ADD COLUMN "last_registered_at" TIMESTAMP(3),
  ADD COLUMN "last_provider_accepted_at" TIMESTAMP(3),
  ADD COLUMN "status" TEXT,
  ADD COLUMN "status_reason" TEXT,
  ADD COLUMN "status_changed_at" TIMESTAMP(3),
  ADD COLUMN "ownership_generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "provider_environment" TEXT;

ALTER TABLE "inbox_delivery_device_attempts"
  ADD COLUMN "device_token_id" TEXT,
  ADD COLUMN "recipient_user_id" TEXT,
  ADD COLUMN "installation_id" TEXT,
  ADD COLUMN "ownership_generation" INTEGER,
  ADD COLUMN "platform" TEXT,
  ADD COLUMN "provider_environment" TEXT,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "first_attempted_at" TIMESTAMP(3),
  ADD COLUMN "provider_responded_at" TIMESTAMP(3);

ALTER TABLE "global_step_event_cron_owners"
  ADD COLUMN "logical_owner_id" TEXT,
  ADD COLUMN "boot_id" TEXT,
  ADD COLUMN "role" TEXT,
  ADD COLUMN "capabilities" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE "global_step_event_generation_state" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "required_generation" INTEGER NOT NULL DEFAULT 2,
  "ready_since" TIMESTAMP(3),
  "quarantine_started_at" TIMESTAMP(3),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_step_event_generation_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "global_step_event_generation_state_singleton" CHECK ("id" = 1)
);
INSERT INTO "global_step_event_generation_state" ("id") VALUES (1)
ON CONFLICT ("id") DO NOTHING;

CREATE INDEX CONCURRENTLY "notification_schedules_status_available_at_id_idx"
  ON "notification_schedules"("status", "available_at", "id");
CREATE INDEX CONCURRENTLY "global_step_event_entitlements_due_start_idx"
  ON "global_step_event_entitlements"("starts_at", "id")
  WHERE "start_processed_at" IS NULL;
CREATE INDEX CONCURRENTLY "global_step_event_entitlements_retry_start_idx"
  ON "global_step_event_entitlements"("start_next_attempt_at", "starts_at", "id")
  WHERE "start_processed_at" IS NULL;
CREATE INDEX CONCURRENTLY "inbox_delivery_device_attempts_outbox_disposition_id_idx"
  ON "inbox_delivery_device_attempts"("outbox_id", "disposition", "id");
CREATE INDEX CONCURRENTLY "inbox_delivery_device_attempts_disposition_next_attempt_id_idx"
  ON "inbox_delivery_device_attempts"("disposition", "next_attempt_at", "id");
CREATE INDEX CONCURRENTLY "inbox_delivery_device_attempts_token_generation_disposition_idx"
  ON "inbox_delivery_device_attempts"("device_token_id", "ownership_generation", "disposition");
CREATE INDEX CONCURRENTLY "device_tokens_active_lru_idx"
  ON "device_tokens"("user_id", "status", "last_registered_at", "id");
CREATE INDEX CONCURRENTLY "device_tokens_stale_cleanup_idx"
  ON "device_tokens"("status", "status_changed_at", "id");
CREATE UNIQUE INDEX "global_step_event_cron_owners_logical_boot_key"
  ON "global_step_event_cron_owners"("logical_owner_id", "boot_id");
CREATE INDEX CONCURRENTLY "global_step_event_cron_owners_generation_expiry_idx"
  ON "global_step_event_cron_owners"("generation", "expires_at", "logical_owner_id", "boot_id");

ALTER TABLE "inbox_delivery_device_attempts"
  ADD CONSTRAINT "inbox_delivery_device_attempts_device_token_id_fkey"
  FOREIGN KEY ("device_token_id") REFERENCES "device_tokens"("id")
  ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;

ALTER TABLE "inbox_delivery_device_attempts"
  VALIDATE CONSTRAINT "inbox_delivery_device_attempts_device_token_id_fkey";
