-- Queue-first STEP_SYNC messages may be processed out of order by concurrent
-- consumers or after reclaim. Keep the latest accepted daily payload authoritative
-- without forcing daily totals to be monotonic (Health corrections may decrease).
ALTER TABLE "steps"
  ADD COLUMN "sync_requested_at" TIMESTAMPTZ(3);
