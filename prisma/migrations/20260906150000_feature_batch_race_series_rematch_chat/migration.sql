-- Additive storage for the 2026-09-06 feature batch. Every new user/race
-- column is nullable and every existing message defaults to public ALL chat,
-- so the old backend binary and frozen clients remain valid during rollout.
CREATE TYPE "RaceMessageAudience" AS ENUM ('ALL', 'TEAM');
CREATE TYPE "RaceSeriesRenewalJobState" AS ENUM (
  'QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'
);

ALTER TABLE "users"
  ADD COLUMN "shop_tutorial_completed_at" TIMESTAMP(3);

ALTER TABLE "races"
  ADD COLUMN "recurring_payout_min_raw_steps" INTEGER,
  ADD COLUMN "recurring_payout_policy_version" INTEGER,
  ADD COLUMN "rematch_root_race_id" TEXT,
  ADD COLUMN "rematch_source_race_id" TEXT,
  ADD COLUMN "series_generation" INTEGER,
  ADD COLUMN "series_id" UUID,
  ADD COLUMN "series_predecessor_race_id" TEXT,
  ADD COLUMN "settlement_completed_at" TIMESTAMP(3);

ALTER TABLE "race_messages"
  ADD COLUMN "audience" "RaceMessageAudience" NOT NULL DEFAULT 'ALL',
  ADD COLUMN "team" "RaceTeam";

-- Decoy is no longer a Shop/Daily Reward item. Existing inventory remains
-- untouched and an already-minted verified ad grant is handled once by the
-- command compatibility path.
UPDATE "powerup_shop_items"
   SET "active" = false,
       "daily_reward_eligible" = false
 WHERE "powerup_type" = 'decoy'::"PowerupType";

-- Preserve the previous active config as an immutable historical snapshot and
-- activate one successor carrying the pinned Decoy roll weights.
DO $$
DECLARE
  source_row "balance_config"%ROWTYPE;
  next_config JSONB;
  next_version INTEGER;
