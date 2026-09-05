-- Additive source history. Old and new application writers are covered by
-- triggers; existing rows are revision-zero facts and need no eager backfill.
CREATE TABLE durable_capture_fact_heads (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  compacted_revision bigint NOT NULL DEFAULT 0,
  next_compaction_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, day)
);
CREATE INDEX durable_capture_fact_heads_compaction ON durable_capture_fact_heads(next_compaction_at,user_id,day)
  WHERE revision>compacted_revision;
CREATE INDEX durable_capture_fact_heads_retirement ON durable_capture_fact_heads(updated_at,user_id,day)
  WHERE revision=compacted_revision;
CREATE TABLE durable_capture_fact_journal (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  revision bigint NOT NULL,
  kind text NOT NULL CHECK (kind IN ('sample', 'daily')),
  row_id text NOT NULL,
  before_fact jsonb,
  after_fact jsonb,
  PRIMARY KEY(user_id, day, revision)
);
CREATE TABLE durable_capture_fact_roots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  facts jsonb,
  digest text,
  source_sample_rows integer NOT NULL DEFAULT 0,
  source_daily_rows integer NOT NULL DEFAULT 0,
  journal_rows integer NOT NULL DEFAULT 0,
  prepared_at timestamptz,
  last_used_at timestamptz NOT NULL DEFAULT now(),
  retention_expires_at timestamptz NOT NULL DEFAULT now()+INTERVAL '30 days',
  UNIQUE(user_id, day, revision)
);
CREATE INDEX durable_capture_fact_roots_unprepared ON durable_capture_fact_roots(user_id,day,revision) WHERE prepared_at IS NULL;
CREATE INDEX durable_capture_fact_roots_collection ON durable_capture_fact_roots(last_used_at,id);
CREATE TABLE durable_capture_fact_pins (
  owner_id uuid NOT NULL,
  root_id uuid NOT NULL REFERENCES durable_capture_fact_roots(id) ON DELETE CASCADE,
  PRIMARY KEY(owner_id,root_id)
);
CREATE INDEX durable_capture_fact_pins_root ON durable_capture_fact_pins(root_id);

-- Ordinary source samples overlap at most 32 day chunks. Very long legacy
-- samples have one dedicated per-user sentinel chunk, always included in pins.
-- Store full precision without dividing/prorating steps across days.
CREATE FUNCTION durable_capture_fact_days(p_kind text, p_fact jsonb)
RETURNS TABLE(day date) LANGUAGE sql IMMUTABLE AS $$
  SELECT (p_fact->>'date')::date WHERE p_kind='daily' AND p_fact IS NOT NULL
  UNION ALL
  SELECT DATE '0001-01-01' WHERE p_kind='sample' AND p_fact IS NOT NULL
    AND (p_fact->>'periodEnd')::timestamp::date - (p_fact->>'periodStart')::timestamp::date >= 32
  UNION ALL
  SELECT d::date FROM generate_series(
    (p_fact->>'periodStart')::timestamp::date::timestamp,
    ((p_fact->>'periodEnd')::timestamp - INTERVAL '1 microsecond')::date::timestamp,
    INTERVAL '1 day') d
  WHERE p_kind='sample' AND p_fact IS NOT NULL
    AND (p_fact->>'periodEnd')::timestamp::date - (p_fact->>'periodStart')::timestamp::date < 32;
$$;

CREATE FUNCTION durable_capture_journal_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  before_value jsonb;
  after_value jsonb;
  fact_kind text;
  member record;
  next_revision bigint;
