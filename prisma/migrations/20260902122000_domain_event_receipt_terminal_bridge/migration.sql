-- Keep receipt terminal proof synchronized for every writer, including an
-- overlapping previous binary and set-based projection fast paths.
CREATE OR REPLACE FUNCTION maintain_domain_event_receipt_terminal_state()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
     AND (OLD.status IS DISTINCT FROM NEW.status OR OLD.completed_at IS DISTINCT FROM NEW.completed_at) THEN
    UPDATE domain_event_receipts
       SET terminal_status=NEW.status,
           completed_at=COALESCE(NEW.completed_at,now()),
           updated_at=now()
     WHERE event_key=NEW.event_key;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER domain_event_outbox_receipt_terminal_trigger
AFTER UPDATE OF status,completed_at ON domain_event_outbox
FOR EACH ROW EXECUTE FUNCTION maintain_domain_event_receipt_terminal_state();

-- Rows may have terminalized after the receipt table landed in 1200 but before
-- this bridge trigger was installed. Backfill that rolling-overlap window in
-- the same migration so terminal proof is never silently absent.
UPDATE domain_event_receipts receipt
   SET terminal_status=event.status,
       completed_at=COALESCE(event.completed_at,event.updated_at),
       updated_at=CURRENT_TIMESTAMP
  FROM domain_event_outbox event
 WHERE receipt.domain_event_id=event.id
   AND event.status IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
   AND (receipt.terminal_status IS NULL OR receipt.completed_at IS NULL);
