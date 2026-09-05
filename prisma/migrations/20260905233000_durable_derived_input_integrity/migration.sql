ALTER TABLE durable_capture_prepared_inputs ADD COLUMN answers_digest text;
ALTER TABLE durable_capture_method_progress ADD COLUMN state_digest text;
