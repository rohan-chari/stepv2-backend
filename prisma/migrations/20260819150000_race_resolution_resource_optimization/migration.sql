-- Additive, mixed-version-safe state for proven no-op step-input suppression.
-- Null means "unknown / perform today's work" for every new reader; old
-- writers remain valid and no existing row is rewritten.
ALTER TABLE "user_scoring_input_versions"
  ADD COLUMN "scoring_watermark" CHAR(64),
  ADD COLUMN "next_sample_boundary_at" TIMESTAMP(3);

ALTER TABLE "step_sync_requests"
  ADD COLUMN "scoring_changed" BOOLEAN;
