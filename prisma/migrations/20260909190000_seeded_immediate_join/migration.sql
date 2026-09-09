-- AlterTable
ALTER TABLE "seeded_race_buckets" ADD COLUMN     "admission_version" INTEGER;

-- AlterTable
ALTER TABLE "seeded_race_window_memberships" ADD COLUMN     "admission_source" TEXT,
ADD COLUMN     "election_sequence" BIGSERIAL NOT NULL,
ADD COLUMN     "manual_joined_at" TIMESTAMPTZ(3),
ADD COLUMN     "preparation_group_id" TEXT;

-- CreateTable
CREATE TABLE "seeded_challenge_join_receipts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "race_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "joined_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seeded_challenge_join_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seeded_challenge_preparations" (
    "id" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "preparation_version" INTEGER NOT NULL DEFAULT 1,
    "generation" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PLANNING',
    "snapshot_sequence" BIGINT NOT NULL DEFAULT 0,
    "planning_cursor" INTEGER NOT NULL DEFAULT 0,
    "validation_cursor" BIGINT NOT NULL DEFAULT 0,
    "expected_snapshot_count" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "not_before_at" TIMESTAMP(3) NOT NULL,
    "last_error_code" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seeded_challenge_preparations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seeded_challenge_preparation_groups" (
    "id" TEXT NOT NULL,
    "preparation_id" TEXT NOT NULL,
    "generation" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "reserved_race_id" TEXT NOT NULL,
    "reserved_bucket_id" TEXT NOT NULL,
    "members" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'RESERVED',
    "materialized_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seeded_challenge_preparation_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seeded_challenge_enrollment_requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "window_end" TIMESTAMPTZ(3) NOT NULL,
    "source" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error_code" TEXT,

    CONSTRAINT "seeded_challenge_enrollment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seeded_challenge_transfers" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "old_race_id" TEXT NOT NULL,
    "new_race_id" TEXT NOT NULL,
    "old_participant_id" TEXT NOT NULL,
    "new_participant_id" TEXT NOT NULL,
    "prior_assignment" TEXT,
    "new_assignment" TEXT NOT NULL,
    "source_state" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seeded_challenge_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seeded_challenge_membership_repairs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seed_id" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "source_participant_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_token" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "result" TEXT,

    CONSTRAINT "seeded_challenge_membership_repairs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seeded_challenge_join_receipts_window_end_id_idx" ON "seeded_challenge_join_receipts"("window_end", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_join_receipts_user_id_request_id_key" ON "seeded_challenge_join_receipts"("user_id", "request_id");

-- CreateIndex
CREATE INDEX "seeded_challenge_preparations_state_not_before_at_idx" ON "seeded_challenge_preparations"("state", "not_before_at");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_preparations_seed_id_window_start_key" ON "seeded_challenge_preparations"("seed_id", "window_start");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_preparation_groups_reserved_race_id_key" ON "seeded_challenge_preparation_groups"("reserved_race_id");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_preparation_groups_reserved_bucket_id_key" ON "seeded_challenge_preparation_groups"("reserved_bucket_id");

-- CreateIndex
CREATE INDEX "seeded_challenge_preparation_groups_preparation_id_state_or_idx" ON "seeded_challenge_preparation_groups"("preparation_id", "state", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_preparation_groups_preparation_id_generati_key" ON "seeded_challenge_preparation_groups"("preparation_id", "generation", "ordinal");

-- CreateIndex
CREATE INDEX "seeded_challenge_enrollment_requests_state_available_at_id_idx" ON "seeded_challenge_enrollment_requests"("state", "available_at", "id");

-- CreateIndex
CREATE INDEX "seeded_challenge_enrollment_requests_lease_expires_at_idx" ON "seeded_challenge_enrollment_requests"("lease_expires_at");

-- CreateIndex
CREATE INDEX "seeded_challenge_enrollment_requests_window_end_id_idx" ON "seeded_challenge_enrollment_requests"("window_end", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_enrollment_requests_user_id_seed_id_window_key" ON "seeded_challenge_enrollment_requests"("user_id", "seed_id", "window_start");

-- CreateIndex
CREATE INDEX "seeded_challenge_transfers_user_id_seed_id_window_start_idx" ON "seeded_challenge_transfers"("user_id", "seed_id", "window_start");

-- CreateIndex
CREATE INDEX "seeded_challenge_membership_repairs_state_available_at_id_idx" ON "seeded_challenge_membership_repairs"("state", "available_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "seeded_challenge_membership_repairs_user_id_seed_id_window__key" ON "seeded_challenge_membership_repairs"("user_id", "seed_id", "window_start");


CREATE INDEX seeded_membership_unassigned ON seeded_race_window_memberships(seed_id, window_start, election_sequence) WHERE stream = 'BUCKET' AND race_id IS NULL;
CREATE INDEX seeded_membership_reservation ON seeded_race_window_memberships(preparation_group_id, race_id);
ALTER TABLE seeded_challenge_join_receipts ADD CONSTRAINT seeded_join_receipts_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE seeded_challenge_enrollment_requests ADD CONSTRAINT seeded_enrollment_requests_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE seeded_challenge_transfers ADD CONSTRAINT seeded_transfers_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE seeded_challenge_membership_repairs ADD CONSTRAINT seeded_membership_repairs_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE seeded_challenge_preparation_groups ADD CONSTRAINT seeded_plan_group_fk FOREIGN KEY (preparation_id) REFERENCES seeded_challenge_preparations(id) ON DELETE CASCADE;
ALTER TABLE seeded_challenge_preparation_groups ADD CONSTRAINT seeded_plan_members_bounded CHECK (jsonb_typeof(members) = 'array' AND jsonb_array_length(members) <= 100);
