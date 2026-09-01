-- The event-open projector reads only this one durable event shape. The generic
-- status-first index makes every 100-row page walk unrelated active outbox
-- traffic before applying the event/schema predicates, which becomes the
-- dominant database cost at a timezone boundary.
CREATE INDEX CONCURRENTLY "domain_event_outbox_scheduled_entitlement_due_idx"
  ON "domain_event_outbox"("available_at", "occurred_at", "id")
  WHERE "event_type" = 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'
    AND "schema_version" = 1
    AND "status" IN ('PENDING', 'RETRY', 'EXPANDING');
