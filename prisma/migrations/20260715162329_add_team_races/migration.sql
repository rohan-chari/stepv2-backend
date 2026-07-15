-- CreateEnum
CREATE TYPE "RaceTeam" AS ENUM ('team_a', 'team_b');

-- AlterTable
ALTER TABLE "race_participants" ADD COLUMN     "team" "RaceTeam";

-- AlterTable
ALTER TABLE "races" ADD COLUMN     "is_team_race" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "team_a_name" TEXT,
ADD COLUMN     "team_b_name" TEXT,
ADD COLUMN     "team_size" INTEGER,
ADD COLUMN     "winner_team" "RaceTeam";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "client_features" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "client_features_at" TIMESTAMP(3);
