-- Not inside BEGIN: build concurrently while production keeps writing scores.
-- This expression index exactly matches the persisted page ordering; the
-- separate privacy rank context intentionally retains its existing ordering.
CREATE INDEX CONCURRENTLY race_participants_persisted_standings_idx
ON race_participants (
  race_id,
  (CASE WHEN finished_at IS NOT NULL THEN 0 ELSE 1 END),
  (CASE WHEN finished_at IS NOT NULL THEN placement END) ASC NULLS LAST,
  (CASE WHEN finished_at IS NOT NULL THEN finished_at END) ASC NULLS LAST,
  (CASE WHEN finished_at IS NULL THEN total_steps END) DESC NULLS LAST,
  joined_at ASC,
  user_id ASC
) WHERE status = 'accepted'::"RaceParticipantStatus";
