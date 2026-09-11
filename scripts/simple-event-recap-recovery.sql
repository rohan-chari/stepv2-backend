-- Included inside the stopped-writer cutover transaction. Notification-only
-- replacement of the shared recovery functions; no summary jobs or scans.
CREATE OR REPLACE FUNCTION global_event_recovery_refresh(p_event text,p_user text,
  p_at timestamp DEFAULT CURRENT_TIMESTAMP,p_signal_id bigint DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE entitlement global_step_event_entitlements%ROWTYPE; fence text; retained boolean:=false;
BEGIN
  IF p_signal_id IS NOT NULL THEN
    PERFORM 1 FROM global_event_recovery_candidates WHERE id=p_signal_id
      AND event_id=p_event AND user_id=p_user AND kind='ENTITLEMENT_EVENT'
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM global_step_events WHERE id=p_event)
    AND EXISTS(SELECT 1 FROM users WHERE id=p_user) THEN
    SELECT * INTO entitlement FROM global_step_event_entitlements WHERE event_id=p_event AND user_id=p_user;
    IF entitlement.id IS NOT NULL AND entitlement.ends_at>p_at THEN
      fence:='GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:' || entitlement.id || ':' || entitlement.schedule_revision::text;
      IF NOT EXISTS(SELECT 1 FROM domain_event_outbox WHERE event_key=fence)
        AND NOT EXISTS(SELECT 1 FROM domain_event_receipts WHERE event_key=fence AND terminal_status IS NOT NULL) THEN
        IF p_signal_id IS NULL THEN
          INSERT INTO global_event_recovery_candidates(kind,event_id,user_id,source_id,available_at,completion_key)
            VALUES('ENTITLEMENT_EVENT',p_event,p_user,entitlement.id,entitlement.created_at,fence);
        ELSE
          UPDATE global_event_recovery_candidates SET source_id=entitlement.id,
            available_at=entitlement.created_at,completion_key=fence WHERE id=p_signal_id;
          retained:=true;
        END IF;
      END IF;
    END IF;
  END IF;
  IF p_signal_id IS NOT NULL AND NOT retained THEN
    DELETE FROM global_event_recovery_candidates WHERE id=p_signal_id;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION global_event_recovery_source_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.event_id,NEW.user_id,NEW.ends_at,NEW.schedule_revision)
    IS NOT DISTINCT FROM (OLD.event_id,OLD.user_id,OLD.ends_at,OLD.schedule_revision) THEN RETURN NULL; END IF;
  IF TG_OP<>'INSERT' THEN PERFORM global_event_recovery_refresh(OLD.event_id,OLD.user_id); END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (NEW.event_id,NEW.user_id) IS DISTINCT FROM (OLD.event_id,OLD.user_id)) THEN
    PERFORM global_event_recovery_refresh(NEW.event_id,NEW.user_id);
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER global_event_recovery_entitlement_changed ON global_step_event_entitlements;
CREATE TRIGGER global_event_recovery_entitlement_changed AFTER INSERT OR DELETE OR UPDATE OF
  event_id,user_id,ends_at,schedule_revision ON global_step_event_entitlements
  FOR EACH ROW EXECUTE FUNCTION global_event_recovery_source_changed();

CREATE OR REPLACE FUNCTION global_event_recovery_parent_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.ends_at,NEW.schedule_mode) IS DISTINCT FROM (OLD.ends_at,OLD.schedule_mode) THEN
    INSERT INTO global_event_recovery_event_refresh(event_id) VALUES(NEW.id)
      ON CONFLICT(event_id) DO UPDATE SET last_entitlement_id='',
        entitlements_complete=false,requested_at=clock_timestamp();
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER global_event_recovery_parent_changed ON global_step_events;
CREATE TRIGGER global_event_recovery_parent_changed AFTER UPDATE OF ends_at,schedule_mode
  ON global_step_events FOR EACH ROW EXECUTE FUNCTION global_event_recovery_parent_changed();

