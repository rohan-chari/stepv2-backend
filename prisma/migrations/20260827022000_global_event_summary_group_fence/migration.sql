-- Permanent mixed-worker group fence for attribution-v2 summaries.
--
-- Every impact mutation touches and locks the matching work row. This makes a
-- repeatable-read capture retry if a rolling old worker changes the vector
-- between discovery and its final work-row lock, and makes terminal summary
-- aggregation serialize before its complete-vector read. SQLSTATE 40001 is
-- deliberate: old binaries already treat it as a retryable transaction error.
CREATE OR REPLACE FUNCTION fence_global_event_summary_impact_vector()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  work_status text;
BEGIN
  UPDATE global_event_summary_work AS work
     SET updated_at = work.updated_at
    FROM global_step_events AS event
   WHERE work.event_id = NEW.event_id
     AND work.user_id = NEW.user_id
     AND event.id = work.event_id
     AND event.summary_attribution_version = 2
  RETURNING work.status INTO work_status;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF work_status = 'WAITING_SYNC' THEN
      RETURN NEW;
    END IF;
  ELSE
    IF NEW.event_id <> OLD.event_id
       OR NEW.user_id <> OLD.user_id
       OR NEW.race_id <> OLD.race_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'GLOBAL_EVENT_SUMMARY_VECTOR_FENCED: impact group identity is immutable';
    END IF;

    IF work_status = 'WAITING_SYNC' THEN
      RETURN NEW;
    END IF;

    IF work_status IN ('QUEUED', 'PROCESSING', 'WAITING_RACES')
       AND OLD.status = 'PENDING'
       AND OLD.attribution_version = 2
       AND NEW.attribution_version = 2
       AND NEW.status IN ('FINAL', 'UNSCORABLE', 'EXPIRED_UNDELIVERED') THEN
      RETURN NEW;
    END IF;

    IF work_status = 'UNSCORABLE'
       AND OLD.status = 'PENDING'
       AND NEW.attribution_version = 2
       AND NEW.status = 'UNSCORABLE' THEN
      RETURN NEW;
    END IF;

    IF work_status = 'EXPIRED_UNDELIVERED'
       AND OLD.status = 'PENDING'
       AND NEW.attribution_version = 2
       AND NEW.status = 'EXPIRED_UNDELIVERED' THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION USING
    ERRCODE = '40001',
    MESSAGE = format(
      'GLOBAL_EVENT_SUMMARY_VECTOR_FENCED: impact mutation is incompatible with work state %s',
      work_status
    );
END;
$$;

CREATE TRIGGER global_event_summary_impact_vector_fence
BEFORE INSERT OR UPDATE ON global_event_race_impacts
FOR EACH ROW
EXECUTE FUNCTION fence_global_event_summary_impact_vector();
