const crypto = require("node:crypto");
const {
  NotificationScheduleReceipt,
} = require("../models/notificationScheduleReceipt");

const ADMISSION_CLASS_GLOBAL_EVENT_STARTED = "visible:GLOBAL_EVENT_STARTED";
// Capacity candidate: 100 final provider-attempt admissions/second. At the
// ten-times incident cohort (5,170 schedules), this drains first attempts in
// 51.7 seconds; the 40%-headroom forecast drains in 72.4 seconds, below the
// product-approved two-minute notification window. The capacity gate must
// still prove this constant before production deployment.
const GLOBAL_EVENT_ATTEMPTS_PER_MINUTE = 6000;
const GLOBAL_EVENT_DELIVERY_WINDOW_MS = 2 * 60_000;
const GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS = 60_000;
const PROVIDER_ADMISSION_PAGE_SIZE = 100;
const ADMISSION_FIRST = "ADMISSION_FIRST";
const ADMISSION_RETRY = "ADMISSION_RETRY";
const ADMISSION_LEASED = "ADMISSION_LEASED";
const ADMISSION_PENDING = "ADMISSION_PENDING";
const ADMISSION_LEASE_MS = 30_000;
const ADMISSION_RECOVERY_DEFER_MS = 60_000;

function tokenSpacingMicros(attemptsPerMinute) {
  const rate = Number(attemptsPerMinute);
  if (!Number.isInteger(rate) || rate < 1 || 60_000_000 % rate !== 0) {
    throw new TypeError("attemptsPerMinute must divide 60,000,000 exactly");
  }
  return 60_000_000 / rate;
}

function admissionSequenceForDeliveryKey(deliveryKey) {
  if (typeof deliveryKey !== "string" || deliveryKey.length === 0) {
    throw new TypeError("deliveryKey is required");
  }
  const bytes = crypto.createHash("sha256").update(deliveryKey).digest();
  return bytes.readBigUInt64BE(0) & 0x7fffffffffffffffn;
}

function clampPageSize(value) {
  return Math.max(1, Math.min(500, Number(value) || PROVIDER_ADMISSION_PAGE_SIZE));
}

