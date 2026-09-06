-- Single concurrent statement: do not wrap this migration in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY global_event_recovery_v1_completion_idx ON global_event_race_impacts
  (('global_event_summary:' || event_id || ':' || user_id || ':v1')) WHERE attribution_version=1;
