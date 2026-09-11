-- Additive constant defaults: never UPDATE/backfill immutable terminal captures.
ALTER TABLE global_event_race_impacts ADD COLUMN fingerprint_revision bigint NOT NULL DEFAULT 0;
ALTER TABLE global_step_event_entitlements ADD COLUMN fingerprint_revision bigint NOT NULL DEFAULT 0;
CREATE TABLE event_catalog_revision (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO event_catalog_revision (id) VALUES (1);

-- Row-local stamps impose no cross-race hot-row writes. Existing application
-- writers cannot reset the revision. Inserts are identified by immutable IDs.
CREATE FUNCTION global_event_race_impacts_fingerprint_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.fingerprint_revision := OLD.fingerprint_revision +
    CASE WHEN ROW(NEW.id, NEW.event_id, NEW.race_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.id, OLD.event_id, OLD.race_id, OLD.user_id) THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER global_event_race_impacts_fingerprint_stamp BEFORE UPDATE ON global_event_race_impacts
  FOR EACH ROW EXECUTE FUNCTION global_event_race_impacts_fingerprint_stamp();

CREATE FUNCTION global_step_event_entitlements_fingerprint_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.fingerprint_revision := OLD.fingerprint_revision +
    CASE WHEN ROW(NEW.id, NEW.event_id, NEW.user_id, NEW.starts_at, NEW.ends_at, NEW.start_outcome, NEW.timezone, NEW.local_date, NEW.schedule_revision) IS DISTINCT FROM ROW(OLD.id, OLD.event_id, OLD.user_id, OLD.starts_at, OLD.ends_at, OLD.start_outcome, OLD.timezone, OLD.local_date, OLD.schedule_revision) THEN 1 ELSE 0 END;
  RETURN NEW;
END $$;
CREATE TRIGGER global_step_event_entitlements_fingerprint_stamp BEFORE UPDATE ON global_step_event_entitlements
  FOR EACH ROW EXECUTE FUNCTION global_step_event_entitlements_fingerprint_stamp();

-- ALL parent definitions affect the catalog, including LOCAL_ENTITLEMENTS.
-- Transition relations make bulk definition edits one revision write per
-- statement. Empty and lease/no-op updates do not invalidate the catalog.
CREATE FUNCTION event_catalog_fingerprint_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (SELECT 1 FROM new_rows) INTO changed;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT EXISTS (SELECT 1 FROM old_rows) INTO changed;
  ELSE
    SELECT EXISTS (
      (SELECT * FROM old_rows EXCEPT SELECT * FROM new_rows)
      UNION ALL (SELECT * FROM new_rows EXCEPT SELECT * FROM old_rows)
    ) INTO changed;
  END IF;
  IF changed THEN UPDATE event_catalog_revision SET revision=revision+1 WHERE id=1; END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER event_catalog_fingerprint_insert AFTER INSERT ON global_step_events
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION event_catalog_fingerprint_stamp();
CREATE TRIGGER event_catalog_fingerprint_update AFTER UPDATE ON global_step_events
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION event_catalog_fingerprint_stamp();
CREATE TRIGGER event_catalog_fingerprint_delete AFTER DELETE ON global_step_events
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION event_catalog_fingerprint_stamp();
