-- Queue-first STEP_SYNC messages can share the same millisecond accepted_at.
-- Persist the Redis Stream entry id so out-of-order workers still have a total
-- acceptance order for the daily canonical step row.
ALTER TABLE "steps"
ADD COLUMN "sync_stream_id" TEXT;
