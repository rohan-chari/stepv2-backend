ALTER TABLE durable_capture_fact_roots
  ADD COLUMN preparation_phase text NOT NULL DEFAULT 'DAILY',
  ADD COLUMN source_cursor timestamp,
  ADD COLUMN journal_cursor bigint NOT NULL DEFAULT 0,
  ADD COLUMN journal_ceiling bigint,
  ADD COLUMN page_count integer NOT NULL DEFAULT 0,
  ADD COLUMN row_count integer NOT NULL DEFAULT 0,
  ADD COLUMN initial_digest text;
CREATE INDEX durable_capture_fact_journal_identity ON durable_capture_fact_journal(user_id,day,kind,row_id,revision);
CREATE TABLE durable_capture_fact_identities (
  root_id uuid NOT NULL REFERENCES durable_capture_fact_roots(id) ON DELETE CASCADE,
  kind text NOT NULL,
  row_id text NOT NULL,
  PRIMARY KEY(root_id,kind,row_id)
);
CREATE TABLE durable_capture_fact_pages (
  root_id uuid NOT NULL REFERENCES durable_capture_fact_roots(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  rows jsonb NOT NULL,
  row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 256),
  digest text NOT NULL,
  prior_digest text NOT NULL,
  cumulative_digest text NOT NULL,
  PRIMARY KEY(root_id,page_number)
);

-- Internal bounded append; the caller owns the root's NO KEY UPDATE lock.
CREATE FUNCTION durable_capture_append_fact_page(p_root uuid,p_rows jsonb) RETURNS void LANGUAGE plpgsql AS $$
DECLARE root durable_capture_fact_roots%ROWTYPE; payload jsonb; count_rows integer; page_digest text; chain_digest text;
BEGIN
  IF jsonb_array_length(COALESCE(p_rows,'[]'::jsonb))>256 THEN RAISE EXCEPTION 'capture page exceeds row budget'; END IF;
  WITH input AS MATERIALIZED (
    SELECT DISTINCT ON(x.kind,x."rowId") x.kind,x."rowId",x.fact
    FROM jsonb_to_recordset(COALESCE(p_rows,'[]'::jsonb)) x(kind text,"rowId" text,fact jsonb)
    WHERE x.fact IS NOT NULL ORDER BY x.kind,x."rowId"
  ), added AS (
    INSERT INTO durable_capture_fact_identities(root_id,kind,row_id)
      SELECT p_root,i.kind,i."rowId" FROM input i ON CONFLICT DO NOTHING RETURNING kind,row_id
  ) SELECT jsonb_agg(jsonb_build_object('kind',i.kind,'rowId',i."rowId",'fact',i.fact) ORDER BY i.kind,i."rowId"),count(*)::integer
    INTO payload,count_rows FROM input i JOIN added a ON a.kind=i.kind AND a.row_id=i."rowId";
  IF count_rows=0 THEN RETURN; END IF;
  IF octet_length(payload::text)>262144 THEN RAISE EXCEPTION 'capture page exceeds byte budget'; END IF;
  SELECT * INTO STRICT root FROM durable_capture_fact_roots WHERE id=p_root;
  page_digest := encode(digest(payload::text,'sha256'),'hex');
  chain_digest := encode(digest(root.digest||'|'||page_digest||'|'||(root.page_count+1)::text,'sha256'),'hex');
  INSERT INTO durable_capture_fact_pages(root_id,page_number,rows,row_count,digest,prior_digest,cumulative_digest)
    VALUES(p_root,root.page_count+1,payload,count_rows,page_digest,root.digest,chain_digest);
  UPDATE durable_capture_fact_roots SET page_count=page_count+1,row_count=row_count+count_rows,digest=chain_digest WHERE id=p_root;
END;
$$;

DROP FUNCTION durable_capture_materialize_root(uuid);
DROP FUNCTION durable_capture_prepare_root(uuid);

