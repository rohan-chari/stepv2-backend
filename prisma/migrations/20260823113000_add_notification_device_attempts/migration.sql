CREATE TABLE "inbox_delivery_device_attempts" (
    "id" TEXT NOT NULL,
    "outbox_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "disposition" TEXT NOT NULL,
    "attempt_count" INTEGER NOT NULL DEFAULT 1,
    "last_error_code" TEXT,
    "accepted_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inbox_delivery_device_attempts_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "inbox_delivery_device_attempts"
  ADD CONSTRAINT "inbox_delivery_device_attempts_outbox_id_fkey"
  FOREIGN KEY ("outbox_id") REFERENCES "inbox_delivery_outbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "inbox_delivery_device_attempts_outbox_id_token_hash_key"
  ON "inbox_delivery_device_attempts"("outbox_id", "token_hash");
CREATE INDEX "inbox_delivery_device_attempts_outbox_id_disposition_idx"
  ON "inbox_delivery_device_attempts"("outbox_id", "disposition");
