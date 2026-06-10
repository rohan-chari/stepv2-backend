-- Ranked v2: weekly cohorts. Fully additive — legacy seasons/season_scores
-- untouched, new users columns nullable.

-- CreateEnum
CREATE TYPE "RankedWeekStatus" AS ENUM ('active', 'settling', 'closed');

-- AlterTable (earn-only cosmetics, e.g. the Legend ranked accessory)
ALTER TABLE "shop_items" ADD COLUMN "earn_only" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "ranked_tier_v2" TEXT,
ADD COLUMN     "ranked_tier_v2_since" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ranked_weeks" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "starts_on" TIMESTAMP(3) NOT NULL,
    "ends_on" TIMESTAMP(3) NOT NULL,
    "status" "RankedWeekStatus" NOT NULL DEFAULT 'active',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranked_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranked_cohorts" (
    "id" TEXT NOT NULL,
    "week_id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ranked_cohorts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ranked_cohort_members" (
    "id" TEXT NOT NULL,
    "week_id" TEXT NOT NULL,
    "cohort_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "weekly_steps" INTEGER NOT NULL DEFAULT 0,
    "provisional_rank" INTEGER,
    "final_rank" INTEGER,
    "outcome" TEXT,
    "result_tier" TEXT,
    "reward_coins" INTEGER,
    "promotion_coins" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ranked_cohort_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ranked_weeks_index_key" ON "ranked_weeks"("index");

-- CreateIndex
CREATE INDEX "ranked_weeks_status_idx" ON "ranked_weeks"("status");

-- CreateIndex
CREATE INDEX "ranked_cohorts_week_id_tier_idx" ON "ranked_cohorts"("week_id", "tier");

-- CreateIndex
CREATE INDEX "ranked_cohort_members_cohort_id_weekly_steps_idx" ON "ranked_cohort_members"("cohort_id", "weekly_steps");

-- CreateIndex
CREATE UNIQUE INDEX "ranked_cohort_members_week_id_user_id_key" ON "ranked_cohort_members"("week_id", "user_id");

-- AddForeignKey
ALTER TABLE "ranked_cohorts" ADD CONSTRAINT "ranked_cohorts_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "ranked_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranked_cohort_members" ADD CONSTRAINT "ranked_cohort_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranked_cohort_members" ADD CONSTRAINT "ranked_cohort_members_cohort_id_fkey" FOREIGN KEY ("cohort_id") REFERENCES "ranked_cohorts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ranked_cohort_members" ADD CONSTRAINT "ranked_cohort_members_week_id_fkey" FOREIGN KEY ("week_id") REFERENCES "ranked_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