-- Each invocation fetches at most 128 physical source/journal candidates and
-- at most one indexed inverse-preimage row per candidate (<=256 total facts).
-- No whole-day JSON aggregation or scan occurs in this production primitive.
CREATE FUNCTION durable_capture_materialize_root(p_root uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  root durable_capture_fact_roots%ROWTYPE;
  payload jsonb;
  candidate_count integer := 0;
  inverse_count integer := 0;
  sample_count integer := 0;
  daily_count integer := 0;
  journal_count integer := 0;
  next_source_cursor timestamp;
  next_journal_cursor bigint;
  ceiling bigint;
  complete integer := 0;
BEGIN
  SELECT * INTO STRICT root FROM durable_capture_fact_roots WHERE id=p_root FOR NO KEY UPDATE;
  IF root.evicting THEN RAISE EXCEPTION 'durable capture root is being evicted'; END IF;
  IF root.prepared_at IS NOT NULL THEN
    RETURN jsonb_build_object('prepared',0,'sourceSampleRows',0,'sourceDailyRows',0,'journalRows',0);
  END IF;
  IF root.initial_digest IS NULL THEN
    UPDATE durable_capture_fact_roots SET initial_digest=encode(digest(user_id||'|'||day::text||'|'||revision::text,'sha256'),'hex'),
      digest=encode(digest(user_id||'|'||day::text||'|'||revision::text,'sha256'),'hex') WHERE id=p_root RETURNING * INTO root;
  END IF;
  IF root.preparation_phase='DAILY' THEN
    WITH current_rows AS MATERIALIZED (
      SELECT d.id,jsonb_build_object('rowId',d.id,'userId',d.user_id,
        'date',to_char(d.date,'YYYY-MM-DD"T"00:00:00.000"Z"'),'steps',d.steps) AS fact
      FROM steps d WHERE d.user_id=root.user_id AND d.date=root.day AND root.day<>DATE '0001-01-01'
    ), restored AS (
      SELECT c.id,CASE WHEN j.revision IS NULL THEN c.fact ELSE j.before_fact END AS fact,j.revision
      FROM current_rows c LEFT JOIN LATERAL (
        SELECT revision,before_fact FROM durable_capture_fact_journal
        WHERE user_id=root.user_id AND day=root.day AND kind='daily' AND row_id=c.id AND revision>root.revision
        ORDER BY revision LIMIT 1
      ) j ON true
    ) SELECT jsonb_agg(jsonb_build_object('kind','daily','rowId',id,'fact',fact)) FILTER(WHERE fact IS NOT NULL),
      count(*)::integer,count(revision)::integer INTO payload,daily_count,inverse_count FROM restored;
    PERFORM durable_capture_append_fact_page(p_root,payload);
    UPDATE durable_capture_fact_roots SET preparation_phase='CURRENT',source_daily_rows=source_daily_rows+daily_count,
      journal_rows=journal_rows+inverse_count WHERE id=p_root;
  ELSIF root.preparation_phase='CURRENT' THEN
    WITH current_rows AS MATERIALIZED (
      (SELECT s.id,s.user_id,s.period_start,s.period_end,s.steps FROM step_samples s WHERE root.day<>DATE '0001-01-01' AND s.user_id=root.user_id
        AND s.period_start>=GREATEST(root.day-INTERVAL '32 days',COALESCE(root.source_cursor+INTERVAL '1 microsecond',root.day-INTERVAL '32 days'))
        AND s.period_start<root.day+INTERVAL '1 day' ORDER BY s.period_start LIMIT 128)
      UNION ALL
      (SELECT s.id,s.user_id,s.period_start,s.period_end,s.steps FROM step_samples s WHERE root.day=DATE '0001-01-01' AND s.user_id=root.user_id
        AND s.period_end::date-s.period_start::date>=32
        AND s.period_start>=COALESCE(root.source_cursor+INTERVAL '1 microsecond','-infinity'::timestamp)
        ORDER BY s.period_start LIMIT 128)
    ), restored AS (
      SELECT c.id,c.period_start,j.revision,
        CASE WHEN j.revision IS NOT NULL THEN j.before_fact
          WHEN (root.day=DATE '0001-01-01') OR
            (c.period_end>root.day::timestamp AND c.period_end::date-c.period_start::date<32)
          THEN jsonb_build_object('rowId',c.id,'userId',c.user_id,
            'periodStart',to_char(c.period_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'periodEnd',to_char(c.period_end,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'steps',c.steps)
        END AS fact
      FROM current_rows c LEFT JOIN LATERAL (
        SELECT revision,before_fact FROM durable_capture_fact_journal
        WHERE user_id=root.user_id AND day=root.day AND kind='sample' AND row_id=c.id AND revision>root.revision
        ORDER BY revision LIMIT 1
      ) j ON true
    ) SELECT jsonb_agg(jsonb_build_object('kind','sample','rowId',id,'fact',fact)) FILTER(WHERE fact IS NOT NULL),
      count(*)::integer,count(revision)::integer,max(period_start),
      COALESCE((SELECT h.revision FROM durable_capture_fact_heads h WHERE h.user_id=root.user_id AND h.day=root.day),0)
      INTO payload,sample_count,inverse_count,next_source_cursor,ceiling FROM restored;
    PERFORM durable_capture_append_fact_page(p_root,payload);
    -- H shares the exact statement snapshot that establishes source exhaustion.
    UPDATE durable_capture_fact_roots SET source_cursor=COALESCE(next_source_cursor,source_cursor),
      source_sample_rows=source_sample_rows+sample_count,journal_rows=journal_rows+inverse_count,
      preparation_phase=CASE WHEN sample_count<128 THEN 'JOURNAL' ELSE 'CURRENT' END,
      journal_ceiling=CASE WHEN sample_count<128 THEN ceiling ELSE NULL END WHERE id=p_root;
  ELSIF root.preparation_phase='JOURNAL' THEN
    WITH mutations AS MATERIALIZED (
      SELECT j.kind,j.row_id,j.revision FROM durable_capture_fact_journal j
      WHERE j.user_id=root.user_id AND j.day=root.day AND j.revision>GREATEST(root.revision,root.journal_cursor)
        AND j.revision<=root.journal_ceiling ORDER BY j.revision LIMIT 128
    ), restored AS (
      SELECT m.kind,m.row_id,m.revision,j.before_fact AS fact FROM mutations m
      JOIN LATERAL (
        SELECT before_fact FROM durable_capture_fact_journal
        WHERE user_id=root.user_id AND day=root.day AND kind=m.kind AND row_id=m.row_id AND revision>root.revision
        ORDER BY revision LIMIT 1
      ) j ON true
    ) SELECT jsonb_agg(jsonb_build_object('kind',kind,'rowId',row_id,'fact',fact)) FILTER(WHERE fact IS NOT NULL),
      count(*)::integer,max(revision) INTO payload,candidate_count,next_journal_cursor FROM restored;
    PERFORM durable_capture_append_fact_page(p_root,payload);
    journal_count := candidate_count*2;
    complete := CASE WHEN candidate_count<128 THEN 1 ELSE 0 END;
    UPDATE durable_capture_fact_roots SET journal_cursor=COALESCE(next_journal_cursor,journal_cursor),
      journal_rows=journal_rows+journal_count,
      preparation_phase=CASE WHEN complete=1 THEN 'DONE' ELSE 'JOURNAL' END,
      prepared_at=CASE WHEN complete=1 THEN now() ELSE NULL END WHERE id=p_root;
  ELSE RAISE EXCEPTION 'invalid durable capture preparation phase';
  END IF;
  RETURN jsonb_build_object('prepared',complete,'sourceSampleRows',sample_count,
    'sourceDailyRows',daily_count,'journalRows',journal_count+inverse_count);
END;
$$;
