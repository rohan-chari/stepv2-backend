-- Single concurrent statement: do not wrap this migration in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY global_event_recovery_pending_impact_idx
  ON global_event_race_impacts(event_id,user_id) WHERE attribution_version=1 AND status<>'FINAL';
