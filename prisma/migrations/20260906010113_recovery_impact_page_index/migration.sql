-- Single concurrent statement: do not wrap this migration in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY global_event_recovery_impact_page_idx ON global_event_race_impacts(event_id,id);
