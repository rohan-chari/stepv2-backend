\set ON_ERROR_STOP on
-- Separate, explicitly authorized release >=7 days after replacement cutover.
-- Never place this script in prisma/migrations for the replacement release.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtextextended('simple-event-recap-schema-retirement',0));
DO $$
DECLARE cutover_at timestamp; unknown_functions text;
BEGIN
  SELECT updated_at INTO cutover_at FROM job_runs WHERE job_name='simple_event_recap:cutover:v1';
  IF cutover_at IS NULL OR cutover_at>(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '7 days' THEN
    RAISE EXCEPTION 'final drop requires a verified cutover at least seven days ago';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
    AND pid<>pg_backend_pid() AND backend_type='client backend') THEN
    RAISE EXCEPTION 'stop and drain database clients before final schema retirement';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'durable_capture_steps_source','durable_capture_samples_source',
    'global_event_summary_impact_vector_fence','durable_capture_deleted_owner',
    'durable_capture_terminal_pin_release','global_event_recovery_work_changed',
    'global_event_recovery_impact_changed','global_event_recovery_job_changed')) THEN
    RAISE EXCEPTION 'old capture/recovery triggers are still installed';
  END IF;
  SELECT string_agg(p.oid::regprocedure::text,', ') INTO unknown_functions
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'durable_capture_%'
      OR p.proname='fence_global_event_summary_impact_vector' OR p.proname='queue_durable_capture_pin_release')
    AND p.oid::regprocedure::text<>ALL(ARRAY[
      'fence_global_event_summary_impact_vector()', 'durable_capture_fact_days(text,jsonb)',
      'durable_capture_journal_source()', 'durable_capture_append_fact_page(uuid,jsonb)',
      'durable_capture_materialize_root(uuid)', 'durable_capture_prepare_root(uuid)',
      'durable_capture_compact(integer)', 'durable_capture_pin_roots(uuid,jsonb)',
      'durable_capture_release_deleted_owner()', 'queue_durable_capture_pin_release()',
      'durable_capture_evict_roots(integer)', 'durable_capture_evict_roots_internal(integer,boolean)',
      'durable_capture_compact_internal(integer,boolean)', 'durable_capture_compact_if_due(integer)']);
  IF unknown_functions IS NOT NULL THEN RAISE EXCEPTION 'audit unlisted recap functions before drop: %',unknown_functions; END IF;
  IF EXISTS(SELECT 1 FROM global_event_recovery_candidates WHERE kind<>'ENTITLEMENT_EVENT') THEN
    RAISE EXCEPTION 'old summary candidate writer remains';
  END IF;
  IF to_regclass('public.global_event_user_summaries') IS NOT NULL THEN
    IF EXISTS(SELECT 1 FROM global_event_user_summaries old LEFT JOIN event_recaps new
      ON new.event_id=old.event_id AND new.user_id=old.user_id
      WHERE new.id IS DISTINCT FROM old.id OR new.extra_race_steps IS DISTINCT FROM old.extra_race_steps
        OR new.race_count IS DISTINCT FROM old.race_count OR new.expires_at IS DISTINCT FROM old.expires_at
        OR new.settled_at IS DISTINCT FROM old.settled_at) THEN
      RAISE EXCEPTION 'uncopied/changed saved recap; audit old-writer activity before dropping evidence';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS fence_global_event_summary_impact_vector();
DROP FUNCTION IF EXISTS durable_capture_compact_if_due(integer);
DROP FUNCTION IF EXISTS durable_capture_compact(integer);
DROP FUNCTION IF EXISTS durable_capture_compact_internal(integer,boolean);
DROP FUNCTION IF EXISTS durable_capture_evict_roots(integer);
DROP FUNCTION IF EXISTS durable_capture_evict_roots_internal(integer,boolean);
DROP FUNCTION IF EXISTS durable_capture_pin_roots(uuid,jsonb);
DROP FUNCTION IF EXISTS durable_capture_prepare_root(uuid);
DROP FUNCTION IF EXISTS durable_capture_materialize_root(uuid);
DROP FUNCTION IF EXISTS durable_capture_append_fact_page(uuid,jsonb);
DROP FUNCTION IF EXISTS durable_capture_release_deleted_owner();
DROP FUNCTION IF EXISTS queue_durable_capture_pin_release();
DROP FUNCTION IF EXISTS durable_capture_journal_source();
DROP FUNCTION IF EXISTS durable_capture_fact_days(text,jsonb);

