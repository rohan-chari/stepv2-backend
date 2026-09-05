-- An explicit due queue avoids scanning terminal capture history every tick.
CREATE TABLE durable_capture_pin_releases (
  owner_id uuid PRIMARY KEY REFERENCES durable_global_event_capture_requests(id) ON DELETE CASCADE,
  available_at timestamptz NOT NULL
);
CREATE INDEX durable_capture_pin_release_due_idx ON durable_capture_pin_releases(available_at,owner_id);
CREATE FUNCTION queue_durable_capture_pin_release() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IN ('EXPIRED','FAILED') THEN
    INSERT INTO durable_capture_pin_releases(owner_id,available_at) VALUES(NEW.id,clock_timestamp())
      ON CONFLICT(owner_id) DO UPDATE SET available_at=LEAST(durable_capture_pin_releases.available_at,EXCLUDED.available_at);
  ELSIF NEW.status='COMPLETE' AND NEW.completed_at IS NOT NULL THEN
    INSERT INTO durable_capture_pin_releases(owner_id,available_at)
      VALUES(NEW.id,(NEW.completed_at AT TIME ZONE 'UTC')+interval '30 days')
      ON CONFLICT(owner_id) DO UPDATE SET available_at=EXCLUDED.available_at;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER durable_capture_terminal_pin_release AFTER INSERT OR UPDATE OF status,completed_at
  ON durable_global_event_capture_requests FOR EACH ROW EXECUTE FUNCTION queue_durable_capture_pin_release();
INSERT INTO durable_capture_pin_releases(owner_id,available_at)
  SELECT id,CASE WHEN status='COMPLETE' THEN (completed_at AT TIME ZONE 'UTC')+interval '30 days' ELSE clock_timestamp() END
  FROM durable_global_event_capture_requests WHERE status IN ('EXPIRED','FAILED') OR (status='COMPLETE' AND completed_at IS NOT NULL);
