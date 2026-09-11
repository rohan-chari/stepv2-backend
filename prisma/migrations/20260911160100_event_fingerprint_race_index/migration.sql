-- Standalone online index build: the local witness starts with one bounded race.
CREATE INDEX CONCURRENTLY IF NOT EXISTS global_event_race_impacts_race_fingerprint_idx
  ON global_event_race_impacts (race_id, id) INCLUDE (event_id, user_id, fingerprint_revision);
