-- Atomic installation: no source mutation may cross the initial count snapshot.
-- No historical impact/entitlement row is rewritten. Old writers keep working.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE races, global_event_race_impacts, global_step_event_entitlements IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE race_event_fingerprint_versions (
  race_id text PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE ON UPDATE CASCADE,
  incarnation uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  impact_count bigint NOT NULL DEFAULT 0 CHECK (impact_count >= 0)
);
-- Pair rows serialize discovery as well as writes. A real tuple update makes
-- REPEATABLE READ/SERIALIZABLE writers retry rather than discover races from
-- an old snapshot after waiting (an advisory lock alone cannot guarantee that).
CREATE TABLE event_fingerprint_pair_versions (
  event_id text NOT NULL,
  user_id text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (event_id, user_id)
);
-- Deliberately no parent FKs: locking a parent after a source row creates a
-- lock inversion with account deletion. Parent cleanup below owns lifecycle.
CREATE INDEX event_fingerprint_pair_versions_user_idx ON event_fingerprint_pair_versions (user_id);
INSERT INTO race_event_fingerprint_versions (race_id, impact_count)
SELECT race.id, COALESCE(impact.n, 0) FROM races race
LEFT JOIN (SELECT race_id, count(*) n FROM global_event_race_impacts GROUP BY race_id) impact ON impact.race_id=race.id;

CREATE FUNCTION event_fingerprint_race_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO race_event_fingerprint_versions (race_id) SELECT id FROM new_races;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_race_created AFTER INSERT ON races
  REFERENCING NEW TABLE AS new_races FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_race_created();

CREATE FUNCTION event_fingerprint_impact_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One guard write per changed event/user pair per SQL statement, sorted.
  -- This command finishes before the next command takes a fresh RC snapshot.
  WITH changed AS (SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed)
  INSERT INTO event_fingerprint_pair_versions (event_id, user_id)
  SELECT DISTINCT c.event_id, c.user_id FROM changed c
  JOIN global_step_events e ON e.id=c.event_id JOIN users u ON u.id=c.user_id
  ORDER BY c.event_id,c.user_id
  ON CONFLICT (event_id,user_id) DO UPDATE SET revision=event_fingerprint_pair_versions.revision+1;

  WITH changed AS (SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed),
  affected AS (SELECT race_id, sum(delta) AS delta FROM changed GROUP BY race_id),
  locked AS MATERIALIZED (
    SELECT version.race_id, affected.delta FROM race_event_fingerprint_versions version
    JOIN affected ON affected.race_id=version.race_id ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_event_fingerprint_versions version SET revision=version.revision+1,
    impact_count=version.impact_count+locked.delta FROM locked WHERE version.race_id=locked.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_impact_insert AFTER INSERT ON global_event_race_impacts
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_impact_insert();

CREATE FUNCTION event_fingerprint_impact_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One guard write per changed event/user pair per SQL statement, sorted.
  -- This command finishes before the next command takes a fresh RC snapshot.
  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM old_rows EXCEPT SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed UNION ALL SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM new_rows EXCEPT SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed)
  INSERT INTO event_fingerprint_pair_versions (event_id, user_id)
  SELECT DISTINCT c.event_id, c.user_id FROM changed c
  JOIN global_step_events e ON e.id=c.event_id JOIN users u ON u.id=c.user_id
  ORDER BY c.event_id,c.user_id
  ON CONFLICT (event_id,user_id) DO UPDATE SET revision=event_fingerprint_pair_versions.revision+1;

  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM old_rows EXCEPT SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed UNION ALL SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM new_rows EXCEPT SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed),
  affected AS (SELECT race_id, sum(delta) AS delta FROM changed GROUP BY race_id),
  locked AS MATERIALIZED (
    SELECT version.race_id, affected.delta FROM race_event_fingerprint_versions version
    JOIN affected ON affected.race_id=version.race_id ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_event_fingerprint_versions version SET revision=version.revision+1,
    impact_count=version.impact_count+locked.delta FROM locked WHERE version.race_id=locked.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_impact_update AFTER UPDATE ON global_event_race_impacts
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_impact_update();

CREATE FUNCTION event_fingerprint_impact_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One guard write per changed event/user pair per SQL statement, sorted.
  -- This command finishes before the next command takes a fresh RC snapshot.
  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed)
  INSERT INTO event_fingerprint_pair_versions (event_id, user_id)
  SELECT DISTINCT c.event_id, c.user_id FROM changed c
  JOIN global_step_events e ON e.id=c.event_id JOIN users u ON u.id=c.user_id
  ORDER BY c.event_id,c.user_id
  ON CONFLICT (event_id,user_id) DO UPDATE SET revision=event_fingerprint_pair_versions.revision+1;

  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,race_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed),
  affected AS (SELECT race_id, sum(delta) AS delta FROM changed GROUP BY race_id),
  locked AS MATERIALIZED (
    SELECT version.race_id, affected.delta FROM race_event_fingerprint_versions version
    JOIN affected ON affected.race_id=version.race_id ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_event_fingerprint_versions version SET revision=version.revision+1,
    impact_count=version.impact_count+locked.delta FROM locked WHERE version.race_id=locked.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_impact_delete AFTER DELETE ON global_event_race_impacts
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_impact_delete();

CREATE FUNCTION event_fingerprint_entitlement_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One guard write per changed event/user pair per SQL statement, sorted.
  -- This command finishes before the next command takes a fresh RC snapshot.
  WITH changed AS (SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed)
  INSERT INTO event_fingerprint_pair_versions (event_id, user_id)
  SELECT DISTINCT c.event_id, c.user_id FROM changed c
  JOIN global_step_events e ON e.id=c.event_id JOIN users u ON u.id=c.user_id
  ORDER BY c.event_id,c.user_id
  ON CONFLICT (event_id,user_id) DO UPDATE SET revision=event_fingerprint_pair_versions.revision+1;

  WITH changed AS (SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed),
  affected AS (SELECT DISTINCT impact.race_id, 0::bigint AS delta FROM global_event_race_impacts impact JOIN changed c ON c.event_id=impact.event_id AND c.user_id=impact.user_id),
  locked AS MATERIALIZED (
    SELECT version.race_id, affected.delta FROM race_event_fingerprint_versions version
    JOIN affected ON affected.race_id=version.race_id ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_event_fingerprint_versions version SET revision=version.revision+1,
    impact_count=version.impact_count+locked.delta FROM locked WHERE version.race_id=locked.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_entitlement_insert AFTER INSERT ON global_step_event_entitlements
  REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_entitlement_insert();

CREATE FUNCTION event_fingerprint_entitlement_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One guard write per changed event/user pair per SQL statement, sorted.
  -- This command finishes before the next command takes a fresh RC snapshot.
  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM old_rows EXCEPT SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed UNION ALL SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM new_rows EXCEPT SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed)
  INSERT INTO event_fingerprint_pair_versions (event_id, user_id)
  SELECT DISTINCT c.event_id, c.user_id FROM changed c
  JOIN global_step_events e ON e.id=c.event_id JOIN users u ON u.id=c.user_id
  ORDER BY c.event_id,c.user_id
  ON CONFLICT (event_id,user_id) DO UPDATE SET revision=event_fingerprint_pair_versions.revision+1;

  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM old_rows EXCEPT SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM new_rows) changed UNION ALL SELECT changed.*, 1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM new_rows EXCEPT SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed),
  affected AS (SELECT DISTINCT impact.race_id, 0::bigint AS delta FROM global_event_race_impacts impact JOIN changed c ON c.event_id=impact.event_id AND c.user_id=impact.user_id),
  locked AS MATERIALIZED (
    SELECT version.race_id, affected.delta FROM race_event_fingerprint_versions version
    JOIN affected ON affected.race_id=version.race_id ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_event_fingerprint_versions version SET revision=version.revision+1,
    impact_count=version.impact_count+locked.delta FROM locked WHERE version.race_id=locked.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_entitlement_update AFTER UPDATE ON global_step_event_entitlements
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_entitlement_update();

CREATE FUNCTION event_fingerprint_entitlement_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One guard write per changed event/user pair per SQL statement, sorted.
  -- This command finishes before the next command takes a fresh RC snapshot.
  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed)
  INSERT INTO event_fingerprint_pair_versions (event_id, user_id)
  SELECT DISTINCT c.event_id, c.user_id FROM changed c
  JOIN global_step_events e ON e.id=c.event_id JOIN users u ON u.id=c.user_id
  ORDER BY c.event_id,c.user_id
  ON CONFLICT (event_id,user_id) DO UPDATE SET revision=event_fingerprint_pair_versions.revision+1;

  WITH changed AS (SELECT changed.*, -1::bigint AS delta FROM (SELECT id,event_id,user_id,fingerprint_revision,fingerprint_incarnation FROM old_rows) changed),
  affected AS (SELECT DISTINCT impact.race_id, 0::bigint AS delta FROM global_event_race_impacts impact JOIN changed c ON c.event_id=impact.event_id AND c.user_id=impact.user_id),
  locked AS MATERIALIZED (
    SELECT version.race_id, affected.delta FROM race_event_fingerprint_versions version
    JOIN affected ON affected.race_id=version.race_id ORDER BY version.race_id FOR UPDATE OF version
  )
  UPDATE race_event_fingerprint_versions version SET revision=version.revision+1,
    impact_count=version.impact_count+locked.delta FROM locked WHERE version.race_id=locked.race_id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_entitlement_delete AFTER DELETE ON global_step_event_entitlements
  REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_entitlement_delete();

