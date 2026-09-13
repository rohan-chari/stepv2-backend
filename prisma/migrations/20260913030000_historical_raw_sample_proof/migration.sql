-- Nullable defaults fail closed for existing/legacy writers; no source backfill.
ALTER TABLE user_scoring_input_versions
  ADD COLUMN historical_raw_revision uuid,
  ADD COLUMN historical_raw_complete_generation bigint,
  ADD COLUMN historical_raw_protected_cutoff timestamp(3);
