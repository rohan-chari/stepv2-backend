-- Additive recovery queue for historical and exceptional domain-event receipt
-- gaps. There is deliberately no FK to domain_event_outbox: terminal
-- SOURCE_DELETED rows are retained as operator evidence after retention.
CREATE TABLE "domain_event_receipt_recovery" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "domain_event_id" UUID NOT NULL,
  "event_key" VARCHAR(255) NOT NULL,
  "reason" VARCHAR(64) NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "lease_token" VARCHAR(64),
  "last_error_code" VARCHAR(128),
  "last_error_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "domain_event_receipt_recovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "domain_event_receipt_recovery_domain_event_id_key" UNIQUE ("domain_event_id"),
  CONSTRAINT "domain_event_receipt_recovery_event_key_key" UNIQUE ("event_key"),
  CONSTRAINT "domain_event_receipt_recovery_status_check" CHECK (
    "status" IN ('QUEUED','PROCESSING','SUCCEEDED','RETRY','FAILED_TERMINAL')
  ),
  CONSTRAINT "domain_event_receipt_recovery_attempt_count_check" CHECK ("attempt_count" >= 0)
);

CREATE INDEX "domain_event_receipt_recovery_due_idx"
  ON "domain_event_receipt_recovery"("available_at", "id")
  WHERE "status" IN ('QUEUED','RETRY');
CREATE INDEX "domain_event_receipt_recovery_lease_idx"
  ON "domain_event_receipt_recovery"("lease_until", "id")
  WHERE "status"='PROCESSING';

-- The existing outbox index is built concurrently in the next migration.
