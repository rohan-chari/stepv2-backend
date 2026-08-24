-- Additive mixed-version ownership stamp. NULL means the current canonical
-- scoring generation has not yet been proven to have atomic queue ownership.
ALTER TABLE "user_scoring_input_versions"
ADD COLUMN "source_queue_semantics_generation" BIGINT;
