-- Expand-only persistence for the 2026-08-25 feature batch. Existing app
-- binaries never read these columns/tables, and every new column is nullable or
-- has a safe default so the currently deployed backend can run during rollout.

ALTER TABLE "feedback_threads"
  ADD COLUMN "last_staff_reply_at" TIMESTAMP(3),
  ADD COLUMN "last_staff_reply_message_id" TEXT;

UPDATE "feedback_threads" AS thread
SET ("last_staff_reply_at", "last_staff_reply_message_id") = (
  SELECT message."created_at", message."id"
  FROM "feedback_messages" AS message
  WHERE message."thread_id" = thread."id"
    AND message."sender_kind" = 'STAFF'
  ORDER BY message."created_at" DESC, message."id" DESC
  LIMIT 1
)
WHERE EXISTS (
  SELECT 1
  FROM "feedback_messages" AS message
  WHERE message."thread_id" = thread."id"
    AND message."sender_kind" = 'STAFF'
);

CREATE INDEX "feedback_threads_user_id_last_staff_reply_at_id_idx"
  ON "feedback_threads"("user_id", "last_staff_reply_at" DESC, "id" DESC);

ALTER TABLE "powerup_shop_items"
  ADD COLUMN "daily_reward_eligible" BOOLEAN NOT NULL DEFAULT true;

UPDATE "powerup_shop_items"
SET
  "active" = true,
  "test_only" = false,
  "daily_reward_eligible" = false
WHERE "sku" = 'POWERUP_HITCHHIKE';

CREATE INDEX "race_powerups_user_id_status_race_id_idx"
  ON "race_powerups"("user_id", "status", "race_id");

CREATE TABLE "race_share_links" (
  "id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "race_id" TEXT NOT NULL,
  "shared_by_user_id" TEXT,
  "shared_by_display_name" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  CONSTRAINT "race_share_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "race_share_links_token_hash_key"
  ON "race_share_links"("token_hash");
CREATE INDEX "race_share_links_race_id_shared_by_user_id_revoked_at_idx"
  ON "race_share_links"("race_id", "shared_by_user_id", "revoked_at");
ALTER TABLE "race_share_links"
  ADD CONSTRAINT "race_share_links_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "race_share_links_shared_by_user_id_fkey"
    FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "race_join_requests" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "share_link_id" TEXT NOT NULL,
  "shared_by_user_id" TEXT,
  "shared_by_display_name" TEXT,
  "requester_user_id" TEXT NOT NULL,
  "requester_display_name" TEXT,
  "creator_user_id" TEXT NOT NULL,
  "team" "RaceTeam",
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_at" TIMESTAMP(3),
  "terminal_actor_user_id" TEXT,
  "failure_code" VARCHAR(96),
  CONSTRAINT "race_join_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_join_requests_status_check"
    CHECK ("status" IN ('PENDING', 'ACCEPTED', 'DECLINED', 'EXPIRED'))
);

CREATE UNIQUE INDEX "race_join_requests_pending_race_requester_key"
  ON "race_join_requests"("race_id", "requester_user_id")
  WHERE "status" = 'PENDING';
CREATE INDEX "race_join_requests_race_id_status_created_at_id_idx"
  ON "race_join_requests"("race_id", "status", "created_at" DESC, "id" DESC);
CREATE INDEX "race_join_requests_race_id_requester_user_id_created_at_idx"
  ON "race_join_requests"("race_id", "requester_user_id", "created_at" DESC);
ALTER TABLE "race_join_requests"
  ADD CONSTRAINT "race_join_requests_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "race_join_requests_share_link_id_fkey"
    FOREIGN KEY ("share_link_id") REFERENCES "race_share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "race_join_requests_shared_by_user_id_fkey"
    FOREIGN KEY ("shared_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "race_join_requests_requester_user_id_fkey"
    FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "race_join_requests_creator_user_id_fkey"
    FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "race_join_requests_terminal_actor_user_id_fkey"
    FOREIGN KEY ("terminal_actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "race_admin_commands" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "command_type" VARCHAR(64) NOT NULL,
  "dedupe_key" VARCHAR(255) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  "lease_token" VARCHAR(64),
  "lease_expires_at" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "last_error" TEXT,
  CONSTRAINT "race_admin_commands_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_admin_commands_status_check"
    CHECK ("status" IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED'))
);

CREATE UNIQUE INDEX "race_admin_commands_dedupe_key_key"
  ON "race_admin_commands"("dedupe_key");
CREATE INDEX "race_admin_commands_status_available_at_created_at_idx"
  ON "race_admin_commands"("status", "available_at", "created_at");
CREATE INDEX "race_admin_commands_race_id_status_idx"
  ON "race_admin_commands"("race_id", "status");
ALTER TABLE "race_admin_commands"
  ADD CONSTRAINT "race_admin_commands_race_id_fkey"
    FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Fresh/future tournament configuration is corrected immediately. Active
-- matchup participant baselines are intentionally NOT bulk-written here; they
-- enter the C0 single-writer through durable commands below.
UPDATE "tournament_seeds"
SET "powerups_enabled" = true,
    "powerup_step_interval" = 2000,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 'seed-tournament-weekly-showdown';

UPDATE "tournaments"
SET "powerups_enabled" = true,
    "powerup_step_interval" = 2000
WHERE "seed_id" = 'seed-tournament-weekly-showdown'
  AND "status" IN ('pending'::"TournamentStatus", 'active'::"TournamentStatus");

INSERT INTO "race_admin_commands" (
  "id", "race_id", "command_type", "dedupe_key", "payload"
)
SELECT
  gen_random_uuid()::text,
  race."id",
  'TOURNAMENT_POWERUPS_ACTIVATE',
  'tournament-powerups-activate:' || tournament."id" || ':' || race."id",
  jsonb_build_object(
    'raceId', race."id",
    'tournamentId', tournament."id",
    'activatedAt', CURRENT_TIMESTAMP,
    'interval', 2000
  )
FROM "races" AS race
JOIN "tournaments" AS tournament ON tournament."id" = race."tournament_id"
WHERE tournament."seed_id" = 'seed-tournament-weekly-showdown'
  AND tournament."status" IN ('pending'::"TournamentStatus", 'active'::"TournamentStatus")
  AND race."status" = 'active'::"RaceStatus"
  AND race."powerups_enabled" = false
ORDER BY race."id"
ON CONFLICT ("dedupe_key") DO NOTHING;
