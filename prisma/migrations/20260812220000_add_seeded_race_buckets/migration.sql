-- Private seeded buckets are wholly additive. Existing global seeded races,
-- their participants, and frozen clients stay on the legacy stream.
CREATE TYPE "SeededRaceBucketStatus" AS ENUM ('PENDING', 'ACTIVE', 'COMPLETED');
CREATE TYPE "SeededRaceBucketAssignmentState" AS ENUM ('ELECTED', 'ASSIGNED', 'PRUNED', 'FINAL');
CREATE TYPE "SeededRaceWindowStream" AS ENUM ('LEGACY', 'BUCKET');

ALTER TABLE "races" ADD COLUMN "seeded_bucket_id" UUID;
CREATE UNIQUE INDEX "races_seeded_bucket_id_key" ON "races"("seeded_bucket_id");

CREATE TABLE "seeded_race_buckets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "seed_id" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "window_end" TIMESTAMPTZ(3) NOT NULL,
  "race_id" TEXT NOT NULL,
  "status" "SeededRaceBucketStatus" NOT NULL DEFAULT 'PENDING',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seeded_race_buckets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seeded_race_buckets_race_id_key" UNIQUE ("race_id"),
  CONSTRAINT "seeded_race_buckets_seed_id_window_start_id_key" UNIQUE ("seed_id", "window_start", "id"),
  CONSTRAINT "seeded_race_buckets_seed_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "race_seeds"("id") ON DELETE RESTRICT,
  CONSTRAINT "seeded_race_buckets_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE RESTRICT
);
CREATE INDEX "seeded_race_buckets_seed_window_status_created_idx" ON "seeded_race_buckets"("seed_id", "window_start", "status", "created_at");

CREATE TABLE "seeded_race_bucket_assignments" (
  "bucket_id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "seed_id" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "race_participant_id" TEXT NOT NULL,
  "match_steps" INTEGER NOT NULL DEFAULT 0 CHECK ("match_steps" >= 0),
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "state" "SeededRaceBucketAssignmentState" NOT NULL DEFAULT 'ASSIGNED',
  CONSTRAINT "seeded_race_bucket_assignments_pkey" PRIMARY KEY ("bucket_id", "user_id"),
  CONSTRAINT "seeded_race_bucket_assignments_race_participant_id_key" UNIQUE ("race_participant_id"),
  CONSTRAINT "seeded_race_bucket_assignments_seed_window_user_key" UNIQUE ("seed_id", "window_start", "user_id"),
  CONSTRAINT "seeded_race_bucket_assignments_bucket_id_fkey" FOREIGN KEY ("bucket_id") REFERENCES "seeded_race_buckets"("id") ON DELETE CASCADE,
  CONSTRAINT "seeded_race_bucket_assignments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "seeded_race_bucket_assignments_participant_id_fkey" FOREIGN KEY ("race_participant_id") REFERENCES "race_participants"("id") ON DELETE RESTRICT
);

CREATE TABLE "seeded_race_window_memberships" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "seed_id" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ(3) NOT NULL,
  "user_id" TEXT NOT NULL,
  "stream" "SeededRaceWindowStream" NOT NULL,
  "race_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seeded_race_window_memberships_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "seeded_race_window_memberships_seed_window_user_key" UNIQUE ("seed_id", "window_start", "user_id"),
  CONSTRAINT "seeded_race_window_memberships_seed_id_fkey" FOREIGN KEY ("seed_id") REFERENCES "race_seeds"("id") ON DELETE RESTRICT,
  CONSTRAINT "seeded_race_window_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "seeded_race_window_memberships_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE SET NULL
);
CREATE INDEX "seeded_race_window_memberships_seed_window_stream_idx" ON "seeded_race_window_memberships"("seed_id", "window_start", "stream");
