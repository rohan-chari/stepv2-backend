-- Additive-only expand migration for reason-aware race resolution. Existing
-- binaries ignore these columns/tables; empty metadata is interpreted as FULL.

ALTER TABLE "race_resolution_jobs_v2"
  ADD COLUMN "dirty_reasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "dirty_participant_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "dirty_powerup_types" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "dirty_priority" VARCHAR(16) NOT NULL DEFAULT 'IMMEDIATE',
  ADD COLUMN "processing_dirty_reasons" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "processing_dirty_participant_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "processing_dirty_powerup_types" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "processing_dirty_priority" VARCHAR(16) NOT NULL DEFAULT 'IMMEDIATE',
  ADD COLUMN "display_artifact_id" TEXT,
  ADD COLUMN "display_artifact_digest" VARCHAR(64),
  ADD COLUMN "display_artifact_schema" INTEGER,
  ADD COLUMN "processing_display_artifact_id" TEXT,
  ADD COLUMN "processing_display_artifact_digest" VARCHAR(64),
  ADD COLUMN "processing_display_artifact_schema" INTEGER;

ALTER TABLE "race_resolution_jobs_v2"
  ADD CONSTRAINT "race_resolution_jobs_v2_dirty_priority_check"
    CHECK ("dirty_priority" IN ('COALESCE', 'IMMEDIATE')),
  ADD CONSTRAINT "race_resolution_jobs_v2_processing_dirty_priority_check"
    CHECK ("processing_dirty_priority" IN ('COALESCE', 'IMMEDIATE'));