CREATE OR REPLACE FUNCTION global_event_recovery_completion_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; key text; aggregate text;
BEGIN
  IF TG_OP='DELETE' THEN key:=OLD.event_key; aggregate:=OLD.aggregate_id;
  ELSE key:=NEW.event_key; aggregate:=NEW.aggregate_id; END IF;
  IF starts_with(key,'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:') THEN
    IF TG_OP<>'DELETE' AND (TG_TABLE_NAME='domain_event_outbox' OR to_jsonb(NEW)->>'terminal_status' IS NOT NULL) THEN
      DELETE FROM global_event_recovery_candidates WHERE completion_key=key;
      RETURN NULL;
    END IF;
    FOR item IN SELECT event_id,user_id FROM global_step_event_entitlements WHERE id=aggregate
    LOOP PERFORM global_event_recovery_refresh(item.event_id,item.user_id); END LOOP;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION global_event_recovery_revalidate_page(p_kind text,p_at timestamp,p_limit integer DEFAULT 128)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE item record; n integer:=0;
BEGIN
  IF p_kind IS DISTINCT FROM 'ENTITLEMENT_EVENT' THEN RAISE EXCEPTION 'unsupported recovery kind'; END IF;
  IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'invalid recovery page size'; END IF;
  FOR item IN SELECT event_id,user_id,array_agg(id ORDER BY id) AS ids FROM (
    SELECT id,event_id,user_id FROM global_event_recovery_candidates
    WHERE kind=p_kind AND available_at<=p_at ORDER BY available_at,event_id,user_id,id LIMIT p_limit
  ) page GROUP BY event_id,user_id ORDER BY event_id,user_id LOOP
    PERFORM global_event_recovery_refresh(item.event_id,item.user_id,p_at,item.ids[1]);
    DELETE FROM global_event_recovery_candidates WHERE id IN (
      SELECT id FROM global_event_recovery_candidates WHERE id=ANY(item.ids) AND id<>item.ids[1]
      FOR UPDATE SKIP LOCKED);
    n:=n+cardinality(item.ids);
  END LOOP;
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION global_event_recovery_seed_page(p_limit integer DEFAULT 128) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE cursor_row record; item record; n integer; total integer:=0; last_seen text;
BEGIN
  IF p_limit<1 OR p_limit>500 THEN RAISE EXCEPTION 'invalid recovery page size'; END IF;
  INSERT INTO global_event_recovery_seed(source) VALUES('entitlements') ON CONFLICT DO NOTHING;
  FOR cursor_row IN SELECT * FROM global_event_recovery_seed
    WHERE source='entitlements' AND NOT complete FOR UPDATE SKIP LOCKED LOOP
    n:=0; last_seen:=cursor_row.last_id;
    FOR item IN SELECT id,event_id,user_id FROM global_step_event_entitlements
      WHERE id>cursor_row.last_id ORDER BY id LIMIT p_limit LOOP
      PERFORM global_event_recovery_refresh(item.event_id,item.user_id); n:=n+1; last_seen:=item.id;
    END LOOP;
    UPDATE global_event_recovery_seed SET last_id=last_seen,complete=(n<p_limit) WHERE source=cursor_row.source;
    total:=total+n;
  END LOOP;
  PERFORM global_event_recovery_cleanup_orphans(p_limit);
  FOR cursor_row IN SELECT refresh.* FROM global_event_recovery_event_refresh refresh
    JOIN global_step_events parent ON parent.id=refresh.event_id
    ORDER BY refresh.requested_at,refresh.event_id LIMIT 1 FOR KEY SHARE OF parent SKIP LOCKED LOOP
    PERFORM 1 FROM global_event_recovery_event_refresh WHERE event_id=cursor_row.event_id FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO cursor_row FROM global_event_recovery_event_refresh WHERE event_id=cursor_row.event_id;
    IF NOT cursor_row.entitlements_complete THEN
      n:=0; last_seen:=cursor_row.last_entitlement_id;
      FOR item IN SELECT id,event_id,user_id FROM global_step_event_entitlements
        WHERE event_id=cursor_row.event_id AND id>cursor_row.last_entitlement_id ORDER BY id LIMIT p_limit LOOP
        PERFORM global_event_recovery_refresh(item.event_id,item.user_id); n:=n+1; last_seen:=item.id;
      END LOOP;
      UPDATE global_event_recovery_event_refresh SET last_entitlement_id=last_seen,entitlements_complete=(n<p_limit)
        WHERE event_id=cursor_row.event_id;
      total:=total+n;
    END IF;
    DELETE FROM global_event_recovery_event_refresh WHERE event_id=cursor_row.event_id AND entitlements_complete;
  END LOOP;
  RETURN total;
END $$;
