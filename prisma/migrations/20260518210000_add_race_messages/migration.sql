-- CreateEnum
CREATE TYPE "RaceMessageKind" AS ENUM ('user', 'system');

-- AlterTable
ALTER TABLE "race_participants"
  ADD COLUMN "last_read_race_chat_at" TIMESTAMP(3),
  ADD COLUMN "last_chat_push_at" TIMESTAMP(3),
  ADD COLUMN "chat_muted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "race_messages" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "sender_id" TEXT,
  "kind" "RaceMessageKind" NOT NULL DEFAULT 'user',
  "body" VARCHAR(500) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMP(3),

  CONSTRAINT "race_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "race_messages_race_id_created_at_idx" ON "race_messages"("race_id", "created_at");

-- AddForeignKey
ALTER TABLE "race_messages" ADD CONSTRAINT "race_messages_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "race_messages" ADD CONSTRAINT "race_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