BEGIN
  fact_kind := CASE WHEN TG_TABLE_NAME='steps' THEN 'daily' ELSE 'sample' END;
  IF fact_kind='sample' THEN
    IF TG_OP <> 'INSERT' THEN before_value := jsonb_build_object('rowId',OLD.id,'userId',OLD.user_id,
      'periodStart',to_char(OLD.period_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'periodEnd',to_char(OLD.period_end,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'steps',OLD.steps); END IF;
    IF TG_OP <> 'DELETE' THEN after_value := jsonb_build_object('rowId',NEW.id,'userId',NEW.user_id,
      'periodStart',to_char(NEW.period_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'periodEnd',to_char(NEW.period_end,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'steps',NEW.steps); END IF;
  ELSE
    IF TG_OP <> 'INSERT' THEN before_value := jsonb_build_object('rowId',OLD.id,'userId',OLD.user_id,
      'date',to_char(OLD.date,'YYYY-MM-DD"T"00:00:00.000"Z"'),'steps',OLD.steps); END IF;
    IF TG_OP <> 'DELETE' THEN after_value := jsonb_build_object('rowId',NEW.id,'userId',NEW.user_id,
      'date',to_char(NEW.date,'YYYY-MM-DD"T"00:00:00.000"Z"'),'steps',NEW.steps); END IF;
  END IF;
  IF before_value IS NOT DISTINCT FROM after_value THEN RETURN NULL; END IF;
  -- Globally consistent row order also covers moves between users/days.
  FOR member IN
    SELECT COALESCE(b.user_id,a.user_id) AS user_id,COALESCE(b.day,a.day) AS day,
      b.user_id IS NOT NULL AS had_before,a.user_id IS NOT NULL AS has_after
    FROM (SELECT before_value->>'userId' user_id, day FROM durable_capture_fact_days(fact_kind,before_value)) b
    FULL JOIN (SELECT after_value->>'userId' user_id, day FROM durable_capture_fact_days(fact_kind,after_value)) a USING(user_id,day)
    ORDER BY user_id,day
  LOOP
    INSERT INTO durable_capture_fact_heads(user_id,day,revision) VALUES(member.user_id,member.day,1)
      ON CONFLICT(user_id,day) DO UPDATE SET revision=durable_capture_fact_heads.revision+1,updated_at=now(),
        next_compaction_at=LEAST(durable_capture_fact_heads.next_compaction_at,now())
      RETURNING revision INTO next_revision;
    INSERT INTO durable_capture_fact_journal(user_id,day,revision,kind,row_id,before_fact,after_fact)
      VALUES(member.user_id,member.day,next_revision,fact_kind,COALESCE(after_value,before_value)->>'rowId',
        CASE WHEN member.had_before THEN before_value END,CASE WHEN member.has_after THEN after_value END);
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER durable_capture_steps_source AFTER INSERT OR UPDATE OR DELETE ON steps
  FOR EACH ROW EXECUTE FUNCTION durable_capture_journal_source();
CREATE TRIGGER durable_capture_samples_source AFTER INSERT OR UPDATE OR DELETE ON step_samples
  FOR EACH ROW EXECUTE FUNCTION durable_capture_journal_source();

CREATE FUNCTION durable_capture_pin_roots(p_owner uuid,p_requests jsonb)
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
      WHERE r.user_id=s.uid AND r.day=s.date AND r.revision=s.rev)
    ORDER BY s.uid,s.date,s.rev ON CONFLICT(user_id,day,revision) DO NOTHING;
  RETURN QUERY
  WITH selected AS MATERIALIZED (
    SELECT s.owner,r.id,r.user_id AS uid,r.day AS date,r.revision AS rev
    FROM jsonb_to_recordset(pinned_requests) AS s(uid text,date date,rev bigint,owner uuid)
    JOIN durable_capture_fact_roots r ON r.user_id=s.uid AND r.day=s.date AND r.revision=s.rev
  ), pins AS (
    INSERT INTO durable_capture_fact_pins(owner_id,root_id)
      SELECT s.owner,s.id FROM selected s
      ON CONFLICT DO NOTHING
  ) SELECT s.id,s.uid,s.date::text,s.rev,s.owner FROM selected s ORDER BY s.owner,s.uid,s.date;
END;
$$;

CREATE FUNCTION durable_capture_prepare_root(p_root uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE root durable_capture_fact_roots%ROWTYPE;
BEGIN
  -- The row lock coalesces independent workers. Preparation and inverse replay
  -- share ONE SQL snapshot below; a later upload cannot leak into an old pin.
  SELECT * INTO STRICT root FROM durable_capture_fact_roots WHERE id=p_root FOR NO KEY UPDATE;
  IF root.prepared_at IS NOT NULL THEN RETURN root.facts; END IF;
  WITH current_facts AS MATERIALIZED (
    SELECT 'sample'::text AS kind,s.id AS row_id,jsonb_build_object('rowId',s.id,'userId',s.user_id,
      'periodStart',to_char(s.period_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'periodEnd',to_char(s.period_end,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'steps',s.steps) AS fact
    FROM step_samples s WHERE s.user_id=root.user_id AND (
      (root.day=DATE '0001-01-01' AND s.period_end::date-s.period_start::date>=32) OR
      (root.day<>DATE '0001-01-01' AND s.period_start < root.day+INTERVAL '1 day'
        AND s.period_end > root.day::timestamp AND s.period_start >= root.day-INTERVAL '32 days'
        AND s.period_end::date-s.period_start::date<32))
    UNION ALL
    SELECT 'daily',d.id,jsonb_build_object('rowId',d.id,'userId',d.user_id,
      'date',to_char(d.date,'YYYY-MM-DD"T"00:00:00.000"Z"'),'steps',d.steps)
    FROM steps d WHERE d.user_id=root.user_id AND d.date=root.day AND root.day<>DATE '0001-01-01'
  ), later_changes AS MATERIALIZED (
    SELECT j.* FROM durable_capture_fact_journal j WHERE j.user_id=root.user_id AND j.day=root.day AND j.revision>root.revision
  ), earliest_preimage AS MATERIALIZED (
    SELECT DISTINCT ON(kind,row_id) kind,row_id,before_fact AS fact FROM later_changes ORDER BY kind,row_id,revision
  ), pinned_facts AS (
    SELECT c.* FROM current_facts c WHERE NOT EXISTS(SELECT 1 FROM earliest_preimage p WHERE p.kind=c.kind AND p.row_id=c.row_id)
    UNION ALL SELECT * FROM earliest_preimage WHERE fact IS NOT NULL
  ), result AS (
    SELECT jsonb_build_object(
      'samples',COALESCE(jsonb_agg(fact ORDER BY fact->>'periodStart',row_id) FILTER(WHERE kind='sample'),'[]'::jsonb),
      'dailySteps',COALESCE(jsonb_agg(fact ORDER BY fact->>'date',row_id) FILTER(WHERE kind='daily'),'[]'::jsonb)) AS facts FROM pinned_facts
  ) UPDATE durable_capture_fact_roots r SET facts=v.facts,digest=md5(v.facts::text),prepared_at=now(),
      source_sample_rows=(SELECT count(*) FROM current_facts WHERE kind='sample'),
      source_daily_rows=(SELECT count(*) FROM current_facts WHERE kind='daily'),journal_rows=(SELECT count(*) FROM later_changes)
    FROM result v WHERE r.id=p_root RETURNING r.* INTO root;
  RETURN root.facts;
END;
$$;

-- Return physical work performed by this invocation, not historical stored
-- counters from another worker that won the row lock first.
CREATE FUNCTION durable_capture_materialize_root(p_root uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE root durable_capture_fact_roots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT root FROM durable_capture_fact_roots WHERE id=p_root FOR NO KEY UPDATE;
  IF root.prepared_at IS NOT NULL THEN
    RETURN jsonb_build_object('prepared',0,'sourceSampleRows',0,'sourceDailyRows',0,'journalRows',0);
  END IF;
  PERFORM durable_capture_prepare_root(p_root);
  SELECT * INTO STRICT root FROM durable_capture_fact_roots WHERE id=p_root;
  RETURN jsonb_build_object('prepared',1,'sourceSampleRows',root.source_sample_rows,
    'sourceDailyRows',root.source_daily_rows,'journalRows',root.journal_rows);
END;
$$;

-- Bounded journal retention. A pinned unprepared root is a reconstruction
-- watermark; prepared roots already own the exact preimages they require.
-- Lock prevents concurrent new pins seeing a root whose inverse history was
-- just collected. Source triggers need no global lock and remain concurrent.
CREATE FUNCTION durable_capture_compact(p_limit integer DEFAULT 1000)
RETURNS TABLE(journal_deleted integer,roots_deleted integer) LANGUAGE plpgsql AS $$
DECLARE candidate record; removed_count integer; deleted_through bigint; safe_through bigint;
BEGIN
  IF p_limit < 1 OR p_limit > 10000 THEN RAISE EXCEPTION 'invalid capture collection limit'; END IF;
  PERFORM pg_advisory_xact_lock(904205010001::bigint);
  WITH candidates AS MATERIALIZED (
    SELECT r.id FROM durable_capture_fact_roots r WHERE r.last_used_at<now()-INTERVAL '10 minutes'
    ORDER BY r.last_used_at,r.id LIMIT p_limit FOR UPDATE SKIP LOCKED
  ), removed AS (DELETE FROM durable_capture_fact_roots r USING candidates c WHERE r.id=c.id
    AND (r.retention_expires_at<now() OR r.revision<COALESCE(
      (SELECT h.revision FROM durable_capture_fact_heads h WHERE h.user_id=r.user_id AND h.day=r.day),0))
    AND NOT EXISTS(SELECT 1 FROM durable_capture_fact_pins p WHERE p.root_id=r.id) RETURNING r.id
  ), revisited AS (
    UPDATE durable_capture_fact_roots r SET last_used_at=now() FROM candidates c WHERE r.id=c.id
      AND NOT EXISTS(SELECT 1 FROM removed d WHERE d.id=r.id)
  )
  SELECT count(*)::integer INTO roots_deleted FROM removed;
  journal_deleted := 0;
  -- Examine at most 32 indexed day heads, then at most p_limit journal rows.
  -- A blocked old pin cannot force a lifetime journal scan or starve others.
  FOR candidate IN SELECT * FROM durable_capture_fact_heads
    WHERE revision>compacted_revision AND next_compaction_at<=now()
    ORDER BY next_compaction_at,user_id,day LIMIT 32 FOR UPDATE SKIP LOCKED
  LOOP
    SELECT COALESCE(min(r.revision),candidate.revision) INTO safe_through FROM durable_capture_fact_roots r
      WHERE r.user_id=candidate.user_id AND r.day=candidate.day AND r.prepared_at IS NULL;
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
