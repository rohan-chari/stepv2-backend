-- Additive cursor state. Retention/pinning and public function signatures stay
-- compatible with the previous binary. Direct calls never take the outer
-- schedule lock: scheduled -> advisory -> sweep -> roots/heads is the only order.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE durable_capture_root_sweep (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  after_id uuid,
  next_due_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO durable_capture_root_sweep(singleton) VALUES (true);

CREATE OR REPLACE FUNCTION durable_capture_evict_roots_internal(p_limit integer, force_sweep boolean) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE removed_count integer; sweep record; examined uuid[]; examined_count integer; marked_count integer := 0;
BEGIN
  IF p_limit<1 OR p_limit>10000 THEN RAISE EXCEPTION 'invalid capture eviction limit'; END IF;
  PERFORM pg_advisory_xact_lock(904205010001::bigint);
  IF NOT EXISTS (SELECT 1 FROM durable_capture_root_sweep) THEN
    INSERT INTO durable_capture_root_sweep(singleton) VALUES (true) ON CONFLICT DO NOTHING;
  END IF;
  SELECT * INTO sweep FROM durable_capture_root_sweep WHERE singleton FOR UPDATE;
  IF force_sweep THEN
    -- Compatibility with old direct collectors: an explicitly aged oldest
    -- root must start its bounded child drain on this call, even when the fair
    -- cursor is elsewhere. This reads at most one extra p_limit page and does
    -- not rewrite retained roots. Scheduled callers never pay for this probe.
    -- An active pin alone prevents eviction; do not inspect its revision head.
    WITH oldest AS MATERIALIZED (
      SELECT r.id FROM durable_capture_fact_roots r
      WHERE NOT r.evicting AND r.last_used_at < now()-interval '10 minutes'
      ORDER BY r.last_used_at,r.id LIMIT p_limit
    ), eligible AS MATERIALIZED (
      SELECT r.id FROM oldest o JOIN durable_capture_fact_roots r ON r.id=o.id
      LEFT JOIN LATERAL (
        SELECT p.root_id FROM durable_capture_fact_pins p WHERE p.root_id=r.id LIMIT 1
      ) pin ON true
      WHERE CASE WHEN pin.root_id IS NOT NULL THEN false
        ELSE r.retention_expires_at < now() OR r.revision < COALESCE(
          (SELECT h.revision FROM durable_capture_fact_heads h
           WHERE h.user_id=r.user_id AND h.day=r.day),0) END
    ) UPDATE durable_capture_fact_roots r SET evicting=true,last_used_at=now()
      FROM eligible e WHERE r.id=e.id;
    GET DIAGNOSTICS marked_count = ROW_COUNT;
  END IF;
  IF force_sweep OR sweep.next_due_at <= clock_timestamp() THEN
    -- Visit every ID, including pinned/current roots. A retained root is only
    -- read: neither its identity nor its age is rewritten to advance fairness.
    IF sweep.after_id IS NULL THEN
      SELECT array_agg(page.id ORDER BY page.id) INTO examined FROM (
        SELECT id FROM durable_capture_fact_roots ORDER BY id LIMIT p_limit
      ) page;
    ELSE
      SELECT array_agg(page.id ORDER BY page.id) INTO examined FROM (
        SELECT id FROM durable_capture_fact_roots WHERE id > sweep.after_id ORDER BY id LIMIT p_limit
      ) page;
    END IF;
    examined_count := COALESCE(cardinality(examined),0);
    WITH eligible AS MATERIALIZED (
      SELECT r.id FROM unnest(examined) page(id)
      JOIN durable_capture_fact_roots r ON r.id=page.id
      LEFT JOIN LATERAL (
        SELECT p.root_id FROM durable_capture_fact_pins p WHERE p.root_id=r.id LIMIT 1
      ) pin ON true
      WHERE NOT r.evicting AND r.last_used_at < now()-interval '10 minutes'
        AND CASE WHEN pin.root_id IS NOT NULL THEN false
          ELSE r.retention_expires_at < now() OR r.revision < COALESCE(
            (SELECT h.revision FROM durable_capture_fact_heads h
             WHERE h.user_id=r.user_id AND h.day=r.day),0) END
      ORDER BY r.id LIMIT GREATEST(0,p_limit-marked_count)
    ) UPDATE durable_capture_fact_roots r SET evicting=true,last_used_at=now()
      FROM eligible e WHERE r.id=e.id;
    UPDATE durable_capture_root_sweep SET
      after_id=CASE WHEN examined_count=p_limit THEN examined[examined_count] ELSE NULL END,
      next_due_at=clock_timestamp()+CASE WHEN examined_count=p_limit THEN interval '1 second' ELSE interval '1 minute' END
      WHERE singleton;
  END IF;
  WITH roots AS MATERIALIZED (
    SELECT id FROM durable_capture_fact_roots WHERE evicting ORDER BY last_used_at,id LIMIT LEAST(p_limit,32) FOR UPDATE SKIP LOCKED
  ), candidates AS MATERIALIZED (
    SELECT p.root_id,p.page_number FROM roots r CROSS JOIN LATERAL (
      SELECT root_id,page_number FROM durable_capture_fact_pages WHERE root_id=r.id ORDER BY page_number LIMIT p_limit
    ) p LIMIT p_limit
  ) DELETE FROM durable_capture_fact_pages p USING candidates c WHERE p.root_id=c.root_id AND p.page_number=c.page_number;
  WITH roots AS MATERIALIZED (
    SELECT id FROM durable_capture_fact_roots WHERE evicting ORDER BY last_used_at,id LIMIT LEAST(p_limit,32) FOR UPDATE SKIP LOCKED
  ), candidates AS MATERIALIZED (
    SELECT i.root_id,i.kind,i.row_id FROM roots r CROSS JOIN LATERAL (
      SELECT root_id,kind,row_id FROM durable_capture_fact_identities WHERE root_id=r.id ORDER BY kind,row_id LIMIT p_limit
    ) i LIMIT p_limit
  ) DELETE FROM durable_capture_fact_identities i USING candidates c WHERE i.root_id=c.root_id AND i.kind=c.kind AND i.row_id=c.row_id;
  WITH candidates AS MATERIALIZED (
    SELECT id FROM durable_capture_fact_roots WHERE evicting ORDER BY last_used_at,id LIMIT LEAST(p_limit,32) FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM durable_capture_fact_roots r USING candidates c WHERE r.id=c.id
      AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_pages p WHERE p.root_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_identities i WHERE i.root_id=r.id)
      AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_pins p WHERE p.root_id=r.id)
    RETURNING r.id
  ), revisited AS (
    UPDATE durable_capture_fact_roots r SET last_used_at=now() FROM candidates c WHERE r.id=c.id
      AND NOT EXISTS(SELECT 1 FROM removed d WHERE d.id=r.id)
  ) SELECT count(*)::integer INTO removed_count FROM removed;
  RETURN removed_count;
