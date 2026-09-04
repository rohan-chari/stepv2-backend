const { prisma: defaultPrisma } = require("../../../db");

const ALERT_VISIBILITY_MS = 30 * 24 * 60 * 60 * 1000;
const MAXIMUM_PRODUCER_RETRY_MS = 15 * 60 * 1000;

function sourceTypeForIntent(intent) {
  if (intent.type === "GLOBAL_EVENT_STARTED") return "GLOBAL_STEP_EVENT_ENTITLEMENT";
  if (intent.type?.startsWith("RACE_")) return "RACE_DOMAIN_EVENT";
  return "NOTIFICATION_SOURCE";
}

function classifyScheduleReceipt(intent) {
  if (intent.sourceRef) {
    return {
      sourceKind: "SOURCE_BACKED",
      sourceType: sourceTypeForIntent(intent),
      sourceId: intent.sourceRef,
      sourceRevision: Number(intent.sourceRevision) || 0,
      directRetainUntil: null,
    };
  }
  const availableAt = new Date(intent.availableAt);
  const visibleUntil = intent.expiresAt
    ? new Date(intent.expiresAt)
    : new Date(availableAt.getTime() + ALERT_VISIBILITY_MS);
  return {
    sourceKind: "DIRECT",
    sourceType: null,
    sourceId: null,
    sourceRevision: null,
    directRetainUntil: new Date(visibleUntil.getTime() + MAXIMUM_PRODUCER_RETRY_MS),
  };
}

