\set ON_ERROR_STOP on
-- NOT an automatic Prisma migration. Requires fresh deployment authorization,
-- backup, replacement artifact, and all old database clients drained/stopped.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('simple-event-recap-schema-retirement',0));
DO $$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND pid<>pg_backend_pid() AND backend_type='client backend') THEN
    RAISE EXCEPTION 'stop and drain ALL database clients before recap cutover';
  END IF;
  IF to_regclass('public.event_recaps') IS NULL THEN RAISE EXCEPTION 'apply additive migration A first'; END IF;
  IF EXISTS(SELECT 1 FROM job_runs WHERE job_name='simple_event_recap:drop:v1') THEN
    RAISE EXCEPTION 'final retirement already applied; do not rerun cutover';
  END IF;
END $$;

-- Lock source tables before detaching writers; a new connection racing the
-- stopped-client check must not run a source mutation halfway through cutover.
LOCK TABLE users,races,steps,step_samples,global_step_events,
  global_step_event_entitlements,global_event_race_impacts,
  global_event_summary_work,global_event_user_summaries,
  durable_global_event_capture_requests,domain_event_outbox,
  domain_event_receipts,job_runs IN ACCESS EXCLUSIVE MODE;

-- Preserve every saved ID/value/expiry/ack; do not recompute old results.
-- Already acknowledged new rows may retain a later acknowledgment on rerun.
DO $$
DECLARE after_id text:=''; ids text[]; copied integer:=0; batch_count integer;
BEGIN
  LOOP
    SELECT array_agg(id ORDER BY id),max(id) INTO ids,after_id FROM
      (SELECT id FROM global_event_user_summaries WHERE id>after_id ORDER BY id LIMIT 500) page;
    EXIT WHEN ids IS NULL;
    INSERT INTO event_recaps(id,event_id,user_id,calculation_version,raw_steps,race_count,
      extra_race_steps,settled_at,expires_at,acknowledged_at,suppressed)
      SELECT id,event_id,user_id,'LEGACY_SAVED',NULL,race_count,extra_race_steps,
        settled_at,expires_at,acknowledged_at,
        extra_race_steps<=0 OR attribution_version<>2 OR expires_at IS NULL
      FROM global_event_user_summaries WHERE id=ANY(ids)
      ON CONFLICT(event_id,user_id) DO NOTHING;
    GET DIAGNOSTICS batch_count=ROW_COUNT; copied:=copied+batch_count;
    IF EXISTS(SELECT 1 FROM global_event_user_summaries old
      LEFT JOIN event_recaps new ON new.event_id=old.event_id AND new.user_id=old.user_id
      WHERE old.id=ANY(ids) AND (new.id IS DISTINCT FROM old.id
        OR new.calculation_version<>'LEGACY_SAVED'
        OR new.race_count IS DISTINCT FROM old.race_count
        OR new.extra_race_steps IS DISTINCT FROM old.extra_race_steps
        OR new.settled_at IS DISTINCT FROM old.settled_at
        OR new.expires_at IS DISTINCT FROM old.expires_at
        OR (old.acknowledged_at IS NOT NULL AND new.acknowledged_at IS DISTINCT FROM old.acknowledged_at)
        OR new.suppressed IS DISTINCT FROM (old.extra_race_steps<=0 OR old.attribution_version<>2 OR old.expires_at IS NULL))) THEN
      RAISE EXCEPTION 'saved recap copy mismatch; cutover rolled back';
    END IF;
  END LOOP;
  RAISE NOTICE 'saved recap rows copied: %',copied;
END $$;

DROP TRIGGER IF EXISTS durable_capture_steps_source ON steps;
DROP TRIGGER IF EXISTS durable_capture_samples_source ON step_samples;
DROP TRIGGER IF EXISTS global_event_summary_impact_vector_fence ON global_event_race_impacts;
DROP TRIGGER IF EXISTS durable_capture_deleted_owner ON durable_global_event_capture_requests;
DROP TRIGGER IF EXISTS durable_capture_terminal_pin_release ON durable_global_event_capture_requests;
DROP TRIGGER IF EXISTS global_event_recovery_impact_changed ON global_event_race_impacts;
DROP TRIGGER IF EXISTS global_event_recovery_work_changed ON global_event_summary_work;
DROP TRIGGER IF EXISTS global_event_recovery_job_changed ON job_runs;

\ir simple-event-recap-recovery.sql

