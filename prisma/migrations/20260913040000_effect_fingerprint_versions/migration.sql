-- Additive proof for base effect rows only. Checkpoints are refreshed at reads.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE races, race_active_effects IN SHARE ROW EXCLUSIVE MODE;
CREATE TABLE race_effect_fingerprint_versions (
  race_id text PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE ON UPDATE CASCADE,
  incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO race_effect_fingerprint_versions (race_id) SELECT id FROM races;
CREATE FUNCTION effect_fingerprint_race_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO race_effect_fingerprint_versions (race_id) SELECT id FROM new_races;
  RETURN NULL;
END $$;
CREATE TRIGGER effect_fingerprint_race_created AFTER INSERT ON races
  REFERENCING NEW TABLE AS new_races FOR EACH STATEMENT EXECUTE FUNCTION effect_fingerprint_race_created();

CREATE FUNCTION effect_fingerprint_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Missing versions stay missing (canonical reads); do not recreate parents
  -- during cascade deletion. One ordered proof write per affected race.
  WITH affected AS (SELECT race_id FROM new_rows), locked AS MATERIALIZED (
    SELECT version.race_id FROM race_effect_fingerprint_versions version
    JOIN (SELECT DISTINCT race_id FROM affected) changed USING (race_id)
    ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_effect_fingerprint_versions version SET revision=version.revision+1
  FROM locked WHERE locked.race_id=version.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER effect_fingerprint_insert AFTER INSERT ON race_active_effects
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION effect_fingerprint_insert();

CREATE FUNCTION effect_fingerprint_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Missing versions stay missing (canonical reads); do not recreate parents
  -- during cascade deletion. One ordered proof write per affected race.
  WITH affected AS (SELECT race_id FROM old_rows), locked AS MATERIALIZED (
    SELECT version.race_id FROM race_effect_fingerprint_versions version
    JOIN (SELECT DISTINCT race_id FROM affected) changed USING (race_id)
    ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_effect_fingerprint_versions version SET revision=version.revision+1
  FROM locked WHERE locked.race_id=version.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER effect_fingerprint_delete AFTER DELETE ON race_active_effects
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION effect_fingerprint_delete();

CREATE FUNCTION effect_fingerprint_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Missing versions stay missing (canonical reads); do not recreate parents
  -- during cascade deletion. One ordered proof write per affected race.
  WITH affected AS (SELECT race_id FROM (SELECT * FROM old_rows EXCEPT SELECT * FROM new_rows) removed UNION SELECT race_id FROM (SELECT * FROM new_rows EXCEPT SELECT * FROM old_rows) added), locked AS MATERIALIZED (
    SELECT version.race_id FROM race_effect_fingerprint_versions version
    JOIN (SELECT DISTINCT race_id FROM affected) changed USING (race_id)
    ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_effect_fingerprint_versions version SET revision=version.revision+1
  FROM locked WHERE locked.race_id=version.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER effect_fingerprint_update AFTER UPDATE ON race_active_effects
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION effect_fingerprint_update();

CREATE FUNCTION effect_fingerprint_truncated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  WITH locked AS MATERIALIZED (
    SELECT race_id FROM race_effect_fingerprint_versions ORDER BY race_id FOR UPDATE
  ) UPDATE race_effect_fingerprint_versions version SET revision=version.revision+1
    FROM locked WHERE locked.race_id=version.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER effect_fingerprint_truncated AFTER TRUNCATE ON race_active_effects
  FOR EACH STATEMENT EXECUTE FUNCTION effect_fingerprint_truncated();
COMMIT;
