-- Track the live schedule side of each durable receipt explicitly. This turns
-- the five-minute completeness audit from a terminal-history scan into an
-- exact missing-handoff queue. The column and triggers are additive so the
-- previously deployed binary remains safe during a rolling restart.
ALTER TABLE "notification_schedule_receipts"
  ADD COLUMN "schedule_present" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION refresh_notification_schedule_presence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  key_user_id text;
  key_delivery_key text;
  is_present boolean;
BEGIN
  key_user_id := CASE WHEN TG_OP='DELETE' THEN OLD.recipient_user_id ELSE NEW.recipient_user_id END;
  key_delivery_key := CASE WHEN TG_OP='DELETE' THEN OLD.delivery_key ELSE NEW.delivery_key END;
  SELECT EXISTS (
    SELECT 1 FROM notification_schedules schedule
     WHERE schedule.recipient_user_id=key_user_id
       AND schedule.delivery_key=key_delivery_key
  ) INTO is_present;

  UPDATE notification_schedule_receipts receipt
     SET schedule_present=is_present,updated_at=now()
   WHERE receipt.recipient_user_id=key_user_id
     AND receipt.delivery_key=key_delivery_key
     AND receipt.schedule_present IS DISTINCT FROM is_present;
  RETURN COALESCE(NEW,OLD);
END;
$$;

-- Deferred execution observes the final transaction state even when an older
-- binary inserts the receipt and schedule in sibling data-modifying CTEs.
CREATE CONSTRAINT TRIGGER notification_schedule_presence_schedule_trigger
AFTER INSERT OR DELETE ON "notification_schedules"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION refresh_notification_schedule_presence();

CREATE OR REPLACE FUNCTION initialize_notification_schedule_presence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE notification_schedule_receipts receipt
     SET schedule_present=EXISTS (
       SELECT 1 FROM notification_schedules schedule
        WHERE schedule.recipient_user_id=NEW.recipient_user_id
          AND schedule.delivery_key=NEW.delivery_key
     ),updated_at=now()
   WHERE receipt.recipient_user_id=NEW.recipient_user_id
     AND receipt.delivery_key=NEW.delivery_key
     AND receipt.schedule_present IS DISTINCT FROM EXISTS (
       SELECT 1 FROM notification_schedules schedule
        WHERE schedule.recipient_user_id=NEW.recipient_user_id
          AND schedule.delivery_key=NEW.delivery_key
     );
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER notification_schedule_presence_receipt_trigger
AFTER INSERT ON "notification_schedule_receipts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION initialize_notification_schedule_presence();

-- Install the mixed-version write barrier before taking the existing-row
-- snapshot so no receipt/schedule pair can slip between the backfill and the
-- triggers during an online migration.
UPDATE "notification_schedule_receipts" receipt
   SET "schedule_present"=true,"updated_at"=now()
 WHERE "schedule_present"=false
   AND EXISTS (
     SELECT 1
       FROM "notification_schedules" schedule
      WHERE schedule."recipient_user_id"=receipt."recipient_user_id"
        AND schedule."delivery_key"=receipt."delivery_key"
   );

CREATE INDEX CONCURRENTLY "notification_schedule_receipts_global_event_gap_idx"
  ON "notification_schedule_receipts"("updated_at","recipient_user_id","delivery_key")
  WHERE "source_kind"='SOURCE_BACKED'
    AND "source_type"='GLOBAL_STEP_EVENT_ENTITLEMENT'
    AND "terminal_status" IS NULL
    AND "schedule_present"=false;

CREATE INDEX CONCURRENTLY "domain_event_projection_terminal_delivery_idx"
  ON "domain_event_notification_projections"("recipient_user_id","delivery_key","created_at","id")
  WHERE "status" IN ('COMPLETED','FAILED_TERMINAL');
