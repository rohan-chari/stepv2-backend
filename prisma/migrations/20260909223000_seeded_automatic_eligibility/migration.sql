-- Existing eligible NULL rows retain their pre-cutover identity. New transitions
-- are stamped by PostgreSQL so older capability/preference writers participate.
ALTER TABLE users ADD COLUMN seeded_automatic_eligible_at TIMESTAMPTZ(3);
CREATE FUNCTION stamp_seeded_automatic_eligibility() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  newly_eligible boolean;
  previously_eligible boolean;
BEGIN
  newly_eligible := NEW.auto_join_featured_races IS TRUE AND
    'seeded_race_buckets'=ANY(COALESCE(NEW.client_features,ARRAY[]::text[]));
  IF TG_OP='INSERT' THEN
    IF newly_eligible THEN
      -- Explicit timestamps support trusted import/fixture data. Application
      -- requests cannot write this field; omitted values use the DB clock.
      NEW.seeded_automatic_eligible_at := COALESCE(NEW.seeded_automatic_eligible_at,clock_timestamp());
    END IF;
    RETURN NEW;
  END IF;
  previously_eligible := OLD.auto_join_featured_races IS TRUE AND
    'seeded_race_buckets'=ANY(COALESCE(OLD.client_features,ARRAY[]::text[]));
  IF newly_eligible AND NOT previously_eligible THEN
    NEW.seeded_automatic_eligible_at := clock_timestamp();
  ELSE
    NEW.seeded_automatic_eligible_at := OLD.seeded_automatic_eligible_at;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_seeded_automatic_eligibility
  BEFORE INSERT OR UPDATE OF auto_join_featured_races,client_features ON users
  FOR EACH ROW EXECUTE FUNCTION stamp_seeded_automatic_eligibility();