-- Narrow, validated integrity changes. With the old GC removed, retained
-- storage must neither block deletion nor retain detached personal payloads.
-- Preserve existing columns, targets and ON UPDATE; no live scoring FK changes.
DO $$
DECLARE item record; definition text; deletion "char"; actual_parent text; validated boolean;
BEGIN
  FOR item IN SELECT * FROM (VALUES
    ('global_event_user_summaries','global_event_user_summaries_event_id_fkey','global_step_events'),
    ('global_event_user_summaries','global_event_user_summaries_user_id_fkey','users'),
    ('global_event_summary_work','global_event_summary_work_event_id_fkey','global_step_events'),
    ('global_event_capture_artifacts','global_event_capture_artifacts_event_id_fkey','global_step_events'),
    ('global_event_capture_artifacts','global_event_capture_artifacts_race_id_fkey','races'),
    ('durable_capture_score_owners','durable_capture_score_owners_live_request_id_fkey','durable_global_event_capture_requests'),
    ('durable_capture_score_progress','durable_capture_score_progress_request_id_fkey','durable_capture_score_owners'),
    ('durable_capture_score_plans','durable_capture_score_plans_request_id_fkey','durable_capture_score_owners'),
    ('durable_capture_score_transfers','durable_capture_score_transfers_request_id_fkey','durable_capture_score_owners'),
    ('durable_capture_score_points','durable_capture_score_points_request_id_race_id_plan_key_fkey','durable_capture_score_plans')
  ) AS manifest(child,constraint_name,parent) LOOP
    SELECT pg_get_constraintdef(c.oid),c.confdeltype,c.confrelid::regclass::text,c.convalidated
      INTO STRICT definition,deletion,actual_parent,validated FROM pg_constraint c
      WHERE c.conrelid=to_regclass(item.child) AND c.conname=item.constraint_name AND c.contype='f';
    IF actual_parent<>item.parent OR NOT validated OR deletion NOT IN ('r','n','c') THEN
      RAISE EXCEPTION 'unexpected FK shape: %.%',item.child,item.constraint_name;
    END IF;
    IF deletion<>'c' THEN
      definition:=regexp_replace(definition,'ON DELETE (RESTRICT|SET NULL)','ON DELETE CASCADE');
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I, ADD CONSTRAINT %I %s',
        item.child,item.constraint_name,item.constraint_name,definition);
    END IF;
  END LOOP;
  -- Existing detached owners predate the new cascades. Their scratch payload
  -- has no live request and was already eligible for old GC. Fail closed on a
  -- large population so deployment can plan a bounded pre-cutover drain.
  IF EXISTS(SELECT 1 FROM durable_capture_score_owners WHERE live_request_id IS NULL ORDER BY created_at,id OFFSET 10000 LIMIT 1) THEN
    RAISE EXCEPTION 'more than 10000 orphan capture owners; plan existing bounded GC drain before cutover';
  END IF;
  LOOP
    DELETE FROM durable_capture_score_owners WHERE id IN
      (SELECT id FROM durable_capture_score_owners WHERE live_request_id IS NULL ORDER BY created_at,id LIMIT 500);
    EXIT WHEN NOT FOUND;
  END LOOP;
END $$;

DO $$
DECLARE deleted integer; total integer:=0;
BEGIN
  LOOP
    DELETE FROM global_event_recovery_candidates WHERE id IN
      (SELECT id FROM global_event_recovery_candidates WHERE kind IN ('SUMMARY_V1','SUMMARY_V2') ORDER BY id LIMIT 500);
    GET DIAGNOSTICS deleted=ROW_COUNT; total:=total+deleted; EXIT WHEN deleted=0;
  END LOOP;
  RAISE NOTICE 'retired recovery candidates removed: %',total;
  total:=0;
  LOOP
    DELETE FROM job_runs WHERE job_name IN
      (SELECT job_name FROM job_runs WHERE starts_with(job_name,'global_event_summary:') ORDER BY job_name LIMIT 500);
    GET DIAGNOSTICS deleted=ROW_COUNT; total:=total+deleted; EXIT WHEN deleted=0;
  END LOOP;
  RAISE NOTICE 'retired summary job fences removed: %',total;
END $$;
DELETE FROM global_event_recovery_seed WHERE source='impacts';
INSERT INTO job_runs(job_name,last_ran_for,updated_at)
  VALUES('simple_event_recap:cutover:v1','worker-retired-capture-detached',clock_timestamp() AT TIME ZONE 'UTC')
  ON CONFLICT(job_name) DO NOTHING;
COMMIT;
\ir simple-event-recap-verify.sql
