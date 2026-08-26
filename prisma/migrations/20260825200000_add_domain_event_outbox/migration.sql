-- Additive, mixed-version-safe durable domain-event handoff. Old backend
-- binaries ignore these tables and every existing notification table remains
-- unchanged during the compatibility drain.
CREATE TABLE "domain_event_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "event_key" VARCHAR(255) NOT NULL,
  "event_type" VARCHAR(96) NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1,
  "aggregate_type" VARCHAR(64) NOT NULL,
  "aggregate_id" VARCHAR(191) NOT NULL,
  "payload" JSONB NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "available_at" TIMESTAMP(3) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  "expansion_cursor" VARCHAR(191),
  "expansion_completed_at" TIMESTAMP(3),
  "lease_token" VARCHAR(64),
  "lease_until" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(128),
  "last_error_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_event_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "domain_event_audiences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "domain_event_id" UUID NOT NULL,
  "recipient_id" VARCHAR(191) NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "facts" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_event_audiences_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "domain_event_notification_projections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "domain_event_id" UUID NOT NULL,
  "recipient_user_id" VARCHAR(191) NOT NULL,
  "delivery_key" VARCHAR(255) NOT NULL,
  "projection_kind" VARCHAR(32) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  "available_at" TIMESTAMP(3) NOT NULL,
  "lease_token" VARCHAR(64),
  "lease_until" TIMESTAMP(3),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_error_code" VARCHAR(128),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "domain_event_notification_projections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domain_event_outbox_event_key_key"
  ON "domain_event_outbox"("event_key");
CREATE INDEX "domain_event_outbox_status_available_at_occurred_at_idx"
  ON "domain_event_outbox"("status", "available_at", "occurred_at");
CREATE INDEX "domain_event_outbox_aggregate_type_aggregate_id_occurred_at_idx"
  ON "domain_event_outbox"("aggregate_type", "aggregate_id", "occurred_at");
CREATE INDEX "domain_event_outbox_lease_token_idx"
  ON "domain_event_outbox"("lease_token");

CREATE UNIQUE INDEX "domain_event_audiences_domain_event_id_recipient_id_key"
  ON "domain_event_audiences"("domain_event_id", "recipient_id");
CREATE UNIQUE INDEX "domain_event_audiences_domain_event_id_ordinal_key"
  ON "domain_event_audiences"("domain_event_id", "ordinal");
CREATE INDEX "domain_event_audiences_domain_event_id_ordinal_idx"
  ON "domain_event_audiences"("domain_event_id", "ordinal");

CREATE UNIQUE INDEX "domain_event_notification_projections_event_recipient_delivery_kind_key"
  ON "domain_event_notification_projections"("domain_event_id", "recipient_user_id", "delivery_key", "projection_kind");
CREATE INDEX "domain_event_notification_projections_status_available_at_id_idx"
  ON "domain_event_notification_projections"("status", "available_at", "id");
CREATE INDEX "domain_event_notification_projections_lease_token_idx"
  ON "domain_event_notification_projections"("lease_token");

ALTER TABLE "domain_event_audiences"
  ADD CONSTRAINT "domain_event_audiences_domain_event_id_fkey"
  FOREIGN KEY ("domain_event_id") REFERENCES "domain_event_outbox"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "domain_event_notification_projections"
  ADD CONSTRAINT "domain_event_notification_projections_domain_event_id_fkey"
  FOREIGN KEY ("domain_event_id") REFERENCES "domain_event_outbox"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
