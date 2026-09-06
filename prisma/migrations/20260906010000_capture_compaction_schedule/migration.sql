-- One durable maintenance deadline, independent of summary wake frequency.
-- Old binaries may continue calling durable_capture_compact directly during
-- a rolling deployment; the existing advisory lock still serializes both paths.
CREATE TABLE durable_capture_compaction_schedule (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  next_due_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz
);

CREATE FUNCTION durable_capture_compact_if_due(p_limit integer DEFAULT 128)
RETURNS TABLE(ran boolean, journal_deleted integer, roots_deleted integer, next_due_at timestamptz)
LANGUAGE plpgsql AS $$
DECLARE deadline timestamptz; work record; more_work boolean;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'invalid capture collection limit'; END IF;
  ran := false; journal_deleted := 0; roots_deleted := 0;
  IF NOT EXISTS (SELECT 1 FROM durable_capture_compaction_schedule) THEN
    INSERT INTO durable_capture_compaction_schedule(singleton) VALUES (true) ON CONFLICT DO NOTHING;
  END IF;
  SELECT schedule.next_due_at INTO next_due_at FROM durable_capture_compaction_schedule schedule;
  SELECT schedule.next_due_at INTO deadline FROM durable_capture_compaction_schedule schedule
    WHERE schedule.singleton AND schedule.next_due_at <= clock_timestamp()
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;

  SELECT * INTO work FROM durable_capture_compact(p_limit);
  journal_deleted := work.journal_deleted; roots_deleted := work.roots_deleted; ran := true;
  more_work := journal_deleted >= p_limit OR roots_deleted >= LEAST(p_limit,32)
    OR EXISTS (SELECT 1 FROM durable_capture_fact_roots WHERE evicting)
    OR EXISTS (SELECT 1 FROM durable_capture_fact_roots
      WHERE NOT evicting AND last_used_at < clock_timestamp()-interval '10 minutes')
    OR EXISTS (SELECT 1 FROM durable_capture_fact_heads
      WHERE revision>compacted_revision AND next_compaction_at<=clock_timestamp())
    OR EXISTS (SELECT 1 FROM durable_capture_fact_heads
      WHERE revision=compacted_revision AND updated_at<clock_timestamp()-interval '30 days');
  deadline := clock_timestamp();
  UPDATE durable_capture_compaction_schedule schedule
    SET next_due_at=deadline+CASE WHEN more_work THEN interval '1 second' ELSE interval '1 minute' END,
        last_completed_at=deadline
    WHERE schedule.singleton RETURNING schedule.next_due_at INTO next_due_at;
  RETURN NEXT;
END;
$$;