END;
$$;
CREATE OR REPLACE FUNCTION durable_capture_compact_internal(p_limit integer, force_sweep boolean)
RETURNS TABLE(journal_deleted integer,roots_deleted integer) LANGUAGE plpgsql AS $$
DECLARE candidate record; removed_count integer; deleted_through bigint; safe_through bigint;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'invalid capture collection limit'; END IF;
  PERFORM pg_advisory_xact_lock(904205010001::bigint);
  roots_deleted := durable_capture_evict_roots_internal(p_limit,force_sweep);
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
      next_compaction_at=now()+CASE WHEN removed_count>0 AND deleted_through<safe_through
        THEN INTERVAL '1 second' ELSE INTERVAL '1 minute' END
      WHERE user_id=candidate.user_id AND day=candidate.day;
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
-- Previous callers intentionally force one bounded page, even before its due
-- time. A direct sweep cannot acquire the outer schedule lock in reverse order.
CREATE OR REPLACE FUNCTION durable_capture_evict_roots(p_limit integer)
RETURNS integer LANGUAGE sql AS $$
  SELECT durable_capture_evict_roots_internal(p_limit,true);
$$;
CREATE OR REPLACE FUNCTION durable_capture_compact(p_limit integer DEFAULT 1000)
RETURNS TABLE(journal_deleted integer,roots_deleted integer) LANGUAGE sql AS $$
  SELECT * FROM durable_capture_compact_internal(p_limit,true);
$$;

CREATE OR REPLACE FUNCTION durable_capture_compact_if_due(p_limit integer DEFAULT 128)
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

  SELECT * INTO work FROM durable_capture_compact_internal(p_limit,false);
  journal_deleted := work.journal_deleted; roots_deleted := work.roots_deleted; ran := true;
  -- One post-compaction instant keeps the existing deadline semantics while
  -- comparing only the earliest indexed head in each eligibility class.
  -- MIN stays bounded when PL/pgSQL chooses a generic plan; a parameterized
  -- range EXISTS may otherwise scan every recent head.
  deadline := clock_timestamp();
  more_work := journal_deleted >= p_limit OR roots_deleted >= LEAST(p_limit,32)
    OR EXISTS (SELECT 1 FROM durable_capture_fact_roots WHERE evicting)
    OR COALESCE((SELECT min(next_compaction_at) FROM durable_capture_fact_heads
      WHERE revision>compacted_revision)<=deadline,false)
    OR COALESCE((SELECT min(updated_at) FROM durable_capture_fact_heads
      WHERE revision=compacted_revision)<deadline-interval '30 days',false);
  deadline := clock_timestamp();
  UPDATE durable_capture_compaction_schedule schedule
    SET next_due_at=LEAST(deadline+CASE WHEN more_work THEN interval '1 second' ELSE interval '1 minute' END,
          (SELECT sweep.next_due_at FROM durable_capture_root_sweep sweep WHERE sweep.singleton)),
        last_completed_at=deadline
    WHERE schedule.singleton RETURNING schedule.next_due_at INTO next_due_at;
  RETURN NEXT;
END;
$$;

COMMIT;
