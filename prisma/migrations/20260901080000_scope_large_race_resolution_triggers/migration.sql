-- Preserve per-uploader scope in the append-only large-race handoff. Nullable
-- columns keep triggers from older HTTP workers valid; the promoter treats any
-- unscoped row conservatively as FULL during a mixed-version deploy.
ALTER TABLE "race_resolution_full_triggers"
  ADD COLUMN "user_id" text,
  ADD COLUMN "participant_id" text;

-- Identifies the initial FULL queue row created solely as a destination for
-- scoped append-only triggers. Any ordinary enqueue clears this marker, so the
-- promoter can only narrow work when no independent FULL reason is present.
ALTER TABLE "race_resolution_jobs_v2"
  ADD COLUMN "full_trigger_seed_only" boolean NOT NULL DEFAULT false;