CREATE TABLE "user_scoring_input_versions" (
  "user_id" TEXT NOT NULL,
  "generation" BIGINT NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "user_scoring_input_versions_pkey" PRIMARY KEY ("user_id"),
  CONSTRAINT "user_scoring_input_versions_generation_check" CHECK ("generation" >= 1),
  CONSTRAINT "user_scoring_input_versions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);

CREATE TABLE "race_resolution_post_tasks" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "source_generation" INTEGER NOT NULL,
  "dedupe_key" TEXT NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'queued',
  "requested_at" TIMESTAMP(3) NOT NULL,
  "not_before_at" TIMESTAMP(3) NOT NULL,
  "snapshot_state" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "snapshot_attempt_id" TEXT,
  "snapshot_attempted_at" TIMESTAMP(3),
  "snapshot_completed_at" TIMESTAMP(3),
  "snapshot_error_code" TEXT,
  "snapshot_command" JSONB NOT NULL,
  "payload_bytes" INTEGER NOT NULL,
  "intent_count" INTEGER NOT NULL,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "lease_expires_at" TIMESTAMP(3),
  "lease_token" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_resolution_post_tasks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_resolution_post_tasks_state_check"
    CHECK ("state" IN ('queued', 'running', 'succeeded', 'succeeded_with_failures')),
  CONSTRAINT "race_resolution_post_tasks_snapshot_state_check"
    CHECK ("snapshot_state" IN ('pending', 'attempting', 'succeeded', 'failed_no_retry', 'ambiguous_at_most_once', 'skipped_superseded')),
  CONSTRAINT "race_resolution_post_tasks_payload_bytes_check"
    CHECK ("payload_bytes" BETWEEN 0 AND 262144),
  CONSTRAINT "race_resolution_post_tasks_intent_count_check"
    CHECK ("intent_count" BETWEEN 0 AND 1000),
  CONSTRAINT "race_resolution_post_tasks_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "race_resolution_post_tasks_dedupe_key_key"
  ON "race_resolution_post_tasks"("dedupe_key");
CREATE UNIQUE INDEX "race_resolution_post_tasks_race_id_source_generation_key"
  ON "race_resolution_post_tasks"("race_id", "source_generation");
CREATE INDEX "race_resolution_post_tasks_state_not_before_at_idx"
  ON "race_resolution_post_tasks"("state", "not_before_at");
CREATE INDEX "race_resolution_post_tasks_lease_expires_at_idx"
  ON "race_resolution_post_tasks"("lease_expires_at");
CREATE INDEX "race_resolution_post_tasks_race_id_source_generation_idx"
  ON "race_resolution_post_tasks"("race_id", "source_generation");

CREATE TABLE "race_resolution_delivery_intents" (
  "id" TEXT NOT NULL,
  "task_id" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "recipient_user_id" TEXT,
  "payload" JSONB NOT NULL,
  "payload_bytes" INTEGER NOT NULL,
  "delivery_key_hash" TEXT NOT NULL,
  "cooldown_claim_id" TEXT,
  "state" VARCHAR(32) NOT NULL DEFAULT 'pending',
  "attempt_id" TEXT,
  "attempted_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "provider_disposition" TEXT,
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_resolution_delivery_intents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_resolution_delivery_intents_kind_check"
    CHECK ("kind" IN ('STATE_NOTIFICATION', 'EFFECT_NOTIFICATION', 'NUDGE', 'STEP_SYNC')),
  CONSTRAINT "race_resolution_delivery_intents_state_check"
    CHECK ("state" IN ('pending', 'attempting', 'accepted', 'rejected_no_retry', 'ambiguous_at_most_once')),
  CONSTRAINT "race_resolution_delivery_intents_payload_bytes_check"
    CHECK ("payload_bytes" BETWEEN 0 AND 16384),
  CONSTRAINT "race_resolution_delivery_intents_ordinal_check" CHECK ("ordinal" >= 0),
  CONSTRAINT "race_resolution_delivery_intents_task_id_fkey"
    FOREIGN KEY ("task_id") REFERENCES "race_resolution_post_tasks"("id") ON DELETE CASCADE,
  CONSTRAINT "race_resolution_delivery_intents_recipient_user_id_fkey"
    FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX "race_resolution_delivery_intents_task_id_ordinal_key"
  ON "race_resolution_delivery_intents"("task_id", "ordinal");
CREATE UNIQUE INDEX "race_resolution_delivery_intents_delivery_key_hash_key"
  ON "race_resolution_delivery_intents"("delivery_key_hash");
CREATE INDEX "race_resolution_delivery_intents_task_id_state_ordinal_idx"
  ON "race_resolution_delivery_intents"("task_id", "state", "ordinal");
CREATE INDEX "race_resolution_delivery_intents_state_attempted_at_idx"
  ON "race_resolution_delivery_intents"("state", "attempted_at");

-- Delivery decisions are immutable once durably claimed. Only the explicit
-- attempt/result columns (plus updated_at) may transition. The one exception is
-- the declared ON DELETE SET NULL recipient behavior: deletion of a user must
-- not prevent the remaining ordered group from recording rejected_no_retry.
CREATE FUNCTION race_resolution_delivery_intent_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.task_id IS DISTINCT FROM NEW.task_id
     OR OLD.ordinal IS DISTINCT FROM NEW.ordinal
     OR OLD.kind IS DISTINCT FROM NEW.kind
     OR OLD.payload IS DISTINCT FROM NEW.payload
     OR OLD.payload_bytes IS DISTINCT FROM NEW.payload_bytes
     OR OLD.delivery_key_hash IS DISTINCT FROM NEW.delivery_key_hash
     OR OLD.cooldown_claim_id IS DISTINCT FROM NEW.cooldown_claim_id
     OR OLD.created_at IS DISTINCT FROM NEW.created_at
     OR (
       OLD.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
       AND NOT (
         NEW.recipient_user_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM users WHERE id = OLD.recipient_user_id
         )
       )
     )
  THEN
    RAISE EXCEPTION 'race resolution delivery intent decision is immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER race_resolution_delivery_intent_immutable_trigger
BEFORE UPDATE ON race_resolution_delivery_intents
FOR EACH ROW EXECUTE FUNCTION race_resolution_delivery_intent_immutable();