BEGIN
  SELECT * INTO source_row
    FROM "balance_config"
   WHERE "active" = true
   ORDER BY "version" DESC
   LIMIT 1;
  IF FOUND THEN
    next_config := source_row."config";
    next_config := jsonb_set(
      next_config,
      '{storeOnlyTypes}',
      COALESCE((
        SELECT jsonb_agg(value)
          FROM jsonb_array_elements(COALESCE(next_config->'storeOnlyTypes', '[]'::jsonb))
         WHERE value <> '"DECOY"'::jsonb
      ), '[]'::jsonb),
      true
    );
    IF NOT COALESCE(next_config#>'{dropPool,RARE}', '[]'::jsonb) @> '["DECOY"]'::jsonb THEN
      next_config := jsonb_set(
        next_config,
        '{dropPool,RARE}',
        COALESCE(next_config#>'{dropPool,RARE}', '[]'::jsonb) || '["DECOY"]'::jsonb,
        true
      );
    END IF;
    next_config := jsonb_set(next_config, '{typeWeights,DECOY}', '0.5'::jsonb, true);
    next_config := jsonb_set(next_config, '{positionRules,trailingDownweight,DECOY}', '0.5'::jsonb, true);
    IF next_config IS DISTINCT FROM source_row."config" THEN
      SELECT COALESCE(MAX("version"), 0) + 1 INTO next_version FROM "balance_config";
      UPDATE "balance_config" SET "active" = false WHERE "active" = true;
      INSERT INTO "balance_config" (
        "id", "version", "config", "note", "created_by", "bound_override", "active", "created_at"
      ) VALUES (
        gen_random_uuid()::text, next_version, next_config,
        '2026-09-06: Decoy moved from Shop to RARE mystery-box pool',
        NULL, false, true, CURRENT_TIMESTAMP
      );
    END IF;
  END IF;
END $$;

CREATE TABLE "race_rematch_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "requester_id" TEXT NOT NULL,
  "source_race_id" TEXT NOT NULL,
  "new_race_id" TEXT,
  "idempotency_key" UUID NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "response" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "race_rematch_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "race_rematch_notification_episodes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "recipient_id" TEXT NOT NULL,
  "root_race_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "latest_race_id" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "provider_accepted_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_rematch_notification_episodes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "race_series" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "creator_id" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "settings" JSONB NOT NULL,
  "current_race_id" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "terminal_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMP(3),
  CONSTRAINT "race_series_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "race_series_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "series_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "subscribed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "unsubscribed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_series_subscriptions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "race_series_create_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "creator_id" TEXT NOT NULL,
  "series_id" UUID NOT NULL,
  "idempotency_key" UUID NOT NULL,
  "request_digest" CHAR(64) NOT NULL,
  "response" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "race_series_create_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "race_series_renewal_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "predecessor_id" TEXT NOT NULL,
  "target_race_id" TEXT,
  "state" "RaceSeriesRenewalJobState" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_token" TEXT,
  "lease_generation" INTEGER NOT NULL DEFAULT 0,
  "lease_expires_at" TIMESTAMP(3),
  "retry_at" TIMESTAMP(3),
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "terminal_at" TIMESTAMP(3),
  CONSTRAINT "race_series_renewal_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "race_rematch_receipts_new_race_id_key"
  ON "race_rematch_receipts"("new_race_id");
CREATE UNIQUE INDEX "race_rematch_receipts_requester_id_idempotency_key_key"
  ON "race_rematch_receipts"("requester_id", "idempotency_key");
CREATE INDEX "race_rematch_receipts_source_race_id_idx"
  ON "race_rematch_receipts"("source_race_id");

CREATE UNIQUE INDEX "race_rematch_notification_episodes_recipient_root_generation_key"
  ON "race_rematch_notification_episodes"("recipient_id", "root_race_id", "generation");
CREATE UNIQUE INDEX "race_rematch_notification_episodes_one_open_idx"
  ON "race_rematch_notification_episodes"("recipient_id", "root_race_id")
  WHERE "closed_at" IS NULL;
CREATE INDEX "race_rematch_notification_episodes_root_race_id_idx"
  ON "race_rematch_notification_episodes"("root_race_id");

CREATE UNIQUE INDEX "race_series_current_race_id_key" ON "race_series"("current_race_id");
CREATE INDEX "race_series_creator_id_enabled_idx" ON "race_series"("creator_id", "enabled");
CREATE UNIQUE INDEX "race_series_subscriptions_series_id_user_id_key"
  ON "race_series_subscriptions"("series_id", "user_id");
CREATE UNIQUE INDEX "race_series_subscriptions_one_active_user_idx"
  ON "race_series_subscriptions"("user_id") WHERE "active" = true;
CREATE INDEX "race_series_subscriptions_series_active_order_idx"
  ON "race_series_subscriptions"("series_id", "active", "subscribed_at", "user_id");
CREATE UNIQUE INDEX "race_series_create_receipts_creator_key_key"
  ON "race_series_create_receipts"("creator_id", "idempotency_key");
CREATE INDEX "race_series_create_receipts_series_id_idx"
  ON "race_series_create_receipts"("series_id");
CREATE UNIQUE INDEX "race_series_renewal_jobs_predecessor_id_key"
  ON "race_series_renewal_jobs"("predecessor_id");
CREATE UNIQUE INDEX "race_series_renewal_jobs_target_race_id_key"
  ON "race_series_renewal_jobs"("target_race_id");
CREATE INDEX "race_series_renewal_jobs_claim_idx"
  ON "race_series_renewal_jobs"("state", "retry_at", "created_at");
CREATE INDEX "race_series_renewal_jobs_lease_expires_at_idx"
  ON "race_series_renewal_jobs"("lease_expires_at");

CREATE UNIQUE INDEX "races_rematch_live_root_idx"
  ON "races"("rematch_root_race_id")
  WHERE "rematch_root_race_id" IS NOT NULL AND "status" IN ('pending', 'active');
CREATE INDEX "races_rematch_source_race_id_idx" ON "races"("rematch_source_race_id");
CREATE INDEX "races_rematch_root_race_id_idx" ON "races"("rematch_root_race_id");
CREATE UNIQUE INDEX "races_series_predecessor_race_id_key"
  ON "races"("series_predecessor_race_id");
CREATE UNIQUE INDEX "races_series_id_series_generation_key"
  ON "races"("series_id", "series_generation");
CREATE INDEX "races_series_id_status_idx" ON "races"("series_id", "status");
CREATE INDEX "races_settlement_completed_at_idx" ON "races"("settlement_completed_at");
CREATE INDEX "race_messages_race_audience_team_created_idx"
  ON "race_messages"("race_id", "audience", "team", "created_at");
CREATE INDEX "race_participants_profile_stats_idx"
  ON "race_participants"("user_id", "status", "race_id", "placement")
  INCLUDE ("raw_steps", "forfeited_at");

ALTER TABLE "races" ADD CONSTRAINT "races_rematch_source_race_id_fkey"
  FOREIGN KEY ("rematch_source_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "races" ADD CONSTRAINT "races_rematch_root_race_id_fkey"
  FOREIGN KEY ("rematch_root_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "races" ADD CONSTRAINT "races_series_predecessor_race_id_fkey"
  FOREIGN KEY ("series_predecessor_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "race_rematch_receipts" ADD CONSTRAINT "race_rematch_receipts_requester_id_fkey"
  FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_rematch_receipts" ADD CONSTRAINT "race_rematch_receipts_source_race_id_fkey"
  FOREIGN KEY ("source_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "race_rematch_receipts" ADD CONSTRAINT "race_rematch_receipts_new_race_id_fkey"
  FOREIGN KEY ("new_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "race_rematch_notification_episodes" ADD CONSTRAINT "race_rematch_notification_episodes_recipient_id_fkey"
  FOREIGN KEY ("recipient_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_rematch_notification_episodes" ADD CONSTRAINT "race_rematch_notification_episodes_root_race_id_fkey"
  FOREIGN KEY ("root_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "race_rematch_notification_episodes" ADD CONSTRAINT "race_rematch_notification_episodes_latest_race_id_fkey"
  FOREIGN KEY ("latest_race_id") REFERENCES "races"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "race_series" ADD CONSTRAINT "race_series_creator_id_fkey"
  FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "race_series" ADD CONSTRAINT "race_series_current_race_id_fkey"
  FOREIGN KEY ("current_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "races" ADD CONSTRAINT "races_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "race_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "race_series_subscriptions" ADD CONSTRAINT "race_series_subscriptions_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "race_series"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_series_subscriptions" ADD CONSTRAINT "race_series_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_series_create_receipts" ADD CONSTRAINT "race_series_create_receipts_creator_id_fkey"
  FOREIGN KEY ("creator_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "race_series_create_receipts" ADD CONSTRAINT "race_series_create_receipts_series_id_fkey"
  FOREIGN KEY ("series_id") REFERENCES "race_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "race_series_renewal_jobs" ADD CONSTRAINT "race_series_renewal_jobs_predecessor_id_fkey"
  FOREIGN KEY ("predecessor_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "race_series_renewal_jobs" ADD CONSTRAINT "race_series_renewal_jobs_target_race_id_fkey"
  FOREIGN KEY ("target_race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A frozen pre-series backend does not know to terminalize recurrence before
-- deleting an account. Keep that old binary compatible with the additive
-- schema: PostgreSQL closes the creator's subscriptions before the FK nulls
-- creator_id, releasing every user-scoped active-series fence atomically.
CREATE FUNCTION "close_race_series_on_creator_delete"()
RETURNS TRIGGER AS $$
DECLARE
  closed_at TIMESTAMP(3) := CURRENT_TIMESTAMP;
BEGIN
  UPDATE "race_series_subscriptions"
     SET "active" = false,
         "unsubscribed_at" = COALESCE("unsubscribed_at", closed_at),
         "updated_at" = closed_at
   WHERE "active" = true
     AND "series_id" IN (
       SELECT "id" FROM "race_series" WHERE "creator_id" = OLD."id"
     );
  UPDATE "race_series"
     SET "enabled" = false,
         "ended_at" = COALESCE("ended_at", closed_at),
         "terminal_reason" = COALESCE("terminal_reason", 'CREATOR_ACCOUNT_DELETED'),
         "updated_at" = closed_at
   WHERE "creator_id" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "users_close_race_series_before_delete"
BEFORE DELETE ON "users"
FOR EACH ROW EXECUTE FUNCTION "close_race_series_on_creator_delete"();
