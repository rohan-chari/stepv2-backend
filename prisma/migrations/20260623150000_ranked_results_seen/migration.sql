-- Ranked weekly-cohort results "seen" acknowledgment. Purely additive +
-- display-only (mirrors race_participants.results_seen_at). Old app builds never
-- read/ack this field.
-- IF NOT EXISTS keeps this safe to re-apply if a prior deploy added the column
-- before the backfill completed.
ALTER TABLE "ranked_cohort_members" ADD COLUMN IF NOT EXISTS "results_seen_at" TIMESTAMP;

-- Backfill: mark every already-settled member as seen so only weeks that settle
-- AFTER this ships trigger the popup. A member is "settled" once its week is
-- closed (RankedWeekStatus is @map-ed to lowercase in Postgres, so compare
-- against 'closed', not the uppercase Prisma identifier). Members of ACTIVE /
-- SETTLING weeks stay NULL so their future settlement still shows.
UPDATE "ranked_cohort_members" m
SET "results_seen_at" = NOW()
FROM "ranked_weeks" w
WHERE m."week_id" = w."id"
  AND w."status" = 'closed';
