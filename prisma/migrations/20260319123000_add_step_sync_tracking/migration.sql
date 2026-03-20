-- AlterTable
ALTER TABLE "users"
ADD COLUMN "last_step_sync_at" TIMESTAMP(3),
ADD COLUMN "last_silent_push_sent_at" TIMESTAMP(3);
