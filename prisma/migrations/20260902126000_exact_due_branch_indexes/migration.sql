-- Exact recovery timers process expiry independently of normal due and lease
-- branches. Keep those probes on compact active-state indexes.
CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_normal_expiry_v2_idx"
  ON "inbox_delivery_outbox"("expires_at", "id")
  WHERE "status" IN ('PENDING','RETRY','LEASED') AND "expires_at" IS NOT NULL;

CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_admission_expiry_v2_idx"
  ON "inbox_delivery_outbox"("admission_expires_at", "id")
  WHERE "status" IN ('ADMISSION_FIRST','ADMISSION_RETRY','ADMISSION_LEASED')
    AND "admission_expires_at" IS NOT NULL;