CREATE FUNCTION event_fingerprint_user_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM event_fingerprint_pair_versions pair USING old_parents parent WHERE pair.user_id=parent.id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_user_deleted AFTER DELETE ON users
  REFERENCING OLD TABLE AS old_parents FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_user_deleted();
CREATE FUNCTION event_fingerprint_user_renamed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM event_fingerprint_pair_versions WHERE user_id=OLD.id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_user_renamed AFTER UPDATE OF id ON users
  FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION event_fingerprint_user_renamed();

CREATE FUNCTION event_fingerprint_event_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM event_fingerprint_pair_versions pair USING old_parents parent WHERE pair.event_id=parent.id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_event_deleted AFTER DELETE ON global_step_events
  REFERENCING OLD TABLE AS old_parents FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_event_deleted();
CREATE FUNCTION event_fingerprint_event_renamed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM event_fingerprint_pair_versions WHERE event_id=OLD.id;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_event_renamed AFTER UPDATE OF id ON global_step_events
  FOR EACH ROW WHEN (OLD.id IS DISTINCT FROM NEW.id) EXECUTE FUNCTION event_fingerprint_event_renamed();

-- TRUNCATE is rare maintenance, but must not preserve a formerly valid key.
CREATE FUNCTION event_fingerprint_source_truncated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE race_event_fingerprint_versions SET revision=revision+1,
    impact_count=CASE WHEN TG_TABLE_NAME='global_event_race_impacts' THEN 0 ELSE impact_count END;
  RETURN NULL;
END $$;
CREATE TRIGGER event_fingerprint_impacts_truncated AFTER TRUNCATE ON global_event_race_impacts
  FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_source_truncated();
CREATE TRIGGER event_fingerprint_entitlements_truncated AFTER TRUNCATE ON global_step_event_entitlements
  FOR EACH STATEMENT EXECUTE FUNCTION event_fingerprint_source_truncated();
COMMIT;
