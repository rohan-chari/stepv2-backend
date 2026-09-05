CREATE OR REPLACE FUNCTION durable_capture_compact(p_limit integer DEFAULT 1000)
RETURNS TABLE(journal_deleted integer,roots_deleted integer) LANGUAGE plpgsql AS $$
DECLARE candidate record; removed_count integer; deleted_through bigint; safe_through bigint;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'invalid capture collection limit'; END IF;
  PERFORM pg_advisory_xact_lock(904205010001::bigint);
  roots_deleted := durable_capture_evict_roots(p_limit);
  journal_deleted := 0;
  -- Examine at most 32 indexed day heads, then at most p_limit journal rows.
  -- A blocked old pin cannot force a lifetime journal scan or starve others.
  FOR candidate IN SELECT * FROM durable_capture_fact_heads
    WHERE revision>compacted_revision AND next_compaction_at<=now()
    ORDER BY next_compaction_at,user_id,day LIMIT 32 FOR UPDATE SKIP LOCKED
  LOOP
    SELECT COALESCE(min(r.revision),candidate.revision) INTO safe_through FROM durable_capture_fact_roots r
      WHERE r.user_id=candidate.user_id AND r.day=candidate.day AND r.prepared_at IS NULL AND NOT r.evicting;
    -- A small recent tail enables interval projections to advance without
    -- immutable payload reads. The cap bounds storage even for hot uploaders;
    -- after ten quiet minutes normal watermark-based compaction resumes.
    IF candidate.updated_at>now()-INTERVAL '10 minutes' THEN
      safe_through := LEAST(safe_through,GREATEST(0,candidate.revision-256));
    END IF;
    WITH eligible AS (
      SELECT revision FROM durable_capture_fact_journal WHERE user_id=candidate.user_id AND day=candidate.day
        AND revision>candidate.compacted_revision AND revision<=safe_through ORDER BY revision LIMIT (p_limit-journal_deleted)
    ), removed AS (
      DELETE FROM durable_capture_fact_journal j USING eligible e WHERE j.user_id=candidate.user_id AND j.day=candidate.day
        AND j.revision=e.revision RETURNING j.revision
    ) SELECT count(*)::integer,max(revision) INTO removed_count,deleted_through FROM removed;
    journal_deleted := journal_deleted+removed_count;
    UPDATE durable_capture_fact_heads SET compacted_revision=COALESCE(deleted_through,compacted_revision),
      next_compaction_at=now()+INTERVAL '1 minute' WHERE user_id=candidate.user_id AND day=candidate.day;
    EXIT WHEN journal_deleted>=p_limit;
  END LOOP;
  -- Revision heads may return to baseline zero only after all historical
  -- versions/journal/pins are gone. Pin's shared lock excludes collection;
  -- source updates take the same head lock, preventing a revision ABA race.
  WITH candidates AS MATERIALIZED (
    SELECT user_id,day FROM durable_capture_fact_heads
    WHERE revision=compacted_revision AND updated_at<now()-INTERVAL '30 days'
    ORDER BY updated_at,user_id,day LIMIT LEAST(p_limit,32) FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM durable_capture_fact_heads h USING candidates c WHERE h.user_id=c.user_id AND h.day=c.day
      AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_roots r WHERE r.user_id=h.user_id AND r.day=h.day)
      AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_journal j WHERE j.user_id=h.user_id AND j.day=h.day)
    RETURNING h.user_id,h.day
  ) UPDATE durable_capture_fact_heads h SET updated_at=now() FROM candidates c
    WHERE h.user_id=c.user_id AND h.day=c.day
      AND NOT EXISTS(SELECT 1 FROM removed r WHERE r.user_id=h.user_id AND r.day=h.day);
  RETURN NEXT;
END;
$$;
