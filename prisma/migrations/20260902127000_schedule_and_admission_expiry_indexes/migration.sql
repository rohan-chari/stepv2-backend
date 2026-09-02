-- Exact timers terminalize expired work even when its ordinary availability is
-- later. These compact active-state indexes keep each expiry branch bounded.
CREATE INDEX CONCURRENTLY "notification_schedules_pending_expiry_v2_idx"
  ON "notification_schedules"("expires_at", "id")
  WHERE "status"='PENDING' AND "expires_at" IS NOT NULL;

CREATE INDEX CONCURRENTLY "notification_schedules_admission_expiry_v2_idx"
  ON "notification_schedules"("admission_class", "expires_at", "id")
  WHERE "status"='ADMISSION_PENDING' AND "expires_at" IS NOT NULL;

CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_admission_expiry_by_class_v2_idx"
  ON "inbox_delivery_outbox"("admission_class", "admission_expires_at", "id")
  WHERE "status" IN ('ADMISSION_FIRST','ADMISSION_RETRY','ADMISSION_LEASED')
    AND "admission_expires_at" IS NOT NULL;
