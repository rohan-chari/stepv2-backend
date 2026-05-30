-- CreateEnum
CREATE TYPE "SeasonStatus" AS ENUM ('active', 'settling', 'closed');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "current_tier" TEXT,
ADD COLUMN     "current_division" INTEGER;

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "status" "SeasonStatus" NOT NULL DEFAULT 'active',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_scores" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "carry_over_seed" INTEGER NOT NULL DEFAULT 0,
    "earned_points" INTEGER NOT NULL DEFAULT 0,
    "provisional_rank" INTEGER,
    "provisional_tier" TEXT,
    "provisional_division" INTEGER,
    "rank" INTEGER,
    "tier" TEXT,
    "division" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "season_scores_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seasons_index_key" ON "seasons"("index");

-- CreateIndex
CREATE INDEX "seasons_status_idx" ON "seasons"("status");

-- CreateIndex
CREATE INDEX "season_scores_season_id_points_idx" ON "season_scores"("season_id", "points");

-- CreateIndex
CREATE UNIQUE INDEX "season_scores_user_id_season_id_key" ON "season_scores"("user_id", "season_id");

-- AddForeignKey
ALTER TABLE "season_scores" ADD CONSTRAINT "season_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "season_scores" ADD CONSTRAINT "season_scores_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
