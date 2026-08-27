const crypto = require("node:crypto");
const { prisma: defaultPrisma } = require("../../../db");

const EVENT_TERMINAL = ["COMPLETED", "SUPPRESSED", "FAILED_TERMINAL"];
const PROJECTION_TERMINAL = ["COMPLETED", "SUPPRESSED", "FAILED_TERMINAL"];

async function createEvent(tx, event) {
  return tx.domainEventOutbox.create({
    data: {
      eventKey: event.eventKey,
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: event.payload,
      occurredAt: event.occurredAt,
      availableAt: event.availableAt,
      audience: event.audience.length ? {
        create: event.audience.map(({ recipientId, ordinal, facts }) => ({
          recipientId, ordinal, facts,
        })),
      } : undefined,
    },
    include: { audience: { orderBy: { ordinal: "asc" } } },
  });
}

async function insertEventIfAbsent(tx, event) {
  const id = crypto.randomUUID();
  const inserted = await tx.$queryRawUnsafe(
    `INSERT INTO domain_event_outbox (
       id, event_key, event_type, schema_version, aggregate_type, aggregate_id,
       payload, occurred_at, available_at, status, created_at, updated_at
     ) VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'PENDING',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    id,
    event.eventKey,
    event.eventType,
    event.schemaVersion,
    event.aggregateType,
    event.aggregateId,
    JSON.stringify(event.payload),
    event.occurredAt,
    event.availableAt,
  );
  if (inserted.length === 1 && event.audience.length > 0) {
    await tx.domainEventAudience.createMany({
      data: event.audience.map(({ recipientId, ordinal, facts }) => ({
        domainEventId: id, recipientId, ordinal, facts,
      })),
    });
  }
  const stored = await findByEventKey(tx, event.eventKey);
  return { event: stored, inserted: inserted.length === 1 };
}

async function findByEventKey(tx, eventKey) {
  return tx.domainEventOutbox.findUnique({
    where: { eventKey },
    include: { audience: { orderBy: { ordinal: "asc" } } },
  });
}

async function claimEvents({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 25,
  leaseMs = 30_000,
} = {}) {
  const token = crypto.randomUUID();
  const limit = Math.min(100, Math.max(1, Number(batchSize) || 25));
  const leaseUntil = new Date(now.getTime() + leaseMs);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `WITH candidates AS (
         SELECT id, status
           FROM domain_event_outbox
          WHERE status IN ('PENDING','RETRY','EXPANDING')
            AND available_at <= $1
            AND (lease_until IS NULL OR lease_until <= $1)
          ORDER BY available_at ASC, occurred_at ASC, id ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE domain_event_outbox AS e
          SET status='EXPANDING', lease_token=$3, lease_until=$4,
              updated_at=$1
         FROM candidates
        WHERE e.id=candidates.id
       RETURNING e.id, (candidates.status='EXPANDING') AS reclaimed`,
      now, limit, token, leaseUntil,
    );
    return rows.map((row) => ({
      id: row.id,
      leaseToken: token,
      reclaimed: row.reclaimed === true,
    }));
  });
}

async function loadEventContext(prisma, id) {
  return prisma.domainEventOutbox.findUnique({
    where: { id },
    include: { audience: { orderBy: { ordinal: "asc" } } },
  });
}

async function loadAudiencePage(tx, {
  domainEventId,
  afterOrdinal = -1,
  batchSize = 100,
}) {
  return tx.domainEventAudience.findMany({
    where: { domainEventId, ordinal: { gt: afterOrdinal } },
    orderBy: { ordinal: "asc" },
    take: Math.min(100, Math.max(1, Number(batchSize) || 100)),
  });
}

async function persistExpansionPage(tx, {
  eventId,
  leaseToken,
  projections,
  nextCursor,
  expansionComplete,
  now,
}) {
  for (const projection of projections) {
    await tx.domainEventNotificationProjection.upsert({
      where: { domainEventId_recipientUserId_deliveryKey_projectionKind: {
        domainEventId: eventId,
        recipientUserId: projection.recipientUserId,
        deliveryKey: projection.deliveryKey,
        projectionKind: projection.projectionKind,
      } },
      update: {},
      create: {
        domainEventId: eventId,
        recipientUserId: projection.recipientUserId,
        deliveryKey: projection.deliveryKey,
        projectionKind: projection.projectionKind,
        availableAt: projection.availableAt,
        ...(projection.status ? { status: projection.status } : {}),
        ...(projection.reason ? { lastErrorCode: projection.reason } : {}),
        ...(projection.status === "SUPPRESSED" ? { completedAt: now } : {}),
      },
    });
  }
  const updated = await tx.domainEventOutbox.updateMany({
    where: { id: eventId, leaseToken },
    data: {
      expansionCursor: nextCursor == null ? null : String(nextCursor),
      ...(expansionComplete ? { expansionCompletedAt: now } : {}),
      leaseToken: null,
      leaseUntil: null,
      status: expansionComplete ? "PROJECTING" : "PENDING",
      lastErrorCode: null,
      lastErrorAt: null,
    },
  });
  return updated.count === 1;
}

async function claimProjections({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 50,
  leaseMs = 30_000,
} = {}) {
  const token = crypto.randomUUID();
  const limit = Math.min(50, Math.max(1, Number(batchSize) || 50));
  const leaseUntil = new Date(now.getTime() + leaseMs);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `WITH stranded_candidates AS MATERIALIZED (
         SELECT stranded.id
           FROM domain_event_outbox stranded
          WHERE stranded.status='PROJECTING'
            AND stranded.expansion_completed_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM domain_event_notification_projections remaining
               WHERE remaining.domain_event_id=stranded.id
                 AND remaining.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
            )
          ORDER BY stranded.occurred_at, stranded.id
          LIMIT 50
          FOR UPDATE OF stranded SKIP LOCKED
       ), repaired_events AS MATERIALIZED (
         UPDATE domain_event_outbox AS stranded
            SET status=CASE WHEN EXISTS (
                  SELECT 1
                    FROM domain_event_notification_projections failed
                   WHERE failed.domain_event_id=stranded.id
                     AND failed.status='FAILED_TERMINAL'
                ) THEN 'FAILED_TERMINAL' ELSE 'COMPLETED' END,
                completed_at=$1, lease_token=NULL, lease_until=NULL,
                updated_at=$1
           FROM stranded_candidates candidate
          WHERE stranded.id=candidate.id
         RETURNING stranded.id
       ), candidates AS (
         SELECT p.id, p.status
           FROM domain_event_notification_projections p
           JOIN domain_event_outbox e ON e.id=p.domain_event_id
          WHERE p.status IN ('PENDING','RETRY','PROCESSING')
            AND p.available_at <= $1
            AND (p.lease_until IS NULL OR p.lease_until <= $1)
            AND NOT EXISTS (
              SELECT 1
                FROM domain_event_outbox older
               WHERE older.aggregate_type=e.aggregate_type
                 AND older.aggregate_id=e.aggregate_id
                 AND older.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
                 AND (
                   older.expansion_completed_at IS NULL OR EXISTS (
                     SELECT 1
                       FROM domain_event_notification_projections older_projection
                      WHERE older_projection.domain_event_id=older.id
                        AND older_projection.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
                   )
                 )
                 AND (
                   older.occurred_at < e.occurred_at OR
                   (older.occurred_at=e.occurred_at AND older.id < e.id)
                 )
            )
          ORDER BY p.available_at ASC, e.occurred_at ASC, p.id ASC
          LIMIT $2
          FOR UPDATE OF p SKIP LOCKED
       )
       UPDATE domain_event_notification_projections AS p
          SET status='PROCESSING', lease_token=$3, lease_until=$4,
              updated_at=$1
         FROM candidates
        WHERE p.id=candidates.id
       RETURNING p.id, (candidates.status='PROCESSING') AS reclaimed`,
      now, limit, token, leaseUntil,
    );
    return rows.map((row) => ({
      id: row.id,
      leaseToken: token,
      reclaimed: row.reclaimed === true,
    }));
  });
}

// The daily global-event planner creates one single-recipient event per future
// entitlement. Running those records through the generic per-event expansion
// and per-recipient projection loop creates avoidable queue amplification at a
// timezone boundary. This bounded fast path preserves the same durable event,
// projection, and schedule records, but commits a page in one transaction.
// Events that do not match the exact trusted V1 envelope remain untouched and
// continue through the generic isolated/retryable projector.
async function projectScheduledEntitlementEventsBatch({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 100,
} = {}) {
  const limit = Math.min(100, Math.max(1, Number(batchSize) || 100));
  const rows = await prisma.$transaction((tx) => tx.$queryRawUnsafe(
    `WITH candidate_ids AS MATERIALIZED (
       SELECT event.id
         FROM domain_event_outbox event
        WHERE event.event_type='GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1'
          AND event.schema_version=1
          AND event.status IN ('PENDING','RETRY','EXPANDING')
          AND event.available_at <= $1
          AND (event.lease_until IS NULL OR event.lease_until <= $1)
          AND event.payload ?& ARRAY[
            'eventId','entitlementId','userId','startsAt','endsAt','scheduleRevision'
          ]
          AND jsonb_typeof(event.payload->'eventId')='string'
          AND jsonb_typeof(event.payload->'entitlementId')='string'
          AND jsonb_typeof(event.payload->'userId')='string'
          AND jsonb_typeof(event.payload->'startsAt')='string'
          AND jsonb_typeof(event.payload->'endsAt')='string'
          AND (event.payload->>'startsAt') ~
            '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$'
          AND (event.payload->>'endsAt') ~
            '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$'
          AND (event.payload->>'endsAt')::timestamp > $1
          AND event.aggregate_id=event.payload->>'entitlementId'
          AND EXISTS (
            SELECT 1
              FROM domain_event_audiences audience
              JOIN users recipient ON recipient.id=audience.recipient_id
             WHERE audience.domain_event_id=event.id
               AND audience.recipient_id=event.payload->>'userId'
             GROUP BY audience.domain_event_id
            HAVING count(*)=1
          )
          AND NOT EXISTS (
            SELECT 1
              FROM domain_event_outbox older
             WHERE older.aggregate_type=event.aggregate_type
               AND older.aggregate_id=event.aggregate_id
               AND older.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
               AND (older.occurred_at < event.occurred_at OR
                    (older.occurred_at=event.occurred_at AND older.id < event.id))
          )
        ORDER BY event.available_at ASC,event.occurred_at ASC,event.id ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     ), records AS MATERIALIZED (
       SELECT event.id AS event_id,event.available_at,event.payload,
              audience.recipient_id,
              CASE
                WHEN jsonb_typeof(event.payload->'multiplier')='number'
                  THEN (event.payload->>'multiplier')::numeric
                ELSE 2::numeric
              END AS multiplier,
              CASE
                WHEN jsonb_typeof(event.payload->'scheduleRevision')='number'
                  THEN (event.payload->>'scheduleRevision')::int
                ELSE 0
              END AS source_revision
         FROM candidate_ids candidate
         JOIN domain_event_outbox event ON event.id=candidate.id
         JOIN domain_event_audiences audience
           ON audience.domain_event_id=event.id
          AND audience.recipient_id=event.payload->>'userId'
     ), inserted_projections AS (
       INSERT INTO domain_event_notification_projections (
         id,domain_event_id,recipient_user_id,delivery_key,projection_kind,
         status,available_at,completed_at,created_at,updated_at
       )
       SELECT gen_random_uuid(),record.event_id,record.recipient_id,
              'visible:GLOBAL_EVENT_STARTED:' || record.recipient_id || ':' ||
                (record.payload->>'eventId'),
              'VISIBLE','COMPLETED',record.available_at,$1,$1,$1
         FROM records record
       ON CONFLICT (domain_event_id,recipient_user_id,delivery_key,projection_kind)
       DO NOTHING
       RETURNING domain_event_id
     ), upserted_schedules AS (
       INSERT INTO notification_schedules (
         id,recipient_user_id,type,title,body,payload,delivery_key,
         available_at,expires_at,status,source_ref,source_revision,created_at,updated_at
       )
       SELECT gen_random_uuid()::text,record.recipient_id,'GLOBAL_EVENT_STARTED',
              record.multiplier::text || 'x STEPS EVENT',
              'Double steps are LIVE for 30 minutes. Every step counts ' ||
                record.multiplier::text || 'x in your races! Go!',
              jsonb_build_object(
                'type','GLOBAL_EVENT_STARTED','route','home',
                'eventId',record.payload->>'eventId','multiplier',record.multiplier,
                'entitlementId',record.payload->>'entitlementId'
              ),
              'visible:GLOBAL_EVENT_STARTED:' || record.recipient_id || ':' ||
                (record.payload->>'eventId'),
              (record.payload->>'startsAt')::timestamp,
              (record.payload->>'endsAt')::timestamp,
              'PENDING',record.payload->>'entitlementId',record.source_revision,$1,$1
         FROM records record
       ON CONFLICT (recipient_user_id,delivery_key) DO UPDATE
         SET available_at=EXCLUDED.available_at,
             expires_at=EXCLUDED.expires_at,
             payload=EXCLUDED.payload,
             title=EXCLUDED.title,
             body=EXCLUDED.body,
             type=EXCLUDED.type,
             source_ref=EXCLUDED.source_ref,
             source_revision=EXCLUDED.source_revision,
             updated_at=EXCLUDED.updated_at
       WHERE notification_schedules.status='PENDING'
         AND notification_schedules.source_revision < EXCLUDED.source_revision
       RETURNING id
     ), completed_events AS (
       UPDATE domain_event_outbox event
          SET status='COMPLETED',expansion_cursor='0',expansion_completed_at=$1,
              completed_at=$1,lease_token=NULL,lease_until=NULL,
              last_error_code=NULL,last_error_at=NULL,updated_at=$1
         FROM candidate_ids candidate
        WHERE event.id=candidate.id
       RETURNING event.id
     )
     SELECT count(*)::int AS processed FROM completed_events`,
    now, limit,
  ));
  return { processed: Number(rows[0]?.processed || 0) };
}

// A restored or restarted worker can inherit a large placement-refresh backlog.
// Recipients without an eligible device have no provider side effect, so finish
// those projections in one bounded statement instead of paying the generic
// per-recipient Prisma/query cost. Rows with a usable device remain on the
// ordinary isolated/retryable provider path.
async function completeNoDevicePlacementProjectionsBatch({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 100,
} = {}) {
  const limit = Math.min(100, Math.max(1, Number(batchSize) || 100));
  const [row = {}] = await prisma.$transaction((tx) => tx.$queryRawUnsafe(
    `WITH candidate_ids AS MATERIALIZED (
       SELECT projection.id
         FROM domain_event_notification_projections projection
         JOIN domain_event_outbox event ON event.id=projection.domain_event_id
         JOIN domain_event_audiences audience
           ON audience.domain_event_id=event.id
          AND audience.recipient_id=projection.recipient_user_id
        WHERE event.event_type='PLACEMENT_CHANGED_V1'
          AND event.schema_version=1
          AND event.expansion_completed_at IS NOT NULL
          AND projection.projection_kind='SILENT_REFRESH'
          AND projection.status IN ('PENDING','RETRY','PROCESSING')
          AND projection.available_at <= $1
          AND (projection.lease_until IS NULL OR projection.lease_until <= $1)
          AND (
            NOT (event.payload ? 'endsAt') OR
            (jsonb_typeof(event.payload->'endsAt')='string' AND
             (event.payload->>'endsAt') ~
               '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$')
          )
          AND (
            NOT (audience.facts ? 'expiresAt') OR
            (jsonb_typeof(audience.facts->'expiresAt')='string' AND
             (audience.facts->>'expiresAt') ~
               '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$')
          )
          AND NOT EXISTS (
            SELECT 1 FROM device_tokens token
             WHERE token.user_id=projection.recipient_user_id
               AND (
                 token.status='ACTIVE' OR
                 (token.status IS NULL AND NOT EXISTS (
                   SELECT 1 FROM global_step_event_generation_state generation
                    WHERE generation.id=1 AND generation.quarantine_started_at IS NOT NULL
                 ))
               )
          )
        ORDER BY projection.available_at,event.occurred_at,projection.id
        LIMIT $2
        FOR UPDATE OF projection SKIP LOCKED
     ), records AS MATERIALIZED (
       SELECT projection.id,projection.domain_event_id,
              recipient.id IS NOT NULL AS recipient_exists,
              CASE WHEN event.payload ? 'endsAt'
                THEN (event.payload->>'endsAt')::timestamptz <= $1 ELSE false END
                AS event_expired,
              CASE WHEN audience.facts ? 'expiresAt'
                THEN (audience.facts->>'expiresAt')::timestamptz <= $1 ELSE false END
                AS audience_expired
         FROM candidate_ids candidate
         JOIN domain_event_notification_projections projection ON projection.id=candidate.id
         JOIN domain_event_outbox event ON event.id=projection.domain_event_id
         JOIN domain_event_audiences audience
           ON audience.domain_event_id=event.id
          AND audience.recipient_id=projection.recipient_user_id
         LEFT JOIN users recipient ON recipient.id=projection.recipient_user_id
     ), completed_projections AS (
       UPDATE domain_event_notification_projections projection
          SET status=CASE WHEN NOT record.recipient_exists OR
                                    record.event_expired OR record.audience_expired
                          THEN 'SUPPRESSED' ELSE 'COMPLETED' END,
              last_error_code=CASE WHEN NOT record.recipient_exists
                                     THEN 'RECIPIENT_DELETED'
                                   WHEN record.event_expired OR record.audience_expired
                                     THEN 'EVENT_EXPIRED'
                                   ELSE NULL END,
              lease_token=NULL,lease_until=NULL,completed_at=$1,updated_at=$1
         FROM records record
        WHERE projection.id=record.id
       RETURNING projection.id,projection.domain_event_id
     ), candidate_parents AS MATERIALIZED (
       SELECT DISTINCT domain_event_id FROM completed_projections
     ), completed_events AS (
       UPDATE domain_event_outbox event
          SET status=CASE WHEN EXISTS (
                SELECT 1 FROM domain_event_notification_projections failed
                 WHERE failed.domain_event_id=event.id
                   AND failed.status='FAILED_TERMINAL'
              ) THEN 'FAILED_TERMINAL' ELSE 'COMPLETED' END,
              completed_at=$1,lease_token=NULL,lease_until=NULL,updated_at=$1
         FROM candidate_parents parent
        WHERE event.id=parent.domain_event_id
          AND event.expansion_completed_at IS NOT NULL
          AND event.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
          AND NOT EXISTS (
            SELECT 1 FROM domain_event_notification_projections remaining
             WHERE remaining.domain_event_id=event.id
               AND remaining.status NOT IN ('COMPLETED','SUPPRESSED','FAILED_TERMINAL')
               AND NOT EXISTS (
                 SELECT 1 FROM completed_projections completed
                  WHERE completed.id=remaining.id
               )
          )
       RETURNING event.id
     )
     SELECT count(*)::int AS processed FROM completed_projections`,
    now,
    limit,
  ));
  return { processed: Number(row.processed || 0) };
}

// Mid-pack placement transitions have a pure SILENT_REFRESH classification:
// they neither claim a cooldown nor create a notification audit row. Expand
// that exact subset set-wise so a restart backlog does not allocate through
// thousands of generic Prisma transactions. First-place and possible payout
// transitions remain on the generic classifier path.
async function expandPureSilentPlacementEventsBatch({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 100,
} = {}) {
  const limit = Math.min(100, Math.max(1, Number(batchSize) || 100));
  const [row = {}] = await prisma.$transaction((tx) => tx.$queryRawUnsafe(
    `WITH candidate_ids AS MATERIALIZED (
       SELECT event.id
         FROM domain_event_outbox event
        WHERE event.event_type='PLACEMENT_CHANGED_V1'
          AND event.schema_version=1
          AND event.status IN ('PENDING','RETRY','EXPANDING')
          AND event.available_at <= $1
          AND (event.lease_until IS NULL OR event.lease_until <= $1)
          AND event.expansion_cursor IS NULL
          AND event.expansion_completed_at IS NULL
          AND jsonb_typeof(event.payload->'transitionId')='string'
          AND jsonb_typeof(event.payload->'raceId')='string'
          AND jsonb_typeof(event.payload->'previousPlacement')='number'
          AND jsonb_typeof(event.payload->'placement')='number'
          AND (event.payload->>'previousPlacement')::numeric > 1
          AND (event.payload->>'placement')::numeric > 1
          AND (
            COALESCE(jsonb_typeof(event.payload->'paidPlaces') <> 'number',true)
            OR (event.payload->>'paidPlaces')::numeric <= 0
            OR (event.payload->>'previousPlacement')::numeric >
               (event.payload->>'paidPlaces')::numeric
            OR (event.payload->>'placement')::numeric <=
               (event.payload->>'paidPlaces')::numeric
          )
          AND NOT EXISTS (
            SELECT 1 FROM domain_event_notification_projections projection
             WHERE projection.domain_event_id=event.id
          )
          AND 1=(SELECT count(*) FROM domain_event_audiences audience
                  WHERE audience.domain_event_id=event.id)
        ORDER BY event.available_at,event.occurred_at,event.id
        LIMIT $2
        FOR UPDATE OF event SKIP LOCKED
     ), records AS MATERIALIZED (
       SELECT event.id AS event_id,event.available_at,event.payload,
              audience.recipient_id,audience.ordinal
         FROM candidate_ids candidate
         JOIN domain_event_outbox event ON event.id=candidate.id
         JOIN domain_event_audiences audience ON audience.domain_event_id=event.id
     ), inserted_projections AS (
       INSERT INTO domain_event_notification_projections (
         id,domain_event_id,recipient_user_id,delivery_key,projection_kind,
         status,available_at,created_at,updated_at
       )
       SELECT gen_random_uuid(),record.event_id,record.recipient_id,
              'silent:PLACEMENT_CHANGED:' || (record.payload->>'transitionId') || ':' ||
                record.recipient_id,
              'SILENT_REFRESH','PENDING',record.available_at,$1,$1
         FROM records record
       RETURNING domain_event_id
     ), expanded_events AS (
       UPDATE domain_event_outbox event
          SET status='PROJECTING',
              expansion_cursor=record.ordinal::text,
              expansion_completed_at=$1,
              lease_token=NULL,lease_until=NULL,last_error_code=NULL,last_error_at=NULL,
              updated_at=$1
         FROM records record
        WHERE event.id=record.event_id
       RETURNING event.id
     )
     SELECT count(*)::int AS processed FROM expanded_events`,
    now,
    limit,
  ));
  return { processed: Number(row.processed || 0) };
}

async function loadProjectionContext(prisma, projectionId) {
  return prisma.domainEventNotificationProjection.findUnique({
    where: { id: projectionId },
    include: {
      event: {
        include: { audience: { orderBy: { ordinal: "asc" } } },
      },
    },
  });
}

async function finishProjection(prisma, {
  id, leaseToken, status, errorCode = null, availableAt = null, now = new Date(),
  incrementAttempt = false,
}) {
  const terminal = PROJECTION_TERMINAL.includes(status);
  return prisma.domainEventNotificationProjection.updateMany({
    where: { id, leaseToken, status: "PROCESSING" },
    data: {
      status,
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: errorCode,
      ...(incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      ...(availableAt ? { availableAt } : {}),
      ...(terminal ? { completedAt: now } : {}),
    },
  });
}

async function finishEventIfTerminal(prisma, eventId, now = new Date()) {
  return prisma.$transaction(async (tx) => {
    const event = await tx.domainEventOutbox.findUnique({
      where: { id: eventId },
      select: { expansionCompletedAt: true, status: true },
    });
    if (!event?.expansionCompletedAt || EVENT_TERMINAL.includes(event.status)) return false;
    const remaining = await tx.domainEventNotificationProjection.count({
      where: { domainEventId: eventId, status: { notIn: PROJECTION_TERMINAL } },
    });
    if (remaining > 0) return false;
    const failures = await tx.domainEventNotificationProjection.count({
      where: { domainEventId: eventId, status: "FAILED_TERMINAL" },
    });
    const updated = await tx.domainEventOutbox.updateMany({
      where: { id: eventId, status: { notIn: EVENT_TERMINAL } },
      data: {
        status: failures ? "FAILED_TERMINAL" : "COMPLETED",
        completedAt: now,
        leaseToken: null,
        leaseUntil: null,
      },
    });
    return updated.count === 1;
  });
}

async function failEvent(prisma, {
  id, leaseToken, status, errorCode, retryAt = null, availableAt = null, now = new Date(),
  incrementAttempt = false,
}) {
  // availableAt is an immutable occurrence fact. Older internal callers used
  // that argument as their retry timestamp, so accept it as an alias while
  // storing the coordination delay only in the mutable lease window.
  const retryNotBefore = retryAt || availableAt;
  return prisma.domainEventOutbox.updateMany({
    where: { id, leaseToken },
    data: {
      status,
      leaseToken: null,
      leaseUntil: status === "RETRY" ? retryNotBefore : null,
      lastErrorCode: errorCode,
      lastErrorAt: now,
      ...(incrementAttempt ? { attemptCount: { increment: 1 } } : {}),
      ...(status === "FAILED_TERMINAL" ? { completedAt: now } : {}),
    },
  });
}

function withTransaction(prisma, operation) {
  return prisma.$transaction(operation);
}

async function loadRecipient(prisma, userId) {
  return prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
}

async function loadRaceMessage(prisma, messageId) {
  return prisma.raceMessage.findUnique({
    where: { id: messageId },
    select: { body: true, deletedAt: true },
  });
}

async function loadSupportProjectionFacts(prisma, { userId, messageId, threadId }) {
  const [user, message, thread] = await Promise.all([
    loadRecipient(prisma, userId),
    prisma.feedbackMessage.findUnique({ where: { id: messageId } }),
    prisma.feedbackThread.findUnique({ where: { id: threadId } }),
  ]);
  return { user, message, thread };
}

async function withHighMultiplierRecipientLock(prisma, recipientUserId, operation) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`high-multiplier-projection:${recipientUserId}`}))`;
    return operation(tx);
  });
}

