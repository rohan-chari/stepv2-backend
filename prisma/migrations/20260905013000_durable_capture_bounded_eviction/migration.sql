ALTER TABLE durable_capture_fact_roots ADD COLUMN evicting boolean NOT NULL DEFAULT false;
ALTER TABLE durable_capture_fact_roots DROP CONSTRAINT durable_capture_fact_roots_user_id_day_revision_key;
CREATE UNIQUE INDEX durable_capture_fact_roots_live_version ON durable_capture_fact_roots(user_id,day,revision) WHERE NOT evicting;
CREATE INDEX durable_capture_fact_roots_eviction ON durable_capture_fact_roots(last_used_at,id) WHERE evicting;

-- Marking eviction is fenced against intake pins. Once marked, identity can
-- never be pinned again; a future caller creates a fresh live same-version root.
-- Child deletion is independently bounded; root DELETE never cascades a large
-- page population or identity ledger.
CREATE FUNCTION durable_capture_evict_roots(p_limit integer) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE removed_count integer;
BEGIN
  IF p_limit<1 OR p_limit>10000 THEN RAISE EXCEPTION 'invalid capture eviction limit'; END IF;
  PERFORM pg_advisory_xact_lock(904205010001::bigint);
  WITH candidates AS MATERIALIZED (
    SELECT r.id FROM durable_capture_fact_roots r WHERE NOT r.evicting AND r.last_used_at<now()-INTERVAL '10 minutes'
    ORDER BY r.last_used_at,r.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ) UPDATE durable_capture_fact_roots r SET last_used_at=now(),
      evicting=(r.retention_expires_at<now() OR r.revision<COALESCE(
        (SELECT h.revision FROM durable_capture_fact_heads h WHERE h.user_id=r.user_id AND h.day=r.day),0))
        AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_pins p WHERE p.root_id=r.id)
    FROM candidates c WHERE r.id=c.id;
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
CREATE OR REPLACE FUNCTION durable_capture_pin_roots(p_owner uuid,p_requests jsonb)
RETURNS TABLE(root_id uuid,user_id text,day text,revision bigint,owner_id uuid) LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE pinned_requests jsonb;
BEGIN
  -- Excludes journal collection until the pin transaction commits. All roots
  -- below are chosen by one MVCC statement, including missing revision zero.
  PERFORM pg_advisory_xact_lock_shared(904205010001::bigint);
  WITH wanted AS MATERIALIZED (
    SELECT DISTINCT x."userId" AS uid,x.day::date AS date,COALESCE(x."ownerId"::uuid,p_owner) AS owner
    FROM jsonb_to_recordset(p_requests) AS x("userId" text,day text,"ownerId" text)
  ) SELECT jsonb_agg(jsonb_build_object('uid',w.uid,'date',w.date,'rev',COALESCE(h.revision,0),'owner',w.owner))
    INTO pinned_requests FROM wanted w
    LEFT JOIN durable_capture_fact_heads h ON h.user_id=w.uid AND h.day=w.date
  ;
  -- Never UPDATE an existing immutable identity in the intake transaction:
  -- that would serialize all uploaders sharing historical roots. A concurrent
  -- first creator can win INSERT; after its commit, resolve the SAME saved
  -- revision vector in a fresh statement, never reread mutable heads.
  INSERT INTO durable_capture_fact_roots(user_id,day,revision)
    SELECT DISTINCT s.uid,s.date,s.rev
    FROM jsonb_to_recordset(pinned_requests) AS s(uid text,date date,rev bigint,owner uuid)
    WHERE NOT EXISTS(SELECT 1 FROM durable_capture_fact_roots r
      WHERE r.user_id=s.uid AND r.day=s.date AND r.revision=s.rev AND NOT r.evicting)
    ORDER BY s.uid,s.date,s.rev ON CONFLICT(user_id,day,revision) WHERE NOT evicting DO NOTHING;
  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT s.owner,r.id,r.user_id AS uid,r.day AS date,r.revision AS rev
    FROM jsonb_to_recordset(pinned_requests) AS s(uid text,date date,rev bigint,owner uuid)
    JOIN durable_capture_fact_roots r ON r.user_id=s.uid AND r.day=s.date AND r.revision=s.rev AND NOT r.evicting
  ), pins AS (
    INSERT INTO durable_capture_fact_pins(owner_id,root_id)
      SELECT s.owner,s.id FROM selected s
      ON CONFLICT DO NOTHING
  ) SELECT s.id,s.uid,s.date::text,s.rev,s.owner FROM selected s ORDER BY s.owner,s.uid,s.date;
END;
$$;

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
