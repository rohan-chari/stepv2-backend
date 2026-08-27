CREATE TYPE "FeedbackEmailAttemptState" AS ENUM ('RESERVED', 'ACCEPTED', 'FAILED');

CREATE TABLE "feedback_email_attempts" (
  "id" UUID NOT NULL,
  "user_id" TEXT NOT NULL,
  "utc_day" TIMESTAMP(3) NOT NULL,
  "state" "FeedbackEmailAttemptState" NOT NULL DEFAULT 'RESERVED',
  "message_id" TEXT NOT NULL,
  "last_error_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "feedback_email_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "feedback_email_attempts_user_id_utc_day_state_idx"
  ON "feedback_email_attempts"("user_id", "utc_day", "state");

CREATE INDEX "feedback_email_attempts_expires_at_idx"
  ON "feedback_email_attempts"("expires_at");

ALTER TABLE "feedback_email_attempts"
  ADD CONSTRAINT "feedback_email_attempts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
