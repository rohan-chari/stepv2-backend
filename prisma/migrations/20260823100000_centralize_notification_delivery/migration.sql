-- Additive-only notification delivery migration. The old backend ignores the
-- schedule table and the nullable outbox columns while this release rolls out.
CREATE TABLE "notification_schedules" (
    "id" TEXT NOT NULL,
    "recipient_user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source_ref" TEXT,
    "claimed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_schedules_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "notification_schedules"
  ADD CONSTRAINT "notification_schedules_recipient_user_id_fkey"
  FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "notification_schedules_recipient_user_id_delivery_key_key"
  ON "notification_schedules"("recipient_user_id", "delivery_key");
CREATE INDEX "notification_schedules_status_available_at_idx"
  ON "notification_schedules"("status", "available_at");
CREATE INDEX "notification_schedules_recipient_user_id_created_at_idx"
  ON "notification_schedules"("recipient_user_id", "created_at");

ALTER TABLE "inbox_delivery_outbox"
  ADD COLUMN "claimed_at" TIMESTAMP(3),
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "provider_accepted_at" TIMESTAMP(3),
  ADD COLUMN "accepted_tokens" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "retry_at" TIMESTAMP(3),
  ADD COLUMN "last_error_code" TEXT;

CREATE INDEX "inbox_delivery_outbox_lease_token_idx"
  ON "inbox_delivery_outbox"("lease_token");
