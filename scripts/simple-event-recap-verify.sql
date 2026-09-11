-- Read-only post-cutover gate. Run with psql --set=ON_ERROR_STOP=1.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'durable_capture_steps_source','durable_capture_samples_source',
    'global_event_summary_impact_vector_fence','durable_capture_deleted_owner',
    'durable_capture_terminal_pin_release','global_event_recovery_work_changed',
    'global_event_recovery_impact_changed','global_event_recovery_job_changed')) THEN
    RAISE EXCEPTION 'retired recap trigger remains installed';
  END IF;
  IF to_regclass('public.event_recaps') IS NULL THEN RAISE EXCEPTION 'event_recaps missing'; END IF;
  IF EXISTS (SELECT 1 FROM global_event_recovery_candidates WHERE kind IN ('SUMMARY_V1','SUMMARY_V2')) THEN
    RAISE EXCEPTION 'retired recovery candidates remain';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'global_event_recovery_%'
      AND p.prosrc ~ '(global_event_summary_work|global_event_race_impacts|SUMMARY_V1|SUMMARY_V2|global_event_summary:)') THEN
    RAISE EXCEPTION 'shared recovery still references retired recap work';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='global_event_recovery_entitlement_changed')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='global_event_recovery_outbox_changed')
    OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='global_event_recovery_receipt_changed') THEN
    RAISE EXCEPTION 'notification recovery trigger missing';
  END IF;
END $$;
SELECT 'recap cutover catalog checks passed' AS result;
COMMIT;
