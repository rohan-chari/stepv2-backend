-- Must run without BEGIN/COMMIT: existing writers continue during the build.
CREATE INDEX CONCURRENTLY "domain_event_outbox_created_at_id_receipt_recovery_idx"
  ON "domain_event_outbox"("created_at", "id");
