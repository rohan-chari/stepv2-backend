-- Branch-specific active indexes. Each predicate mirrors one claim/next-due
-- branch; old full-history indexes stay in place for rollback.
--
-- Proven reloptions evidence
-- | table | reloption | production-shaped trials | result |
-- | --- | --- | --- | --- |
-- | none | none | no candidate completed two passing trials | no reloptions applied |
--
-- Consequently this migration contains no fillfactor or autovacuum setting.
CREATE INDEX CONCURRENTLY "global_event_summary_work_capture_active_v2_idx"
  ON "global_event_summary_work"("user_id", "expires_at", "id")
  WHERE "status"='WAITING_SYNC';
CREATE INDEX CONCURRENTLY "global_event_summary_work_queued_due_idx"
  ON "global_event_summary_work"("available_at", "id")
  WHERE "status"='QUEUED';
CREATE INDEX CONCURRENTLY "global_event_summary_work_processing_lease_idx"
  ON "global_event_summary_work"("lease_until", "available_at", "id")
  WHERE "status"='PROCESSING';
CREATE INDEX CONCURRENTLY "global_event_summary_work_ready_due_idx"
  ON "global_event_summary_work"("available_at", "id")
  WHERE "status"='WAITING_RACES' AND "ready_at" IS NOT NULL;
CREATE INDEX CONCURRENTLY "global_event_summary_work_sync_expiry_idx"
  ON "global_event_summary_work"("expires_at", "id")
  WHERE "status"='WAITING_SYNC';
CREATE INDEX CONCURRENTLY "global_event_summary_work_recovery_v2_idx"
  ON "global_event_summary_work"("next_recovery_at", "id")
  WHERE "status" IN ('WAITING_SYNC','QUEUED','PROCESSING','WAITING_RACES');

CREATE INDEX CONCURRENTLY "domain_event_outbox_due_v2_idx"
  ON "domain_event_outbox"("available_at", "occurred_at", "id")
  WHERE "status" IN ('PENDING','RETRY');
CREATE INDEX CONCURRENTLY "domain_event_outbox_expired_lease_v2_idx"
  ON "domain_event_outbox"("lease_until", "occurred_at", "id")
  WHERE "status"='EXPANDING';
CREATE INDEX CONCURRENTLY "domain_event_projection_due_v2_idx"
  ON "domain_event_notification_projections"("available_at", "id")
  WHERE "status" IN ('PENDING','RETRY');
CREATE INDEX CONCURRENTLY "domain_event_projection_expired_lease_v2_idx"
  ON "domain_event_notification_projections"("lease_until", "available_at", "id")
  WHERE "status"='PROCESSING';
CREATE INDEX CONCURRENTLY "domain_event_projection_active_parent_v2_idx"
  ON "domain_event_notification_projections"("domain_event_id", "id")
  WHERE "status" NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL');
CREATE INDEX CONCURRENTLY "domain_event_outbox_terminal_retention_v2_idx"
  ON "domain_event_outbox"("completed_at", "id")
  WHERE "status" IN ('COMPLETED','SUPPRESSED');

CREATE INDEX CONCURRENTLY "race_resolution_post_tasks_queued_due_v2_idx"
  ON "race_resolution_post_tasks"("not_before_at", "requested_at", "id")
  WHERE "state"='queued';
CREATE INDEX CONCURRENTLY "race_resolution_post_tasks_running_lease_v2_idx"
  ON "race_resolution_post_tasks"("lease_expires_at", "requested_at", "id")
  WHERE "state"='running';
CREATE INDEX CONCURRENTLY "race_resolution_post_tasks_terminal_cleanup_v3_idx"
  ON "race_resolution_post_tasks"("completed_at", "id")
  WHERE "state" IN ('succeeded','succeeded_with_failures')
    AND "snapshot_state" NOT IN ('pending','attempting');

CREATE INDEX CONCURRENTLY "notification_schedules_pending_due_v2_idx"
  ON "notification_schedules"("available_at", "id") WHERE "status"='PENDING';
CREATE INDEX CONCURRENTLY "notification_schedules_admission_due_v2_idx"
  ON "notification_schedules"("admission_class", "available_at", "admission_sequence", "id")
  WHERE "status"='ADMISSION_PENDING';
CREATE INDEX CONCURRENTLY "notification_schedules_terminal_cleanup_v2_idx"
  ON "notification_schedules"("updated_at", "id")
  WHERE "status" IN ('MATERIALIZED','EXPIRED','CANCELLED','CANCELLED_NO_ACTIVE_RACE');

CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_normal_due_v2_idx"
  ON "inbox_delivery_outbox"("available_at", "id") WHERE "status" IN ('PENDING','RETRY');
CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_normal_lease_v2_idx"
  ON "inbox_delivery_outbox"("lease_until", "available_at", "id") WHERE "status"='LEASED';
CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_admission_first_v2_idx"
  ON "inbox_delivery_outbox"("admission_class", "available_at", "admission_sequence", "id") WHERE "status"='ADMISSION_FIRST';
CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_admission_retry_v2_idx"
  ON "inbox_delivery_outbox"("admission_class", "available_at", "admission_sequence", "id") WHERE "status"='ADMISSION_RETRY';
CREATE INDEX CONCURRENTLY "inbox_delivery_outbox_admission_lease_v2_idx"
  ON "inbox_delivery_outbox"("admission_class", "lease_until", "admission_sequence", "id") WHERE "status"='ADMISSION_LEASED';
CREATE INDEX CONCURRENTLY "inbox_delivery_device_attempts_retry_due_v2_idx"
  ON "inbox_delivery_device_attempts"("next_attempt_at", "id")
  WHERE "disposition" IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT');

CREATE INDEX CONCURRENTLY "domain_event_receipts_source_idx"
  ON "domain_event_receipts"("replay_source_type", "replay_source_id", "event_key");
CREATE INDEX CONCURRENTLY "domain_event_receipts_provisional_idx"
  ON "domain_event_receipts"("created_at", "event_key") WHERE "receipt_state"='PROVISIONAL';
CREATE INDEX CONCURRENTLY "notification_schedule_receipts_source_idx"
  ON "notification_schedule_receipts"("source_type", "source_id", "recipient_user_id", "delivery_key")
  WHERE "source_kind"='SOURCE_BACKED';
CREATE INDEX CONCURRENTLY "notification_schedule_receipts_direct_cleanup_idx"
  ON "notification_schedule_receipts"("direct_retain_until", "recipient_user_id", "delivery_key")
  WHERE "source_kind"='DIRECT';
CREATE INDEX CONCURRENTLY "race_resolution_delivery_intent_receipts_race_generation_idx"
  ON "race_resolution_delivery_intent_receipts"("race_id", "source_generation", "delivery_key_hash");