// Every producer and consumer of an admitted global-event row takes this same
// row lock before it changes admission-visible state. This makes the lane row
// the serialization point for "all first attempts before any retry".
async function lockNotificationAdmissionLane(tx, {
  admissionClass = ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  now = new Date(),
} = {}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO notification_release_lanes (admission_class,next_token_at,created_at,updated_at)
     VALUES ($1,$2,$2,$2) ON CONFLICT (admission_class) DO NOTHING`,
    admissionClass, now,
  );
  const [lane] = await tx.$queryRawUnsafe(
    `SELECT next_token_at AS "nextTokenAt" FROM notification_release_lanes
      WHERE admission_class=$1 FOR UPDATE`,
    admissionClass,
  );
  return lane;
}

async function releaseEventNotificationPage({
  prisma,
  admissionClass = ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  now = new Date(),
  maximumRows = PROVIDER_ADMISSION_PAGE_SIZE,
  telemetry = null,
  invalidateUnreadBatch = null,
  scheduleReceipt = NotificationScheduleReceipt,
} = {}) {
  if (!prisma?.$transaction) throw new TypeError("prisma transaction client is required");
  const current = new Date(now);
  const limit = clampPageSize(maximumRows);
  const transactionResult = await prisma.$transaction(async (tx) => {
    await lockNotificationAdmissionLane(tx, { admissionClass, now: current });
    const rows = await tx.$queryRawUnsafe(
      `SELECT schedule.id,
              schedule.recipient_user_id AS "recipientUserId",
              schedule.type,schedule.title,schedule.body,schedule.payload,
              schedule.delivery_key AS "deliveryKey",
              schedule.available_at AS "availableAt",
              schedule.expires_at AS "expiresAt",
              schedule.source_ref AS "sourceRef",
              schedule.admission_sequence AS "admissionSequence",
              entitlement.event_id AS "eventId",
              entitlement.user_id AS "entitlementUserId",
              entitlement.starts_at AS "entitlementStartsAt",
              entitlement.ends_at AS "entitlementEndsAt",
              entitlement.start_outcome AS "startOutcome",
              entitlement.start_processed_at AS "startProcessedAt",
              EXISTS (
                SELECT 1 FROM global_event_race_impacts impact
                 WHERE impact.event_id=entitlement.event_id
                   AND impact.user_id=entitlement.user_id
              ) AS "hasImpact"
         FROM notification_schedules schedule
         LEFT JOIN global_step_event_entitlements entitlement
           ON entitlement.id=schedule.source_ref
        WHERE schedule.admission_class=$1
          AND schedule.status='ADMISSION_PENDING'
          AND schedule.available_at <= $2
        ORDER BY schedule.available_at,schedule.admission_sequence,schedule.id
        LIMIT $3 FOR UPDATE OF schedule SKIP LOCKED`,
      admissionClass, current, limit,
    );
    const expired = [];
    const dormant = [];
    const canceled = [];
    const eligible = [];
    const deferred = [];
    for (const row of rows) {
      if (row.expiresAt && new Date(row.expiresAt) <= current) expired.push(row);
      else if (row.startOutcome === "NO_ACTIVE_RACES") dormant.push(row);
      else if (!row.sourceRef || !row.eventId || new Date(row.entitlementEndsAt) <= current ||
          row.startOutcome === "SKIPPED_STALE") canceled.push(row);
      else if (new Date(row.entitlementStartsAt) <= current && row.startProcessedAt && row.hasImpact) eligible.push(row);
      else deferred.push(row);
    }
    if (expired.length) {
      await tx.notificationSchedule.updateMany({
        where: { id: { in: expired.map((row) => row.id) }, status: ADMISSION_PENDING },
        data: { status: "EXPIRED", canceledAt: current, cancellationReason: "EXPIRED" },
      });
      await scheduleReceipt.markTerminalMany({
        rows: expired, terminalStatus: "EXPIRED", completedAt: current,
      }, tx);
    }
    if (canceled.length) {
      await tx.notificationSchedule.updateMany({
        where: { id: { in: canceled.map((row) => row.id) }, status: ADMISSION_PENDING },
        data: { status: "CANCELLED", canceledAt: current, cancellationReason: "INELIGIBLE_AT_BOUNDARY" },
      });
      await scheduleReceipt.markTerminalMany({
        rows: canceled, terminalStatus: "CANCELLED", completedAt: current,
      }, tx);
    }
    if (dormant.length) {
      await tx.notificationSchedule.updateMany({
        where: { id: { in: dormant.map((row) => row.id) }, status: ADMISSION_PENDING },
        data: {
          status: "CANCELLED_NO_ACTIVE_RACE", canceledAt: current,
          cancellationReason: "NO_ACTIVE_RACES",
        },
      });
      await scheduleReceipt.markTerminalMany({
        rows: dormant, terminalStatus: "CANCELLED_NO_ACTIVE_RACE", completedAt: current,
      }, tx);
    }
    if (deferred.length) {
      const deferrals = deferred.map((row) => {
        const startsAt = new Date(row.entitlementStartsAt);
        const expiresAt = row.expiresAt ? new Date(row.expiresAt) : null;
        const recoveryAt = startsAt > current
          ? startsAt
          : new Date(current.getTime() + ADMISSION_RECOVERY_DEFER_MS);
        return {
          id: row.id,
          availableAt: new Date(Math.min(
            recoveryAt.getTime(),
            expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
          )).toISOString(),
        };
      });
      await tx.$executeRawUnsafe(
        `UPDATE notification_schedules schedule
            SET available_at=input."availableAt",updated_at=$2
           FROM jsonb_to_recordset($1::jsonb)
             AS input(id text,"availableAt" timestamptz)
          WHERE schedule.id=input.id AND schedule.status='ADMISSION_PENDING'`,
        JSON.stringify(deferrals), current,
      );
    }
    if (eligible.length) {
      const inboxExpiry = new Date(current.getTime() + 30 * 24 * 60 * 60_000);
      const input = eligible.map((row) => ({
        id: row.id, recipientUserId: row.recipientUserId, type: row.type,
        title: row.title, body: row.body,
        destination: row.payload?.destination || { route: row.payload?.route === "home" ? "home" : "home" },
        deliveryKey: row.deliveryKey,
        outboxPayload: {
          title: row.title, body: row.body,
          destination: row.payload?.destination || { route: "home" },
          payload: row.payload,
        },
        admissionSequence: String(row.admissionSequence),
        admissionExpiresAt: new Date(row.expiresAt).toISOString(),
      }));
      await tx.$executeRawUnsafe(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS value(
             id text,"recipientUserId" text,type text,title text,body text,
             destination jsonb,"deliveryKey" text,"outboxPayload" jsonb,
             "admissionSequence" bigint,"admissionExpiresAt" timestamptz
           )
         ), inserted_alerts AS (
           INSERT INTO inbox_alerts (
             id,user_id,type,destination,title,body,source_key,created_at,expires_at
           )
           SELECT gen_random_uuid(),input."recipientUserId",input.type,input.destination,
                  input.title,input.body,input."deliveryKey",$2,$3
             FROM input ON CONFLICT (user_id,source_key) DO NOTHING
           RETURNING id,user_id,source_key
         ), all_alerts AS (
           SELECT id,user_id,source_key FROM inserted_alerts
           UNION ALL
           SELECT alert.id,alert.user_id,alert.source_key
             FROM inbox_alerts alert JOIN input
               ON alert.user_id=input."recipientUserId" AND alert.source_key=input."deliveryKey"
            WHERE NOT EXISTS (SELECT 1 FROM inserted_alerts inserted WHERE inserted.id=alert.id)
         ), inserted_outbox AS (
           INSERT INTO inbox_delivery_outbox (
             id,alert_id,kind,payload,status,attempt_count,available_at,accepted_tokens,
             created_at,updated_at,expires_at,admission_class,admission_sequence,admission_expires_at
           )
           SELECT gen_random_uuid(),alert.id,'PUSH',input."outboxPayload",'ADMISSION_FIRST',0,$2,
                  '[]'::jsonb,$2,$2,input."admissionExpiresAt",$4,input."admissionSequence",input."admissionExpiresAt"
             FROM all_alerts alert JOIN input
               ON alert.user_id=input."recipientUserId" AND alert.source_key=input."deliveryKey"
           ON CONFLICT (alert_id,kind) DO UPDATE SET
             admission_class=COALESCE(inbox_delivery_outbox.admission_class,EXCLUDED.admission_class),
             admission_sequence=COALESCE(inbox_delivery_outbox.admission_sequence,EXCLUDED.admission_sequence),
             admission_expires_at=COALESCE(inbox_delivery_outbox.admission_expires_at,EXCLUDED.admission_expires_at),
             expires_at=COALESCE(inbox_delivery_outbox.expires_at,EXCLUDED.expires_at),
             status=CASE
               WHEN inbox_delivery_outbox.admission_class IS NULL AND inbox_delivery_outbox.status='PENDING'
                 THEN 'ADMISSION_FIRST'
               WHEN inbox_delivery_outbox.admission_class IS NULL AND inbox_delivery_outbox.status='RETRY'
                 THEN 'ADMISSION_RETRY'
               WHEN inbox_delivery_outbox.admission_class IS NULL AND inbox_delivery_outbox.status='LEASED'
                    AND inbox_delivery_outbox.lease_until <= $2
                 THEN 'ADMISSION_RETRY'
               ELSE inbox_delivery_outbox.status
             END,
             lease_until=CASE
               WHEN inbox_delivery_outbox.admission_class IS NULL
                    AND (inbox_delivery_outbox.status IN ('PENDING','RETRY') OR
                      (inbox_delivery_outbox.status='LEASED' AND inbox_delivery_outbox.lease_until <= $2))
                 THEN NULL ELSE inbox_delivery_outbox.lease_until END,
             lease_token=CASE
               WHEN inbox_delivery_outbox.admission_class IS NULL
                    AND (inbox_delivery_outbox.status IN ('PENDING','RETRY') OR
                      (inbox_delivery_outbox.status='LEASED' AND inbox_delivery_outbox.lease_until <= $2))
                 THEN NULL ELSE inbox_delivery_outbox.lease_token END,
             updated_at=$2
         )
         UPDATE notification_schedules schedule
            SET status='MATERIALIZED',claimed_at=COALESCE(schedule.claimed_at,$2),
                released_at=$2,updated_at=$2
           FROM input WHERE schedule.id=input.id AND schedule.status='ADMISSION_PENDING'`,
        JSON.stringify(input), current, inboxExpiry, admissionClass,
      );
      await scheduleReceipt.markTerminalMany({
        rows: eligible, terminalStatus: "MATERIALIZED", completedAt: current,
      }, tx);
    }
    const next = await tx.notificationSchedule.findFirst({
      where: { admissionClass, status: ADMISSION_PENDING },
      orderBy: [{ availableAt: "asc" }, { admissionSequence: "asc" }, { id: "asc" }],
      select: { availableAt: true },
    });
    return {
      result: {
        examined: rows.length,
        materialized: eligible.length,
        expired: expired.length,
        deferred: deferred.length,
        nextScheduleAt: next?.availableAt || null,
      },
      canceled: canceled.length + dormant.length,
      recipientUserIds: eligible.map((row) => row.recipientUserId),
    };
  });
  const { result } = transactionResult;
  if (transactionResult.recipientUserIds.length && typeof invalidateUnreadBatch === "function") {
    // Postgres is authoritative and polling repairs a lost cache signal. A
    // Redis/cache outage must not turn committed alerts into a failed release.
    await invalidateUnreadBatch(transactionResult.recipientUserIds).catch(() => {});
  }
  try {
    telemetry?.recordNotification?.({
      materialized: result.materialized, expired: result.expired,
      canceled: transactionResult.canceled,
      schedulesPending: result.examined - result.materialized - result.expired - transactionResult.canceled,
    });
  } catch {}
  return result;
}

