-- Single concurrent statement: do not wrap this migration in BEGIN/COMMIT.
CREATE INDEX CONCURRENTLY global_event_recovery_entitlement_page_idx ON global_step_event_entitlements(event_id,id);
