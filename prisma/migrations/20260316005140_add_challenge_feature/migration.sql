-- CreateEnum
CREATE TYPE "RelationshipType" AS ENUM ('partner', 'friend', 'family');

-- CreateEnum
CREATE TYPE "ChallengeType" AS ENUM ('head_to_head', 'threshold', 'creative');

-- CreateEnum
CREATE TYPE "StakeStatus" AS ENUM ('proposing', 'agreed', 'skipped');

-- CreateEnum
CREATE TYPE "ChallengeInstanceStatus" AS ENUM ('pending_stake', 'active', 'completed');

-- CreateEnum
CREATE TYPE "StakeFormat" AS ENUM ('in_person', 'virtual', 'either');

-- AlterTable
ALTER TABLE "friendships" ADD COLUMN     "relationship_type" "RelationshipType";

-- CreateTable
CREATE TABLE "challenges" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "ChallengeType" NOT NULL,
    "resolution_rule" TEXT NOT NULL,
    "threshold_value" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_instances" (
    "id" TEXT NOT NULL,
    "challenge_id" TEXT NOT NULL,
    "week_of" DATE NOT NULL,
    "user_a_id" TEXT NOT NULL,
    "user_b_id" TEXT NOT NULL,
    "stake_id" TEXT,
    "stake_status" "StakeStatus" NOT NULL DEFAULT 'proposing',
    "proposed_by_id" TEXT,
    "proposed_stake_id" TEXT,
    "status" "ChallengeInstanceStatus" NOT NULL DEFAULT 'pending_stake',
    "winner_user_id" TEXT,
    "user_a_total_steps" INTEGER NOT NULL DEFAULT 0,
    "user_b_total_steps" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "challenge_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stakes" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "relationship_tags" TEXT[],
    "format" "StakeFormat" NOT NULL,
    "sponsor_id" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "challenge_streaks" (
    "id" TEXT NOT NULL,
    "user_a_id" TEXT NOT NULL,
    "user_b_id" TEXT NOT NULL,
    "current_winner_user_id" TEXT,
    "current_streak" INTEGER NOT NULL DEFAULT 0,
    "user_a_lifetime_wins" INTEGER NOT NULL DEFAULT 0,
    "user_b_lifetime_wins" INTEGER NOT NULL DEFAULT 0,
    "last_resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "challenge_streaks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "challenge_instances_user_a_id_status_idx" ON "challenge_instances"("user_a_id", "status");

-- CreateIndex
CREATE INDEX "challenge_instances_user_b_id_status_idx" ON "challenge_instances"("user_b_id", "status");

-- CreateIndex
CREATE INDEX "challenge_instances_week_of_idx" ON "challenge_instances"("week_of");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_instances_user_a_id_user_b_id_week_of_key" ON "challenge_instances"("user_a_id", "user_b_id", "week_of");

-- CreateIndex
CREATE UNIQUE INDEX "challenge_streaks_user_a_id_user_b_id_key" ON "challenge_streaks"("user_a_id", "user_b_id");

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_challenge_id_fkey" FOREIGN KEY ("challenge_id") REFERENCES "challenges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_stake_id_fkey" FOREIGN KEY ("stake_id") REFERENCES "stakes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_proposed_stake_id_fkey" FOREIGN KEY ("proposed_stake_id") REFERENCES "stakes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_winner_user_id_fkey" FOREIGN KEY ("winner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_instances" ADD CONSTRAINT "challenge_instances_proposed_by_id_fkey" FOREIGN KEY ("proposed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_streaks" ADD CONSTRAINT "challenge_streaks_user_a_id_fkey" FOREIGN KEY ("user_a_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "challenge_streaks" ADD CONSTRAINT "challenge_streaks_user_b_id_fkey" FOREIGN KEY ("user_b_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
