-- Permanent outstanding-work index. All writers (including the old binary)
-- maintain it transactionally; existing populations are seeded in small pages.
CREATE TABLE global_event_recovery_candidates (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('SUMMARY_V1','SUMMARY_V2','ENTITLEMENT_EVENT')),
  -- Non-authoritative hints deliberately have no parent FK locks: a status
  -- update must not acquire a new parent lock after locking its source row.
  event_id text NOT NULL,
  user_id text NOT NULL,
  source_id text NOT NULL,
  available_at timestamp NOT NULL,
  completion_key text NOT NULL
);
CREATE INDEX global_event_recovery_due_idx
  ON global_event_recovery_candidates(kind,available_at,event_id,user_id,id);
CREATE INDEX global_event_recovery_completion_idx ON global_event_recovery_candidates(completion_key);
CREATE INDEX global_event_recovery_event_idx ON global_event_recovery_candidates(event_id);
CREATE INDEX global_event_recovery_user_idx ON global_event_recovery_candidates(user_id);

CREATE TABLE global_event_recovery_seed (
  source text PRIMARY KEY CHECK (source IN ('entitlements','impacts')),
  last_id text NOT NULL DEFAULT '', complete boolean NOT NULL DEFAULT false
);
CREATE TABLE global_event_recovery_event_refresh (
  event_id text PRIMARY KEY REFERENCES global_step_events(id) ON DELETE CASCADE,
  last_entitlement_id text NOT NULL DEFAULT '', last_impact_id text NOT NULL DEFAULT '',
  entitlements_complete boolean NOT NULL DEFAULT false,
  impacts_complete boolean NOT NULL DEFAULT false,
  requested_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX global_event_recovery_refresh_due_idx ON global_event_recovery_event_refresh(requested_at,event_id);
CREATE TABLE global_event_recovery_orphan_cursor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), last_id bigint NOT NULL DEFAULT 0,
  through_id bigint
);

CREATE FUNCTION global_event_recovery_parent_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='users' THEN
    DELETE FROM global_event_recovery_candidates WHERE user_id=OLD.id;
  ELSE
    DELETE FROM global_event_recovery_candidates WHERE event_id=OLD.id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER global_event_recovery_user_deleted AFTER DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_parent_deleted();
CREATE TRIGGER global_event_recovery_event_deleted AFTER DELETE ON global_step_events
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_parent_deleted();

-- Covers a bootstrap/read racing with parent deletion AFTER its delete trigger
-- ran. This walks only bounded outstanding hints, never historical sources.
CREATE FUNCTION global_event_recovery_cleanup_orphans(p_limit integer DEFAULT 128) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE cursor_id bigint; sweep_end bigint; selected_ids bigint[];
BEGIN
  IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'invalid recovery page size'; END IF;
  INSERT INTO global_event_recovery_orphan_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING;
  SELECT last_id,through_id INTO cursor_id,sweep_end FROM global_event_recovery_orphan_cursor FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN 0; END IF;
  IF sweep_end IS NULL THEN SELECT COALESCE(max(id),0) INTO sweep_end FROM global_event_recovery_candidates; END IF;
  SELECT array_agg(id ORDER BY id) INTO selected_ids FROM (
    SELECT id FROM global_event_recovery_candidates WHERE id>cursor_id AND id<=sweep_end ORDER BY id LIMIT p_limit
  ) page;
  DELETE FROM global_event_recovery_candidates WHERE id IN (
    SELECT hint.id FROM global_event_recovery_candidates hint WHERE hint.id=ANY(selected_ids)
      AND (NOT EXISTS(SELECT 1 FROM users WHERE id=hint.user_id)
        OR NOT EXISTS(SELECT 1 FROM global_step_events WHERE id=hint.event_id))
    FOR UPDATE OF hint SKIP LOCKED
  );
  -- Fix the high watermark for this finite sweep. Continuous arrivals cannot
  -- prevent wrapping to revisit an earlier skipped lock or late commit.
  IF COALESCE(cardinality(selected_ids),0)<p_limit OR selected_ids[cardinality(selected_ids)]>=sweep_end THEN
    UPDATE global_event_recovery_orphan_cursor SET last_id=0,through_id=NULL;
  ELSE
    UPDATE global_event_recovery_orphan_cursor SET last_id=selected_ids[cardinality(selected_ids)],through_id=sweep_end;
  END IF;
  RETURN COALESCE(cardinality(selected_ids),0);
END;
$$;

