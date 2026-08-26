-- Exact, event-time-owned access path for recent referral race activity.
-- All changes are additive and safe while old workers continue to run.
CREATE TABLE "referral_race_activities" (
  "id" TEXT NOT NULL,
  "referral_id" TEXT NOT NULL,
  "referrer_id" TEXT,
  "race_participant_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "referral_race_activities_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_race_activities_referral_id_fkey"
    FOREIGN KEY ("referral_id") REFERENCES "referrals"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "referral_race_activities_referrer_id_fkey"
    FOREIGN KEY ("referrer_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "referral_race_activities_race_participant_id_fkey"
    FOREIGN KEY ("race_participant_id") REFERENCES "race_participants"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "referral_race_activities_race_participant_id_key"
  ON "referral_race_activities"("race_participant_id");

CREATE INDEX "referral_race_activities_referrer_id_occurred_at_id_idx"
  ON "referral_race_activities"("referrer_id", "occurred_at", "id");

-- Historical ownership is stamped from the live attribution that existed no
-- later than the participant join. This is one set-based SQL pass, never an
-- application loop, and retries are idempotent on race_participant_id.
INSERT INTO "referral_race_activities" (
  "id",
  "referral_id",
  "referrer_id",
  "race_participant_id",
  "occurred_at",
  "created_at"
)
SELECT
  gen_random_uuid()::text,
  referral."id",
  referral."referrer_id",
  participant."id",
  participant."joined_at",
  CURRENT_TIMESTAMP
FROM "race_participants" participant
INNER JOIN "races" race
  ON race."id" = participant."race_id"
  AND race."seed_id" IS NULL
  AND race."tournament_id" IS NULL
INNER JOIN "referrals" referral
  ON referral."referee_id" = participant."user_id"
  AND referral."referrer_id" IS NOT NULL
  AND referral."created_at" <= participant."joined_at"
WHERE participant."status" = 'accepted'
ON CONFLICT ("race_participant_id") DO NOTHING;
