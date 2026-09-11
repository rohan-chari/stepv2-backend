-- This singleton has no terminal-capture guards. A database identity prevents
-- unrelated/recreated databases with matching counters sharing scoring keys.
ALTER TABLE event_catalog_revision ADD COLUMN epoch uuid NOT NULL DEFAULT gen_random_uuid();