CREATE FUNCTION global_event_recovery_refresh(p_event text,p_user text,p_at timestamp DEFAULT CURRENT_TIMESTAMP,
  p_signal_id bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE parent global_step_events%ROWTYPE; entitlement global_step_event_entitlements%ROWTYPE;
  fence text; due timestamp; signal_kind text; retained boolean:=false;
BEGIN
  -- Source triggers append independent signal IDs, never taking a pair lock.
  -- Maintenance owns ONLY an observed signal; concurrently appended signals
  -- survive. No caller may write source facts after a maintenance refresh.
  IF p_signal_id IS NOT NULL THEN
    SELECT kind INTO signal_kind FROM global_event_recovery_candidates
      WHERE id=p_signal_id AND event_id=p_event AND user_id=p_user FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;
  SELECT * INTO parent FROM global_step_events WHERE id=p_event;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_user) THEN
    IF p_signal_id IS NOT NULL THEN DELETE FROM global_event_recovery_candidates WHERE id=p_signal_id; END IF;
    RETURN;
  END IF;
  SELECT * INTO entitlement FROM global_step_event_entitlements WHERE event_id=p_event AND user_id=p_user;

  IF (signal_kind IS NULL OR signal_kind='SUMMARY_V2') AND parent.summary_attribution_version=2 AND NOT EXISTS (
    SELECT 1 FROM global_event_summary_work WHERE event_id=p_event AND user_id=p_user
  ) THEN
    due := CASE WHEN entitlement.id IS NOT NULL THEN entitlement.ends_at
      WHEN parent.schedule_mode='LEGACY_GLOBAL' AND EXISTS (
        SELECT 1 FROM global_event_race_impacts WHERE event_id=p_event AND user_id=p_user
      ) THEN parent.ends_at END;
    IF due IS NOT NULL THEN
      fence:='summary-v2:' || p_event || ':' || p_user;
      IF p_signal_id IS NULL THEN
        INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key) VALUES
          ('SUMMARY_V2',p_event,p_user,COALESCE(entitlement.id,p_event),due,fence);
      ELSE
        UPDATE global_event_recovery_candidates SET source_id=COALESCE(entitlement.id,p_event),available_at=due,completion_key=fence
          WHERE id=p_signal_id;
        retained:=true;
      END IF;
    END IF;
  END IF;

  fence := 'global_event_summary:' || p_event || ':' || p_user || ':v1';
  IF (signal_kind IS NULL OR signal_kind='SUMMARY_V1') AND parent.summary_attribution_version=1
    AND NOT EXISTS (SELECT 1 FROM job_runs WHERE job_name=fence)
    AND (p_signal_id IS NULL OR (
      EXISTS (SELECT 1 FROM global_event_race_impacts WHERE event_id=p_event AND user_id=p_user AND attribution_version=1)
      AND NOT EXISTS (SELECT 1 FROM global_event_race_impacts WHERE event_id=p_event AND user_id=p_user AND attribution_version=1 AND status<>'FINAL')
    ))
  THEN
    due := CASE WHEN parent.schedule_mode='LEGACY_GLOBAL' THEN parent.ends_at
      WHEN parent.schedule_mode='LOCAL_ENTITLEMENTS' AND (p_signal_id IS NULL OR entitlement.start_outcome<>'PENDING') THEN entitlement.ends_at END;
    IF due IS NOT NULL THEN
      IF p_signal_id IS NULL THEN
        INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key)
          VALUES ('SUMMARY_V1',p_event,p_user,p_event,due,fence);
      ELSE
        UPDATE global_event_recovery_candidates SET available_at=due,completion_key=fence WHERE id=p_signal_id;
        retained:=true;
      END IF;
    END IF;
  END IF;

  IF (signal_kind IS NULL OR signal_kind='ENTITLEMENT_EVENT') AND entitlement.id IS NOT NULL AND entitlement.ends_at>p_at THEN
    fence := 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:' || entitlement.id || ':' || entitlement.schedule_revision::text;
    IF NOT EXISTS (SELECT 1 FROM domain_event_outbox WHERE event_key=fence)
      AND NOT EXISTS (SELECT 1 FROM domain_event_receipts WHERE event_key=fence AND terminal_status IS NOT NULL)
    THEN
      IF p_signal_id IS NULL THEN
        INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key) VALUES
          ('ENTITLEMENT_EVENT',p_event,p_user,entitlement.id,entitlement.created_at,fence);
      ELSE
        UPDATE global_event_recovery_candidates SET source_id=entitlement.id,available_at=entitlement.created_at,completion_key=fence
          WHERE id=p_signal_id;
        retained:=true;
      END IF;
    END IF;
  END IF;
  IF p_signal_id IS NOT NULL AND NOT retained THEN
    DELETE FROM global_event_recovery_candidates WHERE id=p_signal_id;
  END IF;
END;
$$;

