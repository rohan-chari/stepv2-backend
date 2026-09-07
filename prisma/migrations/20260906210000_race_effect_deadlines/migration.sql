-- Additive storage; retain on application rollback. Older writers maintain
-- deadlines in their own source transaction through this trigger.
CREATE TABLE race_effect_deadlines (
 effect_id text PRIMARY KEY REFERENCES race_active_effects(id) ON DELETE CASCADE,
 race_id text NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 deadline_at timestamp(3) NOT NULL,
 revision uuid NOT NULL DEFAULT gen_random_uuid(),
 dispatched_revision uuid, dispatched_generation integer, dispatched_at timestamp(3),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX race_effect_deadlines_due_idx ON race_effect_deadlines(deadline_at,race_id,effect_id) WHERE dispatched_revision IS NULL;
CREATE INDEX race_effect_deadlines_race_idx ON race_effect_deadlines(race_id,deadline_at);
CREATE INDEX race_effect_deadlines_recovery_idx ON race_effect_deadlines(dispatched_at,race_id) WHERE dispatched_revision IS NOT NULL;
CREATE FUNCTION maintain_race_effect_deadline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='active_effect' AND NEW.expires_at IS NOT NULL THEN
  IF TG_OP='UPDATE' THEN
   IF (NEW.expires_at,NEW.race_id,NEW.target_participant_id,NEW.target_user_id,NEW.type,NEW.status)
      IS NOT DISTINCT FROM (OLD.expires_at,OLD.race_id,OLD.target_participant_id,OLD.target_user_id,OLD.type,OLD.status) THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO race_effect_deadlines(effect_id,race_id,deadline_at) VALUES(NEW.id,NEW.race_id,NEW.expires_at)
  ON CONFLICT(effect_id) DO UPDATE SET race_id=EXCLUDED.race_id,deadline_at=EXCLUDED.deadline_at,
   revision=gen_random_uuid(),dispatched_revision=NULL,dispatched_generation=NULL,dispatched_at=NULL,updated_at=clock_timestamp();
 ELSE DELETE FROM race_effect_deadlines WHERE effect_id=NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintain_race_effect_deadline AFTER INSERT OR UPDATE OF status,expires_at,race_id,target_participant_id,target_user_id,type ON race_active_effects FOR EACH ROW EXECUTE FUNCTION maintain_race_effect_deadline();

CREATE TABLE race_snapshot_repair_intents (
 task_id text PRIMARY KEY, race_id text NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 source_generation integer NOT NULL, attempt_count integer NOT NULL DEFAULT 0,
 available_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_token uuid, lease_expires_at timestamp(3), terminal_at timestamp(3),
 created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX race_snapshot_repair_due_idx ON race_snapshot_repair_intents(available_at,race_id) WHERE terminal_at IS NULL;
CREATE INDEX race_snapshot_repair_lease_idx ON race_snapshot_repair_intents(lease_expires_at) WHERE terminal_at IS NULL;
-- Trigger closes failed publication and crashed-attempt recovery atomically,
-- including older processes during deployment. Never acquires the job fence.
CREATE FUNCTION maintain_race_snapshot_repair() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.snapshot_state IN ('failed_no_retry','ambiguous_at_most_once') THEN
  INSERT INTO race_snapshot_repair_intents(task_id,race_id,source_generation)
  VALUES(NEW.id,NEW.race_id,NEW.source_generation) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintain_race_snapshot_repair AFTER INSERT OR UPDATE OF snapshot_state ON race_resolution_post_tasks FOR EACH ROW EXECUTE FUNCTION maintain_race_snapshot_repair();

CREATE TABLE race_progress_refresh_intents (
 race_id text NOT NULL REFERENCES races(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id uuid NOT NULL DEFAULT gen_random_uuid(),
 requested_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 available_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 minimum_committed_generation integer NOT NULL,
 resolution_time_zone text, scope jsonb NOT NULL DEFAULT '{}'::jsonb,
 PRIMARY KEY(race_id,user_id)
);
CREATE INDEX race_progress_refresh_due_idx ON race_progress_refresh_intents(available_at,race_id);
-- Explicit committed generation is maintained for old worker recordSuccess
-- statements too; processing_generation alone is not evidence of a commit.
ALTER TABLE race_resolution_jobs_v2 ADD COLUMN committed_generation integer NOT NULL DEFAULT 0;
CREATE FUNCTION maintain_race_committed_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.last_completed_at IS DISTINCT FROM OLD.last_completed_at AND NEW.processing_generation IS NOT NULL THEN
  NEW.committed_generation=GREATEST(OLD.committed_generation,NEW.processing_generation);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER maintain_race_committed_generation BEFORE UPDATE OF last_completed_at ON race_resolution_jobs_v2 FOR EACH ROW EXECUTE FUNCTION maintain_race_committed_generation();
