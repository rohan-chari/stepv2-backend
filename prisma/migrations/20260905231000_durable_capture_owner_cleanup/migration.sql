-- Capture owners also pin facts belonging to other participants. Those roots
-- survive account deletion, so source-user cascading alone cannot release them.
CREATE FUNCTION durable_capture_release_deleted_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM durable_capture_fact_pins WHERE owner_id=OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER durable_capture_deleted_owner
  AFTER DELETE ON durable_global_event_capture_requests
  FOR EACH ROW EXECUTE FUNCTION durable_capture_release_deleted_owner();