async function findRecentHighMultiplierNotification(tx, recipientUserId, since) {
  return tx.notification.findFirst({
    where: {
      userId: recipientUserId,
      type: "HIGH_MULTIPLIER_ALERT",
      createdAt: { gte: since },
    },
    select: { id: true, deliveryKey: true },
  });
}

async function loadUserDisplayName(tx, userId) {
  return tx.user.findUnique({
    where: { id: userId },
    select: { displayName: true },
  });
}

async function createHighMultiplierNotificationAudit(tx, data) {
  return tx.notification.create({ data });
}

async function readHealthSnapshot(prisma = defaultPrisma) {
  const [pendingByType, projectionByStatus, oldestEvent, oldestProjection, downstream, terminalFailures] = await Promise.all([
    prisma.domainEventOutbox.groupBy({
      by: ["eventType"],
      where: { status: { in: ["PENDING", "RETRY", "EXPANDING", "PROJECTING"] } },
      _count: { _all: true },
      _min: { availableAt: true },
    }),
    prisma.domainEventNotificationProjection.groupBy({
      by: ["status"], _count: { _all: true }, _min: { availableAt: true },
    }),
    prisma.domainEventOutbox.findFirst({
      where: { status: { in: ["PENDING", "RETRY", "EXPANDING", "PROJECTING"] } },
      orderBy: { availableAt: "asc" }, select: { id: true, eventType: true, availableAt: true },
    }),
    prisma.domainEventNotificationProjection.findFirst({
      where: { status: { in: ["PENDING", "RETRY", "PROCESSING"] } },
      orderBy: { availableAt: "asc" }, select: { id: true, availableAt: true },
    }),
    Promise.all([
      prisma.notificationSchedule.count({ where: { status: { in: ["PENDING", "CLAIMED"] } } }),
      prisma.inboxDeliveryOutbox.count({ where: { status: { in: ["PENDING", "RETRY", "LEASED"] } } }),
    ]),
    Promise.all([
      prisma.domainEventOutbox.count({ where: { status: "FAILED_TERMINAL" } }),
      prisma.domainEventNotificationProjection.count({ where: { status: "FAILED_TERMINAL" } }),
    ]),
  ]);
  return { pendingByType, projectionByStatus, oldestEvent, oldestProjection, downstream, terminalFailures };
}