function buildNotificationScheduleReceiptModel(prisma = defaultPrisma) {
  return {
    async reserve(intent, tx = prisma) {
      const identity = classifyScheduleReceipt(intent);
      const key = {
        recipientUserId: intent.recipientUserId,
        deliveryKey: intent.deliveryKey,
      };
      const now = new Date();
      const inserted = await tx.notificationScheduleReceipt.createMany({
        data: [{ ...key, ...identity, createdAt: now, updatedAt: now }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) return { inserted: true, ...identity };
      const existing = typeof tx.$queryRawUnsafe === "function"
        ? (await tx.$queryRawUnsafe(
          `SELECT source_kind AS "sourceKind",source_type AS "sourceType",
                  source_id AS "sourceId",source_revision AS "sourceRevision",
                  terminal_status AS "terminalStatus",completed_at AS "completedAt",
                  schedule_present AS "schedulePresent"
             FROM notification_schedule_receipts
            WHERE recipient_user_id=$1 AND delivery_key=$2
            FOR UPDATE`,
          key.recipientUserId,
          key.deliveryKey,
        ))[0]
        : await tx.notificationScheduleReceipt.findUniqueOrThrow({
          where: { recipientUserId_deliveryKey: key },
        });
      const sameSource = existing.sourceKind === identity.sourceKind &&
        existing.sourceType === identity.sourceType &&
        existing.sourceId === identity.sourceId;
      if (!sameSource) {
        const error = new Error("notification schedule receipt immutable identity mismatch");
        error.code = "NOTIFICATION_SCHEDULE_RECEIPT_COLLISION";
        throw error;
      }
      const existingRevision = Number(existing.sourceRevision || 0);
      const incomingRevision = Number(identity.sourceRevision || 0);
      if (identity.sourceKind === "SOURCE_BACKED" && incomingRevision > existingRevision) {
        await tx.notificationScheduleReceipt.update({
          where: { recipientUserId_deliveryKey: key },
          data: {
            sourceRevision: incomingRevision,
            terminalStatus: null,
            completedAt: null,
            updatedAt: now,
          },
        });
        return { inserted: false, advanced: true, previousRevision: existingRevision, ...identity };
      }
      return {
        inserted: false,
        advanced: false,
        staleReplay: incomingRevision < existingRevision,
        receipt: existing,
        ...identity,
      };
    },
    async markTerminal({ recipientUserId, deliveryKey, terminalStatus, completedAt }, tx = prisma) {
      return tx.notificationScheduleReceipt.updateMany({
        where: { recipientUserId, deliveryKey },
        data: { terminalStatus, completedAt, updatedAt: completedAt },
      });
    },
    async markTerminalMany({ rows, terminalStatus, completedAt }, tx = prisma) {
      if (!Array.isArray(rows) || rows.length === 0) return 0;
      return tx.$executeRawUnsafe(
        `UPDATE notification_schedule_receipts receipt
            SET terminal_status=$2, completed_at=$3, updated_at=$3
           FROM jsonb_to_recordset($1::jsonb)
             AS input("recipientUserId" text,"deliveryKey" text)
          WHERE receipt.recipient_user_id=input."recipientUserId"
            AND receipt.delivery_key=input."deliveryKey"`,
        JSON.stringify(rows.map((row) => ({
          recipientUserId: row.recipientUserId,
          deliveryKey: row.deliveryKey,
        }))),
        terminalStatus,
        completedAt,
      );
    },
    async backfillPage({ limit = 500 } = {}, tx = prisma) {
      const pageSize = Math.max(1, Math.min(500, Number(limit) || 500));
      return tx.$executeRawUnsafe(
        `WITH candidate AS MATERIALIZED (
           SELECT schedule.*
             FROM notification_schedules schedule
             LEFT JOIN notification_schedule_receipts receipt
               ON receipt.recipient_user_id=schedule.recipient_user_id
              AND receipt.delivery_key=schedule.delivery_key
            WHERE receipt.recipient_user_id IS NULL
            ORDER BY schedule.created_at,schedule.id
            LIMIT $1
            FOR UPDATE OF schedule SKIP LOCKED
         )
         INSERT INTO notification_schedule_receipts (
           recipient_user_id,delivery_key,source_kind,source_type,source_id,
           source_revision,terminal_status,completed_at,direct_retain_until,
           created_at,updated_at
         )
         SELECT candidate.recipient_user_id,candidate.delivery_key,
                CASE WHEN candidate.source_ref IS NULL THEN 'DIRECT'
                     ELSE 'SOURCE_BACKED' END,
                CASE
                  WHEN candidate.source_ref IS NULL THEN NULL
                  WHEN candidate.type='GLOBAL_EVENT_STARTED'
                    THEN 'GLOBAL_STEP_EVENT_ENTITLEMENT'
                  ELSE 'LEGACY_UNMAPPED'
                END,
                candidate.source_ref,
                CASE WHEN candidate.source_ref IS NULL THEN NULL
                     ELSE candidate.source_revision END,
                CASE WHEN candidate.status IN (
                  'MATERIALIZED','EXPIRED','CANCELLED','CANCELLED_NO_ACTIVE_RACE'
                ) THEN candidate.status ELSE NULL END,
                CASE WHEN candidate.status IN (
                  'MATERIALIZED','EXPIRED','CANCELLED','CANCELLED_NO_ACTIVE_RACE'
                ) THEN candidate.updated_at ELSE NULL END,
                CASE WHEN candidate.source_ref IS NULL THEN
                  COALESCE(candidate.expires_at,candidate.available_at+interval '30 days')+
                    interval '15 minutes'
                  ELSE NULL END,
                candidate.created_at,candidate.updated_at
           FROM candidate
         ON CONFLICT (recipient_user_id,delivery_key) DO NOTHING`,
        pageSize,
      );
    },
    async cleanupEligible({ now = new Date(), limit = 500 } = {}, tx = prisma) {
      const pageSize = Math.max(1, Math.min(500, Number(limit) || 500));
      return tx.$transaction(async (client) => {
        await client.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await client.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
        const deleted = await client.$queryRawUnsafe(
        `WITH candidate AS MATERIALIZED (
           SELECT receipt.recipient_user_id,receipt.delivery_key
             FROM notification_schedule_receipts receipt
            WHERE (
                (receipt.source_kind='DIRECT' AND receipt.direct_retain_until <= $1)
                OR
                (receipt.source_kind='SOURCE_BACKED'
                 AND receipt.source_type='GLOBAL_STEP_EVENT_ENTITLEMENT'
                 AND NOT EXISTS (
                   SELECT 1 FROM global_step_event_entitlements source
                    WHERE source.id=receipt.source_id
                 ))
              )
              AND NOT EXISTS (
                SELECT 1 FROM notification_schedules schedule
                 WHERE schedule.recipient_user_id=receipt.recipient_user_id
                   AND schedule.delivery_key=receipt.delivery_key
              )
              AND NOT EXISTS (
                SELECT 1 FROM inbox_alerts alert
                 WHERE alert.user_id=receipt.recipient_user_id
                   AND alert.source_key=receipt.delivery_key
              )
            ORDER BY receipt.created_at,receipt.recipient_user_id,receipt.delivery_key
            LIMIT $2
            FOR UPDATE OF receipt SKIP LOCKED
         ), removed AS (
           DELETE FROM notification_schedule_receipts receipt
           USING candidate
           WHERE receipt.recipient_user_id=candidate.recipient_user_id
             AND receipt.delivery_key=candidate.delivery_key
           RETURNING receipt.recipient_user_id
         ) SELECT recipient_user_id FROM removed`,
        now,
        pageSize,
      );
        return deleted.length;
      }, { timeout: 3_000, maxWait: 2_000 });
    },
    async cleanupTerminalPayloads({ limit = 500 } = {}, tx = prisma) {
      const pageSize = Math.max(1, Math.min(500, Number(limit) || 500));
      return tx.$transaction(async (client) => {
        await client.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await client.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
        const deleted = await client.$queryRawUnsafe(
          `WITH candidate AS MATERIALIZED (
             SELECT schedule.id
               FROM notification_schedules schedule
               JOIN notification_schedule_receipts receipt
                 ON receipt.recipient_user_id=schedule.recipient_user_id
                AND receipt.delivery_key=schedule.delivery_key
              WHERE schedule.status IN (
                      'MATERIALIZED','EXPIRED','CANCELLED','CANCELLED_NO_ACTIVE_RACE'
                    )
                AND receipt.terminal_status IS NOT NULL
                AND receipt.completed_at IS NOT NULL
                AND (
                  (schedule.source_ref IS NULL AND receipt.source_kind='DIRECT')
                  OR
                  (schedule.source_ref IS NOT NULL
                   AND receipt.source_kind='SOURCE_BACKED'
                   AND receipt.source_id=schedule.source_ref
                   AND receipt.source_revision=schedule.source_revision)
                )
                AND NOT EXISTS (
                  SELECT 1 FROM inbox_alerts alert
                   WHERE alert.user_id=schedule.recipient_user_id
                     AND alert.source_key=schedule.delivery_key
                )
              ORDER BY schedule.updated_at,schedule.id
              LIMIT $1
              FOR UPDATE OF schedule SKIP LOCKED
           ), removed AS (
             DELETE FROM notification_schedules schedule
             USING candidate
             WHERE schedule.id=candidate.id
             RETURNING schedule.id
           ) SELECT id FROM removed`,
          pageSize,
        );
        return deleted.length;
      }, { timeout: 3_000, maxWait: 2_000 });
    },
  };
}

const NotificationScheduleReceipt = buildNotificationScheduleReceiptModel();

module.exports = {
  ALERT_VISIBILITY_MS,
  MAXIMUM_PRODUCER_RETRY_MS,
  classifyScheduleReceipt,
  buildNotificationScheduleReceiptModel,
  NotificationScheduleReceipt,
};