CREATE FUNCTION global_event_recovery_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='global_step_event_entitlements' THEN
      IF (NEW.event_id,NEW.user_id,NEW.ends_at,NEW.start_outcome,NEW.schedule_revision) IS NOT DISTINCT FROM
        (OLD.event_id,OLD.user_id,OLD.ends_at,OLD.start_outcome,OLD.schedule_revision) THEN RETURN NULL; END IF;
    ELSIF TG_TABLE_NAME='global_event_race_impacts' THEN
      IF (NEW.event_id,NEW.user_id,NEW.status,NEW.attribution_version) IS NOT DISTINCT FROM
        (OLD.event_id,OLD.user_id,OLD.status,OLD.attribution_version) THEN RETURN NULL; END IF;
    ELSIF TG_TABLE_NAME='global_event_summary_work' THEN
      IF (NEW.event_id,NEW.user_id) IS NOT DISTINCT FROM (OLD.event_id,OLD.user_id) THEN RETURN NULL; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='global_event_summary_work' AND TG_OP<>'DELETE' THEN
    -- A durable receipt retires every signal covered by that exact receipt.
    DELETE FROM global_event_recovery_candidates
      WHERE completion_key='summary-v2:' || NEW.event_id || ':' || NEW.user_id;
    IF TG_OP='INSERT' THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP<>'INSERT' THEN PERFORM global_event_recovery_refresh(OLD.event_id,OLD.user_id); END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.event_id,NEW.user_id) IS DISTINCT FROM (OLD.event_id,OLD.user_id)) THEN
    PERFORM global_event_recovery_refresh(NEW.event_id,NEW.user_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER global_event_recovery_entitlement_changed AFTER INSERT OR DELETE OR UPDATE OF
  event_id,user_id,ends_at,start_outcome,schedule_revision ON global_step_event_entitlements
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_source_changed();
CREATE TRIGGER global_event_recovery_impact_changed AFTER INSERT OR DELETE OR UPDATE OF
  event_id,user_id,status,attribution_version ON global_event_race_impacts
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_source_changed();
CREATE TRIGGER global_event_recovery_work_changed AFTER INSERT OR DELETE OR UPDATE OF
  event_id,user_id ON global_event_summary_work
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_source_changed();

CREATE FUNCTION global_event_recovery_parent_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.ends_at,NEW.schedule_mode,NEW.summary_attribution_version)
    IS DISTINCT FROM (OLD.ends_at,OLD.schedule_mode,OLD.summary_attribution_version) THEN
    INSERT INTO global_event_recovery_event_refresh(event_id) VALUES (NEW.id)
      ON CONFLICT(event_id) DO UPDATE SET last_entitlement_id='',last_impact_id='',
        entitlements_complete=false,impacts_complete=false,requested_at=clock_timestamp();
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER global_event_recovery_parent_changed AFTER UPDATE OF ends_at,schedule_mode,summary_attribution_version
  ON global_step_events FOR EACH ROW EXECUTE FUNCTION global_event_recovery_parent_changed();

CREATE FUNCTION global_event_recovery_completion_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; key text; aggregate text;
BEGIN
  IF TG_TABLE_NAME='job_runs' THEN
    IF TG_OP<>'DELETE' THEN
      DELETE FROM global_event_recovery_candidates WHERE completion_key=NEW.job_name;
    END IF;
    IF TG_OP<>'INSERT' AND (TG_OP='DELETE' OR OLD.job_name IS DISTINCT FROM NEW.job_name) THEN
      FOR item IN SELECT DISTINCT event_id,user_id FROM global_event_race_impacts
        WHERE attribution_version=1 AND ('global_event_summary:' || event_id || ':' || user_id || ':v1')=OLD.job_name
      LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); END LOOP;
    END IF;
  ELSE
    IF TG_OP='DELETE' THEN key:=OLD.event_key; aggregate:=OLD.aggregate_id;
    ELSE key:=NEW.event_key; aggregate:=NEW.aggregate_id; END IF;
    IF key LIKE 'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:%' THEN
      IF TG_OP<>'DELETE' AND (TG_TABLE_NAME='domain_event_outbox' OR
          to_jsonb(NEW)->>'terminal_status' IS NOT NULL) THEN
        DELETE FROM global_event_recovery_candidates WHERE completion_key=key;
        RETURN NULL;
      END IF;
      FOR item IN SELECT event_id,user_id FROM global_step_event_entitlements WHERE id=aggregate
      LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); END LOOP;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE FUNCTION global_event_recovery_revalidate_page(p_kind text,p_at timestamp,p_limit integer DEFAULT 128)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item record; n integer:=0;