async function snapshotClaimedTargets(tx, claimedIds, current) {
  if (!claimedIds.length) return;
  // Upgrade pre-snapshot retry rows by matching their immutable token hash.
  // Accepted rows are left untouched; retryable rows retain their attempt
  // history while gaining the ownership fence used by the current worker.
  await tx.$executeRawUnsafe(
    `UPDATE inbox_delivery_device_attempts attempt
        SET device_token_id=token.id,recipient_user_id=token.user_id,
            installation_id=token.installation_id,
            ownership_generation=token.ownership_generation,
            platform=token.platform,provider_environment=token.provider_environment,
            updated_at=$2
       FROM inbox_delivery_outbox outbox
       JOIN inbox_alerts alert ON alert.id=outbox.alert_id
       JOIN device_tokens token ON token.user_id=alert.user_id
      WHERE attempt.outbox_id=outbox.id
        AND outbox.id=ANY($1::text[])
        AND attempt.recipient_user_id IS NULL
        AND attempt.token_hash=encode(digest(token.token,'sha256'),'hex')`,
    claimedIds, current,
  );
  await tx.$executeRawUnsafe(
    `WITH ranked AS (
       SELECT outbox.id AS outbox_id,token.id AS device_token_id,token.user_id,
              token.installation_id,token.ownership_generation,token.platform,
              token.provider_environment,encode(digest(token.token,'sha256'),'hex') AS token_hash,
              row_number() OVER (PARTITION BY outbox.id ORDER BY token.last_registered_at DESC,token.updated_at DESC,token.id DESC) AS ordinal
         FROM inbox_delivery_outbox outbox
         JOIN inbox_alerts alert ON alert.id=outbox.alert_id
         JOIN device_tokens token ON token.user_id=alert.user_id
        WHERE outbox.id=ANY($1::text[])
          AND (token.status='ACTIVE' OR token.status IS NULL)
          AND NOT EXISTS (
            SELECT 1 FROM inbox_delivery_device_attempts existing
             WHERE existing.outbox_id=outbox.id
          )
     )
     INSERT INTO inbox_delivery_device_attempts (
       id,outbox_id,token_hash,disposition,attempt_count,updated_at,
       device_token_id,recipient_user_id,installation_id,ownership_generation,
       platform,provider_environment
     )
     SELECT gen_random_uuid(),outbox_id,token_hash,'PENDING',0,$2,
            device_token_id,user_id,installation_id,ownership_generation,platform,provider_environment
       FROM ranked WHERE ordinal <= 10
     ON CONFLICT (outbox_id,token_hash) DO NOTHING`,
    claimedIds, current,
  );
  await tx.$executeRawUnsafe(
    `INSERT INTO inbox_delivery_device_attempts (
       id,outbox_id,token_hash,disposition,attempt_count,updated_at,recipient_user_id
     )
     SELECT gen_random_uuid(),outbox.id,'__NO_DEVICE__','NO_DEVICE',0,$2,alert.user_id
       FROM inbox_delivery_outbox outbox
       JOIN inbox_alerts alert ON alert.id=outbox.alert_id
      WHERE outbox.id=ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM inbox_delivery_device_attempts attempt WHERE attempt.outbox_id=outbox.id)
     ON CONFLICT (outbox_id,token_hash) DO NOTHING`,
    claimedIds, current,
  );
}

