const { prisma: defaultPrisma } = require("../../../db");

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

function buildNotificationCompletenessReconciler(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const pageSize = Math.min(500, Math.max(1, Number(dependencies.pageSize) || 500));
  return async function reconcileNotificationCompleteness() {
    const current = now();
    const unknownReset = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT id FROM domain_event_outbox
          WHERE event_type='GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'
            AND status='FAILED_TERMINAL'
            AND last_error_code='UNKNOWN_DOMAIN_EVENT_VERSION'
          ORDER BY created_at, id LIMIT $1
       )
       UPDATE domain_event_outbox event
          SET status='RETRY', available_at=$2, completed_at=NULL,
              lease_token=NULL, lease_until=NULL, last_error_code=NULL,
              updated_at=$2
         FROM candidates WHERE event.id=candidates.id`,
      pageSize,
      current,
    );
    const projectionsRearmed = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT projection.id
           FROM domain_event_notification_projections projection
           JOIN domain_event_outbox event ON event.id=projection.domain_event_id
          WHERE event.event_type='GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'
            AND projection.status IN ('COMPLETED','FAILED_TERMINAL')
            AND NOT EXISTS (
              SELECT 1 FROM notification_schedules schedule
               WHERE schedule.recipient_user_id=projection.recipient_user_id
                 AND schedule.delivery_key=projection.delivery_key
            )
          ORDER BY projection.created_at, projection.id LIMIT $1
       )
       UPDATE domain_event_notification_projections projection
          SET status='RETRY', available_at=$2, completed_at=NULL,
              lease_token=NULL, lease_until=NULL, last_error_code=NULL,
              updated_at=$2
         FROM candidates WHERE projection.id=candidates.id`,
      pageSize,
      current,
    );
    const linkedDormant = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT schedule.id
           FROM notification_schedules schedule
          WHERE schedule.status='CANCELLED_NO_ACTIVE_RACE'
            AND EXISTS (
              SELECT 1 FROM inbox_alerts alert
               WHERE alert.user_id=schedule.recipient_user_id
                 AND alert.source_key=schedule.delivery_key
            )
          ORDER BY schedule.available_at,schedule.id LIMIT $2
       )
       UPDATE notification_schedules schedule
          SET status='MATERIALIZED', released_at=COALESCE(schedule.released_at,$1), updated_at=$1
         FROM candidates WHERE schedule.id=candidates.id`,
      current, pageSize,
    );
    const materializationGapsRearmed = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT schedule.id
           FROM notification_schedules schedule
          WHERE schedule.type='GLOBAL_EVENT_STARTED'
            AND schedule.status='MATERIALIZED'
            AND (
              NOT EXISTS (
                SELECT 1 FROM inbox_alerts alert
                 WHERE alert.user_id=schedule.recipient_user_id
                   AND alert.source_key=schedule.delivery_key
              ) OR NOT EXISTS (
                SELECT 1 FROM inbox_alerts alert
                JOIN inbox_delivery_outbox outbox ON outbox.alert_id=alert.id AND outbox.kind='PUSH'
                 WHERE alert.user_id=schedule.recipient_user_id
                   AND alert.source_key=schedule.delivery_key
              )
            )
          ORDER BY schedule.updated_at,schedule.id LIMIT $2
       )
       UPDATE notification_schedules schedule
          SET status='PENDING',claimed_at=NULL,released_at=NULL,
              canceled_at=NULL,cancellation_reason=NULL,available_at=$1,updated_at=$1
         FROM candidates WHERE schedule.id=candidates.id`,
      current, pageSize,
    );
    const overdueOutboxesRearmed = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT outbox.id
           FROM inbox_delivery_outbox outbox
           JOIN inbox_alerts alert ON alert.id=outbox.alert_id
           JOIN notification_schedules schedule
             ON schedule.recipient_user_id=alert.user_id
            AND schedule.delivery_key=alert.source_key
          WHERE schedule.type='GLOBAL_EVENT_STARTED'
            AND ((outbox.status='LEASED' AND outbox.lease_until <= $1)
              OR (outbox.status='RETRY' AND outbox.available_at <= $1 - interval '30 seconds'))
          ORDER BY outbox.available_at,outbox.id LIMIT $2
       )
       UPDATE inbox_delivery_outbox outbox
          SET status='RETRY',available_at=$1,retry_at=$1,
              lease_until=NULL,lease_token=NULL,updated_at=$1
         FROM candidates WHERE outbox.id=candidates.id`,
      current, pageSize,
    );
    const terminalTargetsRepaired = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT attempt.id,outbox.status
           FROM inbox_delivery_device_attempts attempt
           JOIN inbox_delivery_outbox outbox ON outbox.id=attempt.outbox_id
           JOIN inbox_alerts alert ON alert.id=outbox.alert_id
           JOIN notification_schedules schedule
             ON schedule.recipient_user_id=alert.user_id
            AND schedule.delivery_key=alert.source_key
          WHERE schedule.type='GLOBAL_EVENT_STARTED'
            AND outbox.status IN ('DELIVERED','EXPIRED','EXHAUSTED')
            AND attempt.disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT')
          ORDER BY attempt.updated_at,attempt.id LIMIT $2
       )
       UPDATE inbox_delivery_device_attempts attempt
          SET disposition='EXHAUSTED',next_attempt_at=NULL,
              last_error_code=CASE WHEN candidates.status='EXPIRED'
                THEN 'NOTIFICATION_EXPIRED' ELSE 'OUTBOX_TERMINAL_RECONCILED' END,
              updated_at=$1
         FROM candidates WHERE attempt.id=candidates.id`,
      current, pageSize,
    );
    const missingSnapshotsRearmed = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT outbox.id
           FROM inbox_delivery_outbox outbox
           JOIN inbox_alerts alert ON alert.id=outbox.alert_id
           JOIN notification_schedules schedule
             ON schedule.recipient_user_id=alert.user_id
            AND schedule.delivery_key=alert.source_key
          WHERE schedule.type='GLOBAL_EVENT_STARTED'
            AND outbox.status IN ('RETRY','LEASED','DELIVERED','EXHAUSTED')
            AND (outbox.expires_at IS NULL OR outbox.expires_at > $1)
            AND NOT EXISTS (
              SELECT 1 FROM inbox_delivery_device_attempts attempt
               WHERE attempt.outbox_id=outbox.id
            )
          ORDER BY outbox.updated_at,outbox.id LIMIT $2
       )
       UPDATE inbox_delivery_outbox outbox
          SET status='RETRY',available_at=$1,retry_at=$1,
              lease_until=NULL,lease_token=NULL,delivered_at=NULL,updated_at=$1,
              last_error_code='TARGET_SNAPSHOT_RECONCILED'
         FROM candidates WHERE outbox.id=candidates.id`,
      current, pageSize,
    );
    const expired = await prisma.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT id FROM notification_schedules
          WHERE status IN ('PENDING','CANCELLED_NO_ACTIVE_RACE')
            AND expires_at <= $1
          ORDER BY expires_at,id LIMIT $2
       )
       UPDATE notification_schedules schedule
          SET status='EXPIRED',canceled_at=$1,cancellation_reason='EXPIRED',updated_at=$1
         FROM candidates WHERE schedule.id=candidates.id`,
      current, pageSize,
    );
    return {
      unknownEventsReset: Number(unknownReset),
      projectionsRearmed: Number(projectionsRearmed),
      linkedDormant: Number(linkedDormant),
      materializationGapsRearmed: Number(materializationGapsRearmed),
      overdueOutboxesRearmed: Number(overdueOutboxesRearmed),
      terminalTargetsRepaired: Number(terminalTargetsRepaired),
      missingSnapshotsRearmed: Number(missingSnapshotsRearmed),
      expired: Number(expired),
      fullPage: Number(unknownReset) === pageSize || Number(projectionsRearmed) === pageSize ||
        Number(linkedDormant) === pageSize || Number(materializationGapsRearmed) === pageSize ||
        Number(overdueOutboxesRearmed) === pageSize || Number(terminalTargetsRepaired) === pageSize ||
        Number(missingSnapshotsRearmed) === pageSize || Number(expired) === pageSize,
    };
  };
}

function scheduleNotificationCompletenessReconciler(dependencies = {}) {
  const run = dependencies.run || buildNotificationCompletenessReconciler(dependencies);
  const logger = dependencies.logger || console;
  let stopped = false;
  let running = null;
  let timer = null;
  const tick = () => {
    if (stopped || running) return running;
    running = run().catch((error) => logger.error?.("[NOTIFICATION] completeness reconciliation failed", {
      errorCode: error?.code || "NOTIFICATION_RECONCILE_FAILED",
    })).finally(() => { running = null; });
    return running;
  };
  const arm = (delay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await tick();
      arm(result?.fullPage ? 0 : (dependencies.intervalMs || RECONCILE_INTERVAL_MS));
    }, delay);
    timer.unref?.();
  };
  arm(0);
  return { tick, async stop() { stopped = true; if (timer) clearTimeout(timer); await running; } };
}

module.exports = {
  RECONCILE_INTERVAL_MS,
  buildNotificationCompletenessReconciler,
  scheduleNotificationCompletenessReconciler,
};
