-- Finalized normal appends incur no queue writes. A deferred check sees the
-- full committed envelope after old binaries finish inserting their audience.
CREATE FUNCTION enqueue_unfinalized_domain_event_receipt() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO domain_event_receipt_recovery(domain_event_id,event_key,reason)
  SELECT event.id,event.event_key,
    CASE WHEN receipt.event_key IS NULL THEN 'COMPAT_MISSING' ELSE 'COMPAT_PROVISIONAL' END
  FROM domain_event_outbox event
  LEFT JOIN domain_event_receipts receipt ON receipt.domain_event_id=event.id
  WHERE event.id=NEW.id AND (receipt.event_key IS NULL OR receipt.receipt_state='PROVISIONAL')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER domain_event_receipt_recovery_compat_trigger
AFTER INSERT ON domain_event_outbox DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enqueue_unfinalized_domain_event_receipt();

CREATE INDEX domain_event_receipt_recovery_fresh_due_idx
ON domain_event_receipt_recovery(available_at,id)
WHERE status IN ('QUEUED','RETRY') AND reason NOT LIKE 'LEGACY_%';
