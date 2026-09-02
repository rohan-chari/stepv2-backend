-- RETRY eligibility is stored in lease_until so available_at remains the
-- immutable event occurrence/admission fact. Keep the prior combined active
-- index during mixed-version rollback; these purpose-built branches serve the
-- new claim and exact-due queries without scanning ineligible retries.
CREATE INDEX CONCURRENTLY "domain_event_outbox_pending_due_v3_idx"
  ON "domain_event_outbox"("available_at", "occurred_at", "id")
  WHERE "status"='PENDING';

CREATE INDEX CONCURRENTLY "domain_event_outbox_retry_due_v3_idx"
  ON "domain_event_outbox"("lease_until", "occurred_at", "id")
  WHERE "status"='RETRY';
