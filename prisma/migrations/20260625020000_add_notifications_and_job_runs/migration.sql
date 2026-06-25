-- Audit log of every user-facing (visible) push we send. Written at each visible
-- send site in notificationHandlers.js; silent refresh pushes are NOT recorded.
-- `type` is a free-form text column (the push payload's type) so new notification
-- kinds need no migration. A nightly job prunes rows older than a week. Storage
-- only: no API exposes it, so already-shipped app versions are unaffected.
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT,
    "body" TEXT,
    "race_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_user_id_created_at_idx" ON "notifications"("user_id", "created_at");
CREATE INDEX "notifications_created_at_idx" ON "notifications"("created_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Once-per-day idempotency marker for ET-anchored cron jobs. `last_ran_for` holds
-- the ET calendar day (YYYY-MM-DD) the job last completed for, so a job fires
-- exactly once per ET day across restarts and regardless of DST. One row per job.
CREATE TABLE "job_runs" (
    "job_name" TEXT NOT NULL,
    "last_ran_for" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("job_name")
);