-- Explicit child-to-parent order; never DROP ... CASCADE.
DROP TABLE IF EXISTS durable_capture_score_points;
DROP TABLE IF EXISTS durable_capture_score_plans;
DROP TABLE IF EXISTS durable_capture_score_progress;
DROP TABLE IF EXISTS durable_capture_score_transfers;
DROP TABLE IF EXISTS durable_capture_score_owners;
DROP TABLE IF EXISTS durable_capture_pin_releases;
DROP TABLE IF EXISTS durable_global_event_capture_requests;
DROP TABLE IF EXISTS global_event_capture_artifacts;
DROP TABLE IF EXISTS global_event_summary_work;
DROP TABLE IF EXISTS global_event_user_summaries;
DROP TABLE IF EXISTS durable_capture_fact_pins;
DROP TABLE IF EXISTS durable_capture_fact_identities;
DROP TABLE IF EXISTS durable_capture_fact_pages;
DROP TABLE IF EXISTS durable_capture_prepared_inputs;
DROP TABLE IF EXISTS durable_capture_method_progress;
DROP TABLE IF EXISTS durable_capture_interval_projections;
DROP TABLE IF EXISTS durable_capture_fact_roots;
DROP TABLE IF EXISTS durable_capture_fact_journal;
DROP TABLE IF EXISTS durable_capture_fact_heads;
DROP TABLE IF EXISTS durable_capture_compaction_schedule;
DROP TABLE IF EXISTS durable_capture_root_sweep;

-- Ordinary retention preserves migrated results until the comparison above has
-- audited them. Now remove only demonstrably expired orphan copies, in bounded
-- pages. Null/future expiry is intentionally retained, never inferred.
DO $$
DECLARE removed integer;
BEGIN
  LOOP
    WITH page AS (
      SELECT recap.id FROM event_recaps recap
      WHERE recap.calculation_version='LEGACY_SAVED'
        AND recap.expires_at < (clock_timestamp() AT TIME ZONE 'UTC')
        AND NOT EXISTS (SELECT 1 FROM global_step_event_entitlements entitlement
          WHERE entitlement.event_id=recap.event_id AND entitlement.user_id=recap.user_id)
      ORDER BY recap.expires_at,recap.id LIMIT 500
    )
    DELETE FROM event_recaps recap USING page WHERE recap.id=page.id;
    GET DIAGNOSTICS removed = ROW_COUNT;
    EXIT WHEN removed=0;
  END LOOP;
END $$;

ALTER TABLE global_event_race_impacts
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS delta_steps,
  DROP COLUMN IF EXISTS attribution_version,
  DROP COLUMN IF EXISTS capture_kind,
  DROP COLUMN IF EXISTS capture_sync_request_id,
  DROP COLUMN IF EXISTS capture_completed_at,
  DROP COLUMN IF EXISTS capture_coverage_through,
  DROP COLUMN IF EXISTS source_scoring_input_generation,
  DROP COLUMN IF EXISTS source_resolution_generation,
  DROP COLUMN IF EXISTS terminal_reason,
  DROP COLUMN IF EXISTS terminal_at,
  DROP COLUMN IF EXISTS settled_at;
ALTER TABLE global_step_events DROP COLUMN IF EXISTS summary_attribution_version;
ALTER TABLE global_event_recovery_event_refresh
  DROP COLUMN IF EXISTS last_impact_id, DROP COLUMN IF EXISTS impacts_complete;
ALTER TABLE global_event_recovery_candidates DROP CONSTRAINT global_event_recovery_candidates_kind_check,
  ADD CONSTRAINT global_event_recovery_candidates_kind_check CHECK(kind='ENTITLEMENT_EVENT');
ALTER TABLE global_event_recovery_seed DROP CONSTRAINT global_event_recovery_seed_source_check,
  ADD CONSTRAINT global_event_recovery_seed_source_check CHECK(source='entitlements');
INSERT INTO job_runs(job_name,last_ran_for,updated_at)
  VALUES('simple_event_recap:drop:v1','retired-schema-removed',clock_timestamp() AT TIME ZONE 'UTC')
  ON CONFLICT(job_name) DO NOTHING;
COMMIT;
\ir simple-event-recap-verify.sql