async function claimProviderAttemptPage({
  prisma,
  admissionClass = ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  now = new Date(),
  maximumRows = PROVIDER_ADMISSION_PAGE_SIZE,
  attemptsPerMinute = GLOBAL_EVENT_ATTEMPTS_PER_MINUTE,
  telemetry = null,
  invalidateUnreadBatch = null,
} = {}) {
  if (!prisma?.$transaction) throw new TypeError("prisma transaction client is required");
  const current = new Date(now);
  const limit = clampPageSize(maximumRows);
  const deltaMicros = tokenSpacingMicros(attemptsPerMinute);
  await reconcileLegacyGlobalEventAdmissionResidue({ prisma, now: current, maximumRows: limit });
  await releaseEventNotificationPage({
    prisma, admissionClass, now: current, maximumRows: limit, telemetry,
    invalidateUnreadBatch,
  });
  const result = await prisma.$transaction(async (tx) => {
    const lane = await lockNotificationAdmissionLane(tx, { admissionClass, now: current });
    let nextTokenAt = new Date(lane.nextTokenAt);
    const pageSpanMs = limit * deltaMicros / 1000;
    if (nextTokenAt.getTime() < current.getTime() - pageSpanMs) nextTokenAt = current;
    const available = nextTokenAt > current
      ? 0
      : Math.min(limit, 1 + Math.floor((current.getTime() - nextTokenAt.getTime()) * 1000 / deltaMicros));
    if (available < 1) return { claimed: [], nextTokenAt };

    const expiredRows = await tx.$queryRawUnsafe(
      `WITH expired AS (
         SELECT id FROM inbox_delivery_outbox
          WHERE admission_class=$1
            AND status IN ('ADMISSION_FIRST','ADMISSION_RETRY','ADMISSION_LEASED')
            AND admission_expires_at <= $2
          ORDER BY admission_expires_at,id LIMIT $3 FOR UPDATE SKIP LOCKED
       )
       UPDATE inbox_delivery_outbox outbox
          SET status='EXPIRED',lease_until=NULL,lease_token=NULL,
              last_error_code='NOTIFICATION_EXPIRED',updated_at=$2
         FROM expired WHERE outbox.id=expired.id
       RETURNING outbox.id`,
      admissionClass, current, limit,
    );
    if (expiredRows.length) {
      await tx.inboxDeliveryDeviceAttempt.updateMany({
        where: {
          outboxId: { in: expiredRows.map((row) => row.id) },
          disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] },
        },
        data: {
          disposition: "EXHAUSTED", nextAttemptAt: null,
          lastErrorCode: "NOTIFICATION_EXPIRED", updatedAt: current,
        },
      });
    }
    async function claimCandidates(kind, maximumAttempts, maximumCandidates) {
      if (maximumAttempts < 1 && kind !== ADMISSION_FIRST) return [];
      const candidates = kind === ADMISSION_FIRST
        ? await tx.$queryRawUnsafe(
          `SELECT id FROM inbox_delivery_outbox
            WHERE admission_class=$1 AND status='ADMISSION_FIRST'
              AND available_at <= $2 AND admission_expires_at > $2
            ORDER BY available_at,admission_sequence,id
            LIMIT $3 FOR UPDATE SKIP LOCKED`,
          admissionClass, current, maximumCandidates,
        )
        : await tx.$queryRawUnsafe(
          `WITH retry_candidates AS MATERIALIZED (
             SELECT id,available_at AS "dueAt",admission_sequence AS "admissionSequence"
               FROM inbox_delivery_outbox
              WHERE admission_class=$1 AND status='ADMISSION_RETRY'
                AND available_at <= $2 AND admission_expires_at > $2
              ORDER BY available_at,admission_sequence,id
              LIMIT $3 FOR UPDATE SKIP LOCKED
           ), lease_candidates AS MATERIALIZED (
             SELECT id,lease_until AS "dueAt",admission_sequence AS "admissionSequence"
               FROM inbox_delivery_outbox
              WHERE admission_class=$1 AND status='ADMISSION_LEASED'
                AND lease_until <= $2 AND admission_expires_at > $2
              ORDER BY lease_until,admission_sequence,id
              LIMIT $3 FOR UPDATE SKIP LOCKED
           )
           SELECT id FROM (
             SELECT * FROM retry_candidates
             UNION ALL
             SELECT * FROM lease_candidates
           ) bounded
           ORDER BY "dueAt","admissionSequence",id
           LIMIT $3`,
          admissionClass, current, maximumCandidates,
        );
      if (!candidates.length) return [];
      const candidateIds = candidates.map((row) => row.id);
      await snapshotClaimedTargets(tx, candidateIds, current);
      const costs = await tx.$queryRawUnsafe(
        `SELECT outbox.id,count(attempt.id)::int AS cost
           FROM inbox_delivery_outbox outbox
           LEFT JOIN inbox_delivery_device_attempts attempt
             ON attempt.outbox_id=outbox.id
            AND attempt.disposition IN ('PENDING','RETRY','TRANSIENT_FAIL','TIMEOUT')
            AND (attempt.next_attempt_at IS NULL OR attempt.next_attempt_at <= $2)
          WHERE outbox.id=ANY($1::text[])
          GROUP BY outbox.id`,
        candidateIds, current,
      );
      const costById = new Map(costs.map((row) => [row.id, Number(row.cost)]));
      const selected = [];
      let consumedAttempts = 0;
      for (const candidate of candidates) {
        const cost = costById.get(candidate.id) || 0;
        // Strict prefix admission preserves deterministic lane fairness. A
        // no-device row costs zero because it makes no provider request.
        if (consumedAttempts + cost > maximumAttempts) break;
        selected.push({ id: candidate.id, admissionCost: cost });
        consumedAttempts += cost;
      }
      if (!selected.length) return [];
      const leased = await tx.$queryRawUnsafe(
        `UPDATE inbox_delivery_outbox
            SET status='ADMISSION_LEASED',claimed_at=COALESCE(claimed_at,$2),
                lease_until=$2 + interval '30 seconds',lease_token=gen_random_uuid()::text,updated_at=$2
          WHERE id=ANY($1::text[])
          RETURNING id,lease_token AS "leaseToken"`,
        selected.map((row) => row.id), current,
      );
      const admissionCostById = new Map(selected.map((row) => [row.id, row.admissionCost]));
      return leased.map((row) => ({ ...row, admissionCost: admissionCostById.get(row.id) || 0 }));
    }

    const first = await claimCandidates(ADMISSION_FIRST, available, limit);
    let claimed = first;
    const firstCost = first.reduce((sum, row) => sum + row.admissionCost, 0);
    const remaining = available - firstCost;
    if (remaining > 0) {
      const dueSchedule = await tx.notificationSchedule.count({
        where: { admissionClass, status: ADMISSION_PENDING, availableAt: { lte: current } },
      });
      const dueFirst = await tx.inboxDeliveryOutbox.count({
        where: { admissionClass, status: ADMISSION_FIRST, availableAt: { lte: current }, admissionExpiresAt: { gt: current } },
      });
      if (dueSchedule === 0 && dueFirst === 0) {
        const retries = await claimCandidates(ADMISSION_RETRY, remaining, limit - first.length);
        claimed = claimed.concat(retries);
      }
    }
    const consumed = claimed.reduce((sum, row) => sum + row.admissionCost, 0);
    const advanced = new Date(nextTokenAt.getTime() + consumed * deltaMicros / 1000);
    await tx.notificationReleaseLane.update({
      where: { admissionClass },
      data: { nextTokenAt: advanced, updatedAt: current },
    });
    return { claimed, nextTokenAt: advanced };
  });
  if (result.claimed.length) {
    const rows = await prisma.inboxDeliveryOutbox.findMany({
      where: { id: { in: result.claimed.map((row) => row.id) } },
      include: {
        alert: {
          select: {
            userId: true,
            type: true,
            destination: true,
            sourceKey: true,
            user: { select: { isReviewAccount: true } },
          },
        },
        // The claim transaction has already snapshotted immutable targets.
        // Hydrate the whole admitted page in one bounded read instead of two
        // extra queries (attempts + tokens) for every recipient.
        deviceAttempts: {
          where: {
            disposition: { in: ["PENDING", "RETRY", "TRANSIENT_FAIL", "TIMEOUT"] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: current } }],
          },
          orderBy: { id: "asc" },
          include: { deviceToken: true },
        },
      },
    });
    const claimById = new Map(result.claimed.map((row) => [row.id, row]));
    result.claimed = rows.sort((left, right) => {
      const sequence = BigInt(left.admissionSequence) - BigInt(right.admissionSequence);
      return sequence < 0n ? -1 : sequence > 0n ? 1 : left.id.localeCompare(right.id);
    }).map((row) => ({ ...row, ...claimById.get(row.id) }));
  }
  // A boolean pending check paired only with nextTokenAt can create a zero-ms
  // timer loop when the lane token is stale but every pending row is scheduled
  // for the future. Read the first actual availability boundary instead. This
  // is still two bounded index reads, and lets Redis wakeups remain immediate.
  const [nextFirst, nextRetry, nextLeased, nextOutboxExpiry,
    nextSchedule, nextScheduleExpiry] = await Promise.all([
    prisma.inboxDeliveryOutbox.findFirst({
      where: {
        admissionClass,
        status: ADMISSION_FIRST,
        admissionExpiresAt: { gt: current },
      },
      select: { availableAt: true },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    }),
    prisma.inboxDeliveryOutbox.findFirst({
      where: { admissionClass, status: ADMISSION_RETRY, admissionExpiresAt: { gt: current } },
      select: { availableAt: true },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    }),
    prisma.inboxDeliveryOutbox.findFirst({
      where: { admissionClass, status: ADMISSION_LEASED, leaseUntil: { not: null } },
      select: { leaseUntil: true },
      orderBy: [{ leaseUntil: "asc" }, { id: "asc" }],
    }),
    prisma.inboxDeliveryOutbox.findFirst({
      where: {
        admissionClass,
        status: { in: [ADMISSION_FIRST, ADMISSION_RETRY, ADMISSION_LEASED] },
        admissionExpiresAt: { not: null },
      },
      select: { admissionExpiresAt: true },
      orderBy: [{ admissionExpiresAt: "asc" }, { id: "asc" }],
    }),
    prisma.notificationSchedule.findFirst({
      where: { admissionClass, status: ADMISSION_PENDING, expiresAt: { gt: current } },
      select: { availableAt: true },
      orderBy: [{ availableAt: "asc" }, { id: "asc" }],
    }),
    prisma.notificationSchedule.findFirst({
      where: { admissionClass, status: ADMISSION_PENDING, expiresAt: { not: null } },
      select: { expiresAt: true },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const available = [
    nextFirst?.availableAt,
    nextRetry?.availableAt,
    nextLeased?.leaseUntil,
    nextOutboxExpiry?.admissionExpiresAt,
    nextSchedule?.availableAt,
    nextScheduleExpiry?.expiresAt,
  ]
    .filter(Boolean)
    .map((value) => new Date(value))
    .sort((left, right) => left - right)[0] || null;
  result.hasPending = Boolean(available);
  result.nextAvailableAt = available;
  try {
    telemetry?.recordNotification?.({ providerClaimed: result.claimed.length });
    for (const row of result.claimed) {
      telemetry?.recordNotification?.({
        lagMs: Math.max(0, current.getTime() - new Date(row.availableAt).getTime()),
      });
    }
  } catch {}
  return result;
}

async function reconcileLegacyGlobalEventAdmissionResidue({
  prisma,
  now = new Date(),
  maximumRows = 500,
} = {}) {
  const current = new Date(now);
  const limit = clampPageSize(maximumRows);
  return prisma.$transaction(async (tx) => {
    await lockNotificationAdmissionLane(tx, {
      admissionClass: ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
      now: current,
    });
    const schedulesStamped = await tx.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT schedule.id,entitlement.ends_at
           FROM notification_schedules schedule
           JOIN global_step_event_entitlements entitlement ON entitlement.id=schedule.source_ref
          WHERE schedule.type='GLOBAL_EVENT_STARTED' AND schedule.status='PENDING'
          ORDER BY schedule.available_at,schedule.id LIMIT $2 FOR UPDATE OF schedule SKIP LOCKED
       )
       UPDATE notification_schedules schedule
          SET admission_class=$3,
              admission_sequence=(('x'||substr(encode(digest(schedule.delivery_key,'sha256'),'hex'),1,16))::bit(64)::bigint & 9223372036854775807),
              status='ADMISSION_PENDING',expires_at=LEAST(schedule.expires_at,candidates.ends_at-interval '60 seconds'),updated_at=$1
         FROM candidates WHERE schedule.id=candidates.id`,
      current, limit, ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
    );
    const outboxesStamped = await tx.$executeRawUnsafe(
      `WITH candidates AS (
         SELECT outbox.id,alert.source_key,schedule.expires_at AS schedule_expires_at,outbox.expires_at,
                outbox.status
           FROM inbox_delivery_outbox outbox
           JOIN inbox_alerts alert ON alert.id=outbox.alert_id
           LEFT JOIN notification_schedules schedule
             ON schedule.recipient_user_id=alert.user_id AND schedule.delivery_key=alert.source_key
          WHERE alert.type='GLOBAL_EVENT_STARTED'
            AND outbox.admission_class IS NULL
            AND COALESCE(schedule.expires_at,outbox.expires_at) IS NOT NULL
            AND (outbox.status IN ('PENDING','RETRY') OR (outbox.status='LEASED' AND outbox.lease_until <= $1))
          ORDER BY outbox.available_at,outbox.id LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED
       )
       UPDATE inbox_delivery_outbox outbox
          SET admission_class=$3,
              admission_sequence=(('x'||substr(encode(digest(candidates.source_key,'sha256'),'hex'),1,16))::bit(64)::bigint & 9223372036854775807),
              admission_expires_at=COALESCE(candidates.schedule_expires_at,candidates.expires_at-interval '60 seconds'),
              expires_at=COALESCE(candidates.schedule_expires_at,candidates.expires_at-interval '60 seconds'),
              status=CASE candidates.status WHEN 'PENDING' THEN 'ADMISSION_FIRST' ELSE 'ADMISSION_RETRY' END,
              lease_until=NULL,lease_token=NULL,updated_at=$1
         FROM candidates WHERE outbox.id=candidates.id`,
      current, limit, ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
    );
    const unexpired = await tx.inboxDeliveryOutbox.count({
      where: { alert: { type: "GLOBAL_EVENT_STARTED" }, admissionClass: null, status: "LEASED", leaseUntil: { gt: current } },
    });
    const scheduleResidue = await tx.notificationSchedule.count({
      where: { type: "GLOBAL_EVENT_STARTED", status: "PENDING" },
    });
    const outboxResidue = await tx.inboxDeliveryOutbox.count({
      where: { alert: { type: "GLOBAL_EVENT_STARTED" }, admissionClass: null, status: { in: ["PENDING", "RETRY", "LEASED"] } },
    });
    return {
      schedulesStamped: Number(schedulesStamped),
      outboxesStamped: Number(outboxesStamped),
      unexpiredLegacyLeases: unexpired,
      scheduleResidue,
      outboxResidue,
      residue: scheduleResidue + outboxResidue,
    };
  });
}

async function waitForNotificationAdmissionStartupBarrier({
  prisma,
  now = () => new Date(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maximumWaitMs = ADMISSION_LEASE_MS + 5_000,
  maximumRows = 500,
} = {}) {
  const started = new Date(now()).getTime();
  for (;;) {
    const current = new Date(now());
    const result = await reconcileLegacyGlobalEventAdmissionResidue({ prisma, now: current, maximumRows });
    if (result.residue === 0) return result;
    if (result.unexpiredLegacyLeases === 0) continue;
    if (current.getTime() - started >= maximumWaitMs) {
      const error = new Error("notification admission startup barrier timed out");
      error.code = "NOTIFICATION_ADMISSION_BARRIER_TIMEOUT";
      throw error;
    }
    await sleep(Math.min(250, maximumWaitMs - (current.getTime() - started)));
  }
}

module.exports = {
  ADMISSION_CLASS_GLOBAL_EVENT_STARTED,
  GLOBAL_EVENT_ATTEMPTS_PER_MINUTE,
  GLOBAL_EVENT_DELIVERY_WINDOW_MS,
  GLOBAL_EVENT_DELIVERY_SAFETY_MARGIN_MS,
  PROVIDER_ADMISSION_PAGE_SIZE,
  tokenSpacingMicros,
  admissionSequenceForDeliveryKey,
  ADMISSION_FIRST,
  ADMISSION_RETRY,
  ADMISSION_LEASED,
  ADMISSION_PENDING,
  ADMISSION_LEASE_MS,
  lockNotificationAdmissionLane,
  releaseEventNotificationPage,
  claimProviderAttemptPage,
  reconcileLegacyGlobalEventAdmissionResidue,
  waitForNotificationAdmissionStartupBarrier,
};
