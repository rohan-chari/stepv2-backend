-- Trigger installation and the one-time backfill must be atomic: writers
-- cannot slip a membership change between the snapshot and trigger activation.
BEGIN;
-- Fail deployment rather than sit behind a long transaction while subsequent
-- membership/score writers queue behind this DDL. Retry only after inspection.
SET LOCAL lock_timeout = '5s';
LOCK TABLE race_participants IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE race_accepted_participant_counts (
  race_id text PRIMARY KEY REFERENCES races(id) ON DELETE CASCADE,
  accepted_count integer NOT NULL CHECK (accepted_count >= 0)
);

-- Statement transition tables make bulk joins/moves one counter update per
-- affected race. Both sides of a move acquire counters in race-ID order, even
-- for multi-row moves. Score-only UPDATEs produce no deltas and acquire no
-- counter locks. No app/worker code needs to know about this projection.
CREATE FUNCTION maintain_race_accepted_participant_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  change record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR change IN
      SELECT race_id, COUNT(*)::integer AS delta FROM new_memberships
      WHERE status = 'accepted'::"RaceParticipantStatus"
      GROUP BY race_id ORDER BY race_id
    LOOP
      INSERT INTO race_accepted_participant_counts(race_id, accepted_count)
      VALUES(change.race_id, change.delta)
      ON CONFLICT(race_id) DO UPDATE
        SET accepted_count = race_accepted_participant_counts.accepted_count + EXCLUDED.accepted_count;
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR change IN
      SELECT race_id, COUNT(*)::integer AS delta FROM old_memberships
      WHERE status = 'accepted'::"RaceParticipantStatus"
      GROUP BY race_id ORDER BY race_id
    LOOP
      -- Cascaded race deletion may already have removed its count row.
      UPDATE race_accepted_participant_counts
        SET accepted_count = accepted_count - change.delta WHERE race_id = change.race_id;
    END LOOP;
  ELSE
    FOR change IN
      SELECT race_id, SUM(delta)::integer AS delta FROM (
        SELECT n.race_id, 1 AS delta FROM new_memberships n
        JOIN old_memberships o USING (id)
        WHERE n.status = 'accepted'::"RaceParticipantStatus"
          AND (n.race_id IS DISTINCT FROM o.race_id OR n.status IS DISTINCT FROM o.status)
        UNION ALL
        SELECT o.race_id, -1 AS delta FROM old_memberships o
        JOIN new_memberships n USING (id)
        WHERE o.status = 'accepted'::"RaceParticipantStatus"
          AND (n.race_id IS DISTINCT FROM o.race_id OR n.status IS DISTINCT FROM o.status)
      ) deltas
      GROUP BY race_id HAVING SUM(delta) <> 0 ORDER BY race_id
    LOOP
      IF change.delta > 0 THEN
        INSERT INTO race_accepted_participant_counts(race_id, accepted_count)
        VALUES(change.race_id, change.delta)
        ON CONFLICT(race_id) DO UPDATE
          SET accepted_count = race_accepted_participant_counts.accepted_count + EXCLUDED.accepted_count;
      ELSE
        UPDATE race_accepted_participant_counts
          SET accepted_count = accepted_count + change.delta WHERE race_id = change.race_id;
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER race_accepted_counts_insert AFTER INSERT ON race_participants
REFERENCING NEW TABLE AS new_memberships FOR EACH STATEMENT
EXECUTE FUNCTION maintain_race_accepted_participant_counts();
CREATE TRIGGER race_accepted_counts_delete AFTER DELETE ON race_participants
REFERENCING OLD TABLE AS old_memberships FOR EACH STATEMENT
EXECUTE FUNCTION maintain_race_accepted_participant_counts();
CREATE TRIGGER race_accepted_counts_update AFTER UPDATE ON race_participants
REFERENCING OLD TABLE AS old_memberships NEW TABLE AS new_memberships FOR EACH STATEMENT
EXECUTE FUNCTION maintain_race_accepted_participant_counts();

INSERT INTO race_accepted_participant_counts(race_id, accepted_count)
SELECT race_id, COUNT(*)::integer FROM race_participants
WHERE status = 'accepted'::"RaceParticipantStatus" GROUP BY race_id;
COMMIT;