async function findRetentionCandidates(prisma = defaultPrisma, { cutoff, pageSize }) {
  return prisma.domainEventOutbox.findMany({
    where: {
      status: { in: ["COMPLETED", "SUPPRESSED"] },
      completedAt: { lte: cutoff },
      projections: { every: { status: { in: ["COMPLETED", "SUPPRESSED"] } } },
    },
    orderBy: [{ completedAt: "asc" }, { id: "asc" }],
    take: pageSize,
    include: { projections: { select: { deliveryKey: true } } },
  });
}

async function countActiveDownstream(prisma = defaultPrisma, deliveryKeys = []) {
  if (!deliveryKeys.length) {
    return { schedules: 0, inboxOutbox: 0, deviceAttempts: 0 };
  }
  const [schedules, inboxOutbox, deviceAttempts] = await Promise.all([
    prisma.notificationSchedule.count({
      where: { deliveryKey: { in: deliveryKeys }, status: { notIn: ["MATERIALIZED", "EXPIRED", "CANCELLED", "DELIVERED", "EXHAUSTED"] } },
    }),
    prisma.inboxDeliveryOutbox.count({
      where: {
        alert: { sourceKey: { in: deliveryKeys } },
        status: { notIn: ["MATERIALIZED", "EXPIRED", "CANCELLED", "DELIVERED", "EXHAUSTED"] },
      },
    }),
    prisma.inboxDeliveryDeviceAttempt.count({
      where: {
        outbox: { alert: { sourceKey: { in: deliveryKeys } } },
        disposition: { notIn: [
          "ACCEPTED", "UNREGISTERED", "INVALID", "QUARANTINED",
          "SUPERSEDED", "OWNERSHIP_CHANGED", "PERMANENT_FAIL",
          "EXHAUSTED", "NO_DEVICE",
        ] },
      },
    }),
  ]);
  return { schedules, inboxOutbox, deviceAttempts };
}

