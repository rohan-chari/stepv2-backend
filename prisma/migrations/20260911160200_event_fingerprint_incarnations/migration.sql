-- Nullable constant defaults preserve terminal captures without a backfill.
-- New incarnations are assigned inside PostgreSQL even for old writers which
-- omit these columns or replay an INSERT with the deleted row's entire payload.
ALTER TABLE global_event_race_impacts ADD COLUMN fingerprint_incarnation uuid;
ALTER TABLE global_step_event_entitlements ADD COLUMN fingerprint_incarnation uuid;
CREATE OR REPLACE FUNCTION global_event_race_impacts_fingerprint_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.fingerprint_incarnation := gen_random_uuid();
    NEW.fingerprint_revision := 0;
  ELSE
    NEW.fingerprint_incarnation := OLD.fingerprint_incarnation;
    NEW.fingerprint_revision := OLD.fingerprint_revision +
      CASE WHEN ROW(NEW.id, NEW.event_id, NEW.race_id, NEW.user_id) IS DISTINCT FROM ROW(OLD.id, OLD.event_id, OLD.race_id, OLD.user_id) THEN 1 ELSE 0 END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER global_event_race_impacts_fingerprint_stamp_insert BEFORE INSERT ON global_event_race_impacts
  FOR EACH ROW EXECUTE FUNCTION global_event_race_impacts_fingerprint_stamp();
CREATE OR REPLACE FUNCTION global_step_event_entitlements_fingerprint_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.fingerprint_incarnation := gen_random_uuid();
    NEW.fingerprint_revision := 0;
  ELSE
    NEW.fingerprint_incarnation := OLD.fingerprint_incarnation;
    NEW.fingerprint_revision := OLD.fingerprint_revision +
      CASE WHEN ROW(NEW.id, NEW.event_id, NEW.user_id, NEW.starts_at, NEW.ends_at, NEW.start_outcome, NEW.timezone, NEW.local_date, NEW.schedule_revision) IS DISTINCT FROM ROW(OLD.id, OLD.event_id, OLD.user_id, OLD.starts_at, OLD.ends_at, OLD.start_outcome, OLD.timezone, OLD.local_date, OLD.schedule_revision) THEN 1 ELSE 0 END;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER global_step_event_entitlements_fingerprint_stamp_insert BEFORE INSERT ON global_step_event_entitlements
  FOR EACH ROW EXECUTE FUNCTION global_step_event_entitlements_fingerprint_stamp();
