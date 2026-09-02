CREATE TYPE "OperationalEmailAlertState" AS ENUM (
  'PENDING', 'SENDING', 'ACCEPTED', 'UNCERTAIN', 'FAILED'
);

CREATE TABLE "operational_email_alerts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "dedupe_key" VARCHAR(160) NOT NULL,
  "alert_type" VARCHAR(32) NOT NULL,
  "payload" JSONB NOT NULL,
  "state" "OperationalEmailAlertState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "not_before_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMP(3),
  "accepted_at" TIMESTAMP(3),
  "last_error_code" VARCHAR(64),
  "terminal_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "operational_email_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "operational_email_alerts_attempts_check" CHECK ("attempts" BETWEEN 0 AND 5),
  CONSTRAINT "operational_email_alerts_alert_type_check" CHECK ("alert_type" IN ('slow', 'watchdog')),
  CONSTRAINT "operational_email_alerts_payload_size_check" CHECK (octet_length("payload"::text) <= 8192)
);

CREATE UNIQUE INDEX "operational_email_alerts_dedupe_key_key"
  ON "operational_email_alerts"("dedupe_key");
CREATE INDEX "operational_email_alerts_state_not_before_at_id_idx"
  ON "operational_email_alerts"("state", "not_before_at", "id");
CREATE INDEX "operational_email_alerts_state_lease_expires_at_id_idx"
  ON "operational_email_alerts"("state", "lease_expires_at", "id");
CREATE INDEX "operational_email_alerts_state_terminal_at_id_idx"
  ON "operational_email_alerts"("state", "terminal_at", "id");
CREATE INDEX "operational_email_alerts_alert_type_created_at_id_idx"
  ON "operational_email_alerts"("alert_type", "created_at" DESC, "id");