BEGIN
  IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'invalid recovery page size'; END IF;
  FOR item IN SELECT event_id,user_id,array_agg(id ORDER BY id) AS ids FROM (
    SELECT id,event_id,user_id FROM global_event_recovery_candidates
    WHERE kind=p_kind AND available_at<=p_at ORDER BY available_at,event_id,user_id,id LIMIT p_limit
  ) page GROUP BY event_id,user_id ORDER BY event_id,user_id
  LOOP
    PERFORM global_event_recovery_refresh(item.event_id,item.user_id,p_at,item.ids[1]);
    -- Compact ONLY duplicates observed in this bounded page. New signals from
    -- concurrent source commits are different IDs and must survive this pass.
    DELETE FROM global_event_recovery_candidates WHERE id IN (
      SELECT id FROM global_event_recovery_candidates
      WHERE id=ANY(item.ids) AND id<>item.ids[1] FOR UPDATE SKIP LOCKED
    );
    n:=n+cardinality(item.ids);
  END LOOP;
  RETURN n;
END;
$$;
CREATE TRIGGER global_event_recovery_job_changed AFTER INSERT OR DELETE OR UPDATE OF job_name ON job_runs
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_completion_changed();
CREATE TRIGGER global_event_recovery_outbox_changed AFTER INSERT OR DELETE ON domain_event_outbox
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_completion_changed();
CREATE TRIGGER global_event_recovery_receipt_changed AFTER INSERT OR DELETE OR UPDATE OF terminal_status ON domain_event_receipts
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_completion_changed();

CREATE FUNCTION global_event_recovery_seed_page(p_limit integer DEFAULT 128) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE cursor_row record; item record; n integer; total integer:=0; last_seen text;
BEGIN
  IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'invalid recovery page size'; END IF;
  INSERT INTO global_event_recovery_seed(source) VALUES ('entitlements'),('impacts') ON CONFLICT DO NOTHING;
  FOR cursor_row IN SELECT * FROM global_event_recovery_seed WHERE NOT complete ORDER BY source FOR UPDATE SKIP LOCKED
  LOOP
    n:=0; last_seen:=cursor_row.last_id;
    IF cursor_row.source='entitlements' THEN
      FOR item IN SELECT id,event_id,user_id FROM global_step_event_entitlements WHERE id>cursor_row.last_id ORDER BY id LIMIT p_limit
      LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); n:=n+1; last_seen:=item.id; END LOOP;
    ELSE
      FOR item IN SELECT id,event_id,user_id FROM global_event_race_impacts WHERE id>cursor_row.last_id ORDER BY id LIMIT p_limit
      LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); n:=n+1; last_seen:=item.id; END LOOP;
    END IF;
    UPDATE global_event_recovery_seed SET last_id=last_seen,complete=(n<p_limit) WHERE source=cursor_row.source;
    total:=total+n;
  END LOOP;
  PERFORM global_event_recovery_cleanup_orphans(p_limit);
  -- Parent first: a concurrent event deletion must never hold the parent FK
  -- lock while waiting for a cursor whose owner is about to insert a signal.
  FOR cursor_row IN SELECT refresh.* FROM global_event_recovery_event_refresh refresh
    JOIN global_step_events parent ON parent.id=refresh.event_id
    ORDER BY refresh.requested_at,refresh.event_id LIMIT 1 FOR KEY SHARE OF parent SKIP LOCKED
  LOOP
    PERFORM 1 FROM global_event_recovery_event_refresh WHERE event_id=cursor_row.event_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO cursor_row FROM global_event_recovery_event_refresh WHERE event_id=cursor_row.event_id;
    IF NOT cursor_row.entitlements_complete THEN
      n:=0; last_seen:=cursor_row.last_entitlement_id;
      FOR item IN SELECT id,event_id,user_id FROM global_step_event_entitlements
        WHERE event_id=cursor_row.event_id AND id>cursor_row.last_entitlement_id ORDER BY id LIMIT p_limit
      LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); n:=n+1; last_seen:=item.id; END LOOP;
      UPDATE global_event_recovery_event_refresh SET last_entitlement_id=last_seen,entitlements_complete=(n<p_limit) WHERE event_id=cursor_row.event_id;
      total:=total+n;
    END IF;
    IF NOT cursor_row.impacts_complete THEN
      n:=0; last_seen:=cursor_row.last_impact_id;
      FOR item IN SELECT id,event_id,user_id FROM global_event_race_impacts
        WHERE event_id=cursor_row.event_id AND id>cursor_row.last_impact_id ORDER BY id LIMIT p_limit
      LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); n:=n+1; last_seen:=item.id; END LOOP;
      UPDATE global_event_recovery_event_refresh SET last_impact_id=last_seen,impacts_complete=(n<p_limit) WHERE event_id=cursor_row.event_id;
      total:=total+n;
    END IF;
    DELETE FROM global_event_recovery_event_refresh WHERE event_id=cursor_row.event_id AND entitlements_complete AND impacts_complete;
  END LOOP;
  RETURN total;
END;
$$;