async function deleteRetainedEvent(prisma = defaultPrisma, { id, cutoff }) {
  return prisma.domainEventOutbox.deleteMany({
    where: {
      id,
      status: { in: ["COMPLETED", "SUPPRESSED"] },
      completedAt: { lte: cutoff },
      projections: { every: { status: { in: ["COMPLETED", "SUPPRESSED"] } } },
    },
  });
}

async function replayTerminal(prisma = defaultPrisma, { eventIds, projectionIds, now }) {
  return prisma.$transaction(async (tx) => {
    const uniqueEventIds = [...new Set(eventIds)];
    const uniqueProjectionIds = [...new Set(projectionIds)];
    const failedEvents = uniqueEventIds.length ? await tx.domainEventOutbox.findMany({
      where: { id: { in: uniqueEventIds }, status: "FAILED_TERMINAL" },
      select: { id: true, expansionCompletedAt: true },
    }) : [];
    const failedEventIds = failedEvents.map((row) => row.id);
    const explicitProjections = uniqueProjectionIds.length
      ? await tx.domainEventNotificationProjection.findMany({
        where: { id: { in: uniqueProjectionIds }, status: "FAILED_TERMINAL" },
        select: { id: true, domainEventId: true },
      })
      : [];
    const failedChildren = failedEventIds.length
      ? await tx.domainEventNotificationProjection.findMany({
        where: { domainEventId: { in: failedEventIds }, status: "FAILED_TERMINAL" },
        select: { id: true, domainEventId: true },
      })
      : [];
    const projectionRows = new Map(
      [...explicitProjections, ...failedChildren].map((row) => [row.id, row]),
    );
    const ambiguous = failedEvents.filter((event) =>
      event.expansionCompletedAt &&
      !failedChildren.some((projection) => projection.domainEventId === event.id));
    if (ambiguous.length) {
      throw new Error(`cannot replay terminal event without a failed child: ${ambiguous[0].id}`);
    }

    const affectedParentIds = [...new Set([
      ...failedEventIds,
      ...[...projectionRows.values()].map((row) => row.domainEventId),
    ])];
    const affectedParents = affectedParentIds.length
      ? await tx.domainEventOutbox.findMany({
        where: { id: { in: affectedParentIds } },
        select: { id: true, expansionCompletedAt: true },
      })
      : [];

    const projectionReset = projectionRows.size
      ? await tx.domainEventNotificationProjection.updateMany({
        where: { id: { in: [...projectionRows.keys()] }, status: "FAILED_TERMINAL" },
        data: {
          status: "PENDING", availableAt: now, completedAt: null,
          leaseToken: null, leaseUntil: null, lastErrorCode: null,
          attemptCount: 0,
        },
      })
      : { count: 0 };
    // Replay must re-enter the queue that owns the unfinished work. A parent
    // with an incomplete audience expansion is always PENDING, even when a
    // previously materialized child is also being reset. PROJECTING parents
    // are reserved for events whose expansion durably completed.
    const pendingEventIds = affectedParents
      .filter((row) => !row.expansionCompletedAt)
      .map((row) => row.id);
    const projectingParentIds = affectedParents
      .filter((row) => row.expansionCompletedAt)
      .map((row) => row.id);
    if (pendingEventIds.length) {
      await tx.domainEventOutbox.updateMany({
        where: { id: { in: pendingEventIds } },
        data: {
          status: "PENDING", completedAt: null, leaseToken: null, leaseUntil: null,
          lastErrorCode: null, lastErrorAt: null, attemptCount: 0,
        },
      });
    }
    if (projectingParentIds.length) {
      await tx.domainEventOutbox.updateMany({
        where: { id: { in: projectingParentIds } },
        data: {
          status: "PROJECTING", completedAt: null, leaseToken: null, leaseUntil: null,
          lastErrorCode: null, lastErrorAt: null, attemptCount: 0,
        },
      });
    }
    return { events: failedEvents.length, projections: projectionReset.count };
  });
}

module.exports = {
  EVENT_TERMINAL,
  PROJECTION_TERMINAL,
  createEvent,
  insertEventIfAbsent,
  findByEventKey,
  claimEvents,
  loadEventContext,
  loadAudiencePage,
  persistExpansionPage,
  claimProjections,
  projectScheduledEntitlementEventsBatch,
  expandPureSilentPlacementEventsBatch,
  completeNoDevicePlacementProjectionsBatch,
  loadProjectionContext,
  finishProjection,
  finishEventIfTerminal,
  failEvent,
  withTransaction,
  loadRecipient,
  loadRaceMessage,
  loadSupportProjectionFacts,
  withHighMultiplierRecipientLock,
  findRecentHighMultiplierNotification,
  loadUserDisplayName,
  createHighMultiplierNotificationAudit,
  readHealthSnapshot,
  findRetentionCandidates,
  countActiveDownstream,
  deleteRetainedEvent,
  replayTerminal,
};
