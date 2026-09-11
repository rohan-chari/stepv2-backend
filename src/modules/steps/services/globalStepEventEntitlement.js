const { entitlementsChanged } = require('./eventDisplayCacheInvalidation');
const {
  FALLBACK_EVENT_TIMEZONE,
  LOCAL_ENTITLEMENTS,
  localEventWindowForZone,
} = require("../globalStepEvent");
const { isValidIanaTimeZone } = require("../../users/services/globalEventTimezone");
const {
  prisma: defaultPrisma,
  runInPrismaTransaction,
  deferUntilAfterCommit,
  isInPrismaTransactionScope,
} = require("../../../db");
const redisCache = require("../../../shared/cache/redisCache");
const {
  appendDomainEvent: defaultAppendDomainEvent,
  bulkAppendDomainEvents,
} = require("../../domainEvents");
const { DomainEventReceipt } = require("../../domainEvents/models/domainEventReceipt");
// Historical raw INSERT INTO domain_event_outbox production path was replaced
// by bulkAppendDomainEvents. Its old deferUntilAfterCommit publishDurableQueueWakeup("domain-event")
// ordering remains part of the compatibility contract and is now owned by the
// shared command.
const {
  enqueueRaceResolutionForUser: defaultEnqueueRaceResolutionForUser,
} = require("../../races/services/enqueueRaceResolution");
const {
  acquireRaceWriteFences,
  acquireRaceWriteFencesSetBased,
} = require("../../races/services/raceWriteFence");
const { isGenerationUsable } = require("../models/globalStepEventGeneration");
const { RaceResolutionJobV2 } = require("../../races/models/raceResolutionJobV2");

const START_OUTCOMES = Object.freeze({
  PENDING: "PENDING",
  ACTIVATED_ON_TIME: "ACTIVATED_ON_TIME",
  ACTIVATED_LATE_JOIN: "ACTIVATED_LATE_JOIN",
  NO_ACTIVE_RACES: "NO_ACTIVE_RACES",
  SKIPPED_STALE: "SKIPPED_STALE",
});

function eventsForUser(eventsByUserId, userId) {
  if (!eventsByUserId || !userId) return [];
  if (eventsByUserId instanceof Map) return eventsByUserId.get(userId) || [];
  return eventsByUserId[userId] || [];
}

async function invalidateHomeActiveGlobalEvent(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return false;
  try {
    await entitlementsChanged(ids);
    return true;
  } catch {
    return false;
  }
}

function normalizedEntitlementEvent(event, entitlement, impact = null) {
  return {
    id: event.id,
    eventId: event.id,
    entitlementId: entitlement.id,
    impactId: impact?.id || null,
    startsAt: entitlement.startsAt,
    endsAt: entitlement.endsAt,
    multiplier: event.multiplier,
    scheduleMode: LOCAL_ENTITLEMENTS,
  };
}

async function appendScheduledEntitlementEvent(tx, {
  event,
  entitlement,
  occurredAt = new Date(),
  appendDomainEvent = defaultAppendDomainEvent,
}) {
  if (!event || !entitlement) return null;
  return appendDomainEvent(tx, {
    eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:${entitlement.scheduleRevision || 0}`,
    eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
    schemaVersion: 1,
    aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
    aggregateId: entitlement.id,
    occurredAt,
    availableAt: occurredAt,
    payload: {
      eventId: event.id,
      entitlementId: entitlement.id,
      userId: entitlement.userId,
      multiplier: event.multiplier,
      startsAt: entitlement.startsAt,
      endsAt: entitlement.endsAt,
      scheduleRevision: entitlement.scheduleRevision || 0,
      timezone: entitlement.timezone,
    },
    audience: [{ recipientId: entitlement.userId, facts: {} }],
  });
}

async function appendScheduledEntitlementEventsBatch(tx, {
  entitlements,
  event = null,
  occurredAt = new Date(),
} = {}) {
  const rows = (entitlements || []).map((entitlement) => {
    const parent = entitlement.event || event;
    if (!parent) throw new Error("scheduled entitlement batch requires its parent event");
    return {
      eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:${entitlement.scheduleRevision || 0}`,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
      schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
      aggregateId: entitlement.id,
      occurredAt,
      availableAt: occurredAt,
      projectionCount: 0,
      terminalProjectionCount: 0,
      failedProjectionCount: 0,
      projectionCountsValidAt: occurredAt,
      payload: {
        eventId: parent.id,
        entitlementId: entitlement.id,
        userId: entitlement.userId,
        multiplier: parent.multiplier,
        startsAt: new Date(entitlement.startsAt).toISOString(),
        endsAt: new Date(entitlement.endsAt).toISOString(),
        scheduleRevision: entitlement.scheduleRevision || 0,
        timezone: entitlement.timezone,
      },
      audience: [{ recipientId: entitlement.userId, ordinal: 0, facts: {} }],
    };
  });
  if (!rows.length) return 0;
  const appended = await appendRecoverableEntitlementEvents(tx, rows);
  // receiptOnly is a subset of replayed, not another processed event.
  return appended.inserted + appended.replayed;
}

async function appendRecoverableEntitlementEvents(tx, rows) {
  const receipts = await tx.domainEventReceipt.findMany({
    where: { eventKey: { in: rows.map(row => row.eventKey) } },
  });
  const receiptByKey = new Map(receipts.map(receipt => [receipt.eventKey, receipt]));
  const liveKeys = receipts.length ? new Set((await tx.domainEventOutbox.findMany({
    where: { eventKey: { in: receipts.map(receipt => receipt.eventKey) } },
    select: { eventKey: true },
  })).map(row => row.eventKey)) : new Set();
  const missing = [];
  for (const row of rows) {
    const receipt = receiptByKey.get(row.eventKey);
    if (!receipt) continue;
    // A retained receipt owns the original identity and both timestamps. A
    // reconciliation clock must never become part of this immutable envelope.
    row.occurredAt = receipt.occurredAt;
    row.availableAt = receipt.availableAt;
    // Legacy provisional receipts can still be finalized from a live outbox,
    // but are insufficient evidence to reconstruct a missing publication.
    if (receipt.receiptState === "FINAL" || !liveKeys.has(row.eventKey)) {
      DomainEventReceipt.assertEnvelope(receipt, row);
      DomainEventReceipt.assertIdentity(receipt, {
        domainEventId: receipt.domainEventId,
        replaySourceType: row.aggregateType,
        replaySourceId: row.aggregateId,
      });
    }
    if (!liveKeys.has(row.eventKey) && receipt.terminalStatus == null) {
      missing.push({ ...row, id: receipt.domainEventId });
    }
  }
  let restored = 0;
  if (missing.length) {
    const inserted = await tx.domainEventOutbox.createMany({
      data: missing.map(({ audience: _audience, ...row }) => ({
        ...row, projectionCount: 0, terminalProjectionCount: 0,
        failedProjectionCount: 0, projectionCountsValidAt: new Date(),
      })),
      skipDuplicates: true,
    });
    restored = inserted.count;
    await tx.domainEventAudience.createMany({
      data: missing.flatMap(row => row.audience.map(audience => ({
        ...audience, domainEventId: row.id,
      }))),
      skipDuplicates: true,
    });
  }
  // Shared append verifies the live rows, their audience and FINAL receipts
  // before this transaction can commit. Terminal receipts stay receipt-only.
  const appended = await bulkAppendDomainEvents(tx, rows);
  if (restored && !appended.inserted) {
    await deferUntilAfterCommit(() => redisCache.publishDurableQueueWakeup("domain-event"));
  }
  return appended;
}

async function materializePreparedEntitlementsSetBased(tx, {
  event,
  prepared,
  occurredAt,
  generationReady,
} = {}) {
  const rows = prepared.map(({ fallback, ...row }) => ({
    ...row,
    startsAt: new Date(row.startsAt).toISOString(),
    endsAt: new Date(row.endsAt).toISOString(),
  }));
  if (!rows.length) return { created: 0, selected: 0, events: 0 };
  const [result = {}] = await tx.$queryRawUnsafe(
    `WITH input AS MATERIALIZED (
       SELECT record."userId" AS user_id,record.timezone,
              record."localDate" AS local_date,
              record."startsAt"::timestamptz AT TIME ZONE 'UTC' AS starts_at,
              record."endsAt"::timestamptz AT TIME ZONE 'UTC' AS ends_at
         FROM jsonb_to_recordset($1::jsonb) AS record(
           "userId" text,timezone text,"localDate" text,"startsAt" text,"endsAt" text
         )
     ), inserted_entitlements AS (
       INSERT INTO global_step_event_entitlements (
         id,event_id,user_id,timezone,local_date,starts_at,ends_at,
         start_outcome,schedule_revision,start_attempt_count,created_at,updated_at
       )
       SELECT gen_random_uuid()::text,$2,input.user_id,input.timezone,input.local_date,
              input.starts_at,input.ends_at,'PENDING',0,0,$4,$4
         FROM input
       ON CONFLICT (event_id,user_id) DO NOTHING
       RETURNING id,event_id,user_id,timezone,local_date,starts_at,ends_at,schedule_revision
     ), selected_entitlements AS MATERIALIZED (
       SELECT * FROM inserted_entitlements
       UNION ALL
       SELECT existing.id,existing.event_id,existing.user_id,existing.timezone,
              existing.local_date,existing.starts_at,existing.ends_at,
              existing.schedule_revision
         FROM global_step_event_entitlements existing
         JOIN input ON input.user_id=existing.user_id
        WHERE existing.event_id=$2
          AND NOT EXISTS (
            SELECT 1 FROM inserted_entitlements inserted
             WHERE inserted.user_id=existing.user_id
          )
     ), event_records AS MATERIALIZED (
       SELECT entitlement.*,
              'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:' || entitlement.id || ':' ||
                entitlement.schedule_revision::text AS event_key,
              jsonb_build_object(
                'eventId',$2,'entitlementId',entitlement.id,'userId',entitlement.user_id,
                'multiplier',$3::double precision,
                'startsAt',to_char(entitlement.starts_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'endsAt',to_char(entitlement.ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                'scheduleRevision',entitlement.schedule_revision,
                'timezone',entitlement.timezone
              ) AS event_payload
         FROM selected_entitlements entitlement
        WHERE $5::boolean
     )
     SELECT (SELECT count(*)::int FROM inserted_entitlements) AS created,
            (SELECT count(*)::int FROM selected_entitlements) AS selected,
            (SELECT count(*)::int FROM event_records) AS events,
            COALESCE((SELECT jsonb_agg(jsonb_build_object(
              'eventKey',event_key,
              'aggregateId',id,
              'eventId',$2,
              'userId',user_id,
              'multiplier',$3::double precision,
              'startsAt',to_char(starts_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'endsAt',to_char(ends_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'scheduleRevision',schedule_revision,
              'timezone',timezone
            ) ORDER BY event_key) FROM event_records), '[]'::jsonb) AS "eventRows"`,
    JSON.stringify(rows),
    event.id,
    event.multiplier,
    occurredAt,
    generationReady === true,
  );
  const counts = {
    created: Number(result.created || 0),
    selected: Number(result.selected || 0),
    events: Number(result.events || 0),
  };
  if (counts.selected !== rows.length ||
      (generationReady && counts.events !== rows.length)) {
    throw new Error("set-based entitlement materialization found conflicting immutable facts");
  }
  if (generationReady && counts.events > 0) {
    let eventInputs = (result.eventRows || []).map((row) => ({
      eventKey: row.eventKey,
      eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
      schemaVersion: 1,
      aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
      aggregateId: row.aggregateId,
      occurredAt,
      availableAt: occurredAt,
      payload: {
        eventId: row.eventId,
        entitlementId: row.aggregateId,
        userId: row.userId,
        multiplier: row.multiplier,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        scheduleRevision: row.scheduleRevision,
        timezone: row.timezone,
      },
      audience: [{ recipientId: row.userId, ordinal: 0, facts: {} }],
    }));
    // Keep injected/local legacy transaction doubles working while they adopt
    // the shared command. Production transactions always return eventRows and
    // always expose the receipt model.
    if (!eventInputs.length && Array.isArray(result.eventKeys)) {
      const stored = await tx.domainEventOutbox.findMany({
        where: { eventKey: { in: result.eventKeys } },
        include: { audience: { orderBy: { ordinal: "asc" } } },
      });
      eventInputs = stored.map((record) => ({
        eventKey: record.eventKey,
        eventType: record.eventType,
        schemaVersion: record.schemaVersion,
        aggregateType: record.aggregateType,
        aggregateId: record.aggregateId,
        occurredAt: record.occurredAt,
        availableAt: record.availableAt,
        payload: record.payload,
        audience: record.audience.map((row) => ({
          recipientId: row.recipientId, ordinal: row.ordinal, facts: row.facts,
        })),
      }));
    }
    if (!tx.domainEventReceipt && process.env.NODE_ENV !== "production") {
      await DomainEventReceipt.finalizeMany({
        items: eventInputs.map((input) => ({
          envelope: input,
          domainEventId: null,
          replaySourceType: input.aggregateType,
          replaySourceId: input.aggregateId,
        })),
      }, tx);
      return counts;
    }
    const appended = await appendRecoverableEntitlementEvents(tx, eventInputs);
    if (appended.inserted + appended.replayed !== counts.events) {
      throw new Error("set-based entitlement receipt finalization lost selected events");
    }
  }
  if (counts.created > 0) await entitlementsChanged(rows.map(row => row.userId));
  return counts;
}

async function appendLateActivationEvent(tx, {
  event,
  entitlement,
  occurredAt = new Date(),
  appendDomainEvent = defaultAppendDomainEvent,
}) {
  if (!event || !entitlement || !tx?.domainEventOutbox) return null;
  return appendDomainEvent(tx, {
    eventKey: `GLOBAL_STEP_EVENT_ACTIVATED_V1:${entitlement.id}`,
    eventType: "GLOBAL_STEP_EVENT_ACTIVATED_V1",
    schemaVersion: 1,
    aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
    aggregateId: entitlement.id,
    occurredAt,
    availableAt: occurredAt,
    payload: {
      eventId: entitlement.eventId,
      entitlementId: entitlement.id,
      multiplier: event.multiplier,
      startsAt: entitlement.startsAt,
      endsAt: entitlement.endsAt,
    },
    audience: [{ recipientId: entitlement.userId, facts: {} }],
  });
}

async function ensureEntitlementForUser(tx, {
  event,
  user,
  now = new Date(),
  allowActive = false,
}) {
  if (!tx?.globalStepEventEntitlement || !event || !user?.id) return null;
  if (event.scheduleMode !== LOCAL_ENTITLEMENTS) return null;

  const { acquireGlobalEnrollmentLock } = require('./globalEventEnrollment');
  await acquireGlobalEnrollmentLock(tx);
  // Caller may have loaded this user before a concurrent timezone commit.
  if (typeof tx.user?.findUnique === 'function') {
    user = await tx.user.findUnique({where:{id:user.id},select:{id:true,timezone:true,globalEventTimezone:true}});
    if (!user) return null;
    // Legacy standalone callers may supply a stable-zone snapshot. Persisted
    // users always use their current authoritative zone after serialization.
    user = { ...user, globalEventTimezone: user.timezone };
    now = new Date(Math.max(+new Date(now), Date.now()));
  }
  const existing = await tx.globalStepEventEntitlement.findUnique({
    where: { eventId_userId: { eventId: event.id, userId: user.id } },
  });
  if (existing) return existing;

  const timezone = isValidIanaTimeZone(user.globalEventTimezone)
    ? user.globalEventTimezone
    : FALLBACK_EVENT_TIMEZONE;
  const window = localEventWindowForZone({
    eventDay: event.eventDay,
    localStartMinute: event.localStartMinute,
    durationMinutes: event.durationMinutes,
    timeZone: timezone,
  });
  const current = new Date(now);
  if (window.endsAt <= current) return null;
  if (!allowActive && window.startsAt <= current) return null;

  const entitlement = await tx.globalStepEventEntitlement.upsert({
    where: { eventId_userId: { eventId: event.id, userId: user.id } },
    update: {},
    create: {
      eventId: event.id,
      userId: user.id,
      timezone,
      localDate: window.localDate,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      startOutcome: START_OUTCOMES.PENDING,
    },
  });
  if (await isGenerationUsable({ client: tx, now: current })) {
    await appendScheduledEntitlementEvent(tx, {
      event,
      entitlement,
      occurredAt: current,
    });
  }
  try {
    const { recordOperationalCounters } = require("./globalStepEventObservability");
    await recordOperationalCounters(tx, {
      entitlementsCreated: 1,
      ...(timezone === FALLBACK_EVENT_TIMEZONE && !isValidIanaTimeZone(user.globalEventTimezone)
        ? { fallbackEntitlementsCreated: 1 }
        : {}),
      ...(window.startsAt <= current ? { lateEntitlementsCreated: 1 } : {}),
    });
  } catch {}
  await entitlementsChanged([user.id]);
  return entitlement;
}

async function materializeEntitlementsForActiveRacers(event, {
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 100,
  afterUserId = null,
  returnPage = false,
  generationUsable = isGenerationUsable,
  afterDiscovery = async () => {},
  decisionNow = () => new Date(Math.max(+new Date(now), Date.now())),
  recordCounters = async (tx, counters) => {
    const { recordOperationalCounters } = require("./globalStepEventObservability");
    return recordOperationalCounters(tx, counters);
  },
} = {}) {
  if (event?.scheduleMode !== LOCAL_ENTITLEMENTS) {
    return returnPage
      ? { candidates: 0, created: 0, nextCursor: afterUserId, exhausted: true }
      : 0;
  }
  // Materialize distinct active users before the entitlement anti-join. LIMIT
  // follows that anti-join so enrolled users cannot consume or truncate a page.
  const candidateUsers = await prisma.$queryRawUnsafe(
    `WITH active_users AS MATERIALIZED (
  SELECT DISTINCT participant.user_id
    FROM races race
    JOIN race_participants participant ON participant.race_id = race.id
   WHERE race.status = 'active'
     AND participant.status = 'accepted'
     AND participant.forfeited_at IS NULL
     AND participant.finished_at IS NULL
     AND ($3::text IS NULL OR participant.user_id > $3)
), enrollment_candidates AS MATERIALIZED (
  SELECT active.user_id FROM active_users active
   WHERE NOT EXISTS (
     SELECT 1 FROM global_step_event_entitlements entitlement
      WHERE entitlement.event_id = $1 AND entitlement.user_id = active.user_id
   )
   ORDER BY active.user_id LIMIT $2
)
SELECT person.id, person.timezone,
       person.global_event_timezone AS "globalEventTimezone"
  FROM enrollment_candidates candidate
  JOIN users person ON person.id = candidate.user_id
 ORDER BY person.id`,
    event.id,
    batchSize,
    afterUserId,
  );
  await afterDiscovery({ event, candidateUsers });
  const participants = candidateUsers.map((user) => ({ user }));
  let current = new Date(now);
  const prepare = (participants) => participants.flatMap(({ user }) => {
    const timezone = isValidIanaTimeZone(user.timezone)
      ? user.timezone
      : FALLBACK_EVENT_TIMEZONE;
    const window = localEventWindowForZone({
      eventDay: event.eventDay,
      localStartMinute: event.localStartMinute,
      durationMinutes: event.durationMinutes,
      timeZone: timezone,
    });
    if (window.endsAt <= current || window.startsAt <= current) return [];
    return [{
      eventId: event.id,
      userId: user.id,
      timezone,
      localDate: window.localDate,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      startOutcome: START_OUTCOMES.PENDING,
      fallback: timezone === FALLBACK_EVENT_TIMEZONE &&
        !isValidIanaTimeZone(user.globalEventTimezone),
    }];
  });
  const canBatch = typeof prisma.$transaction === "function" &&
    typeof prisma.globalStepEventEntitlement?.createMany === "function";
  if (canBatch) {
    const created = await prisma.$transaction(async (tx) => {
      const { acquireGlobalEnrollmentLock } = require('./globalEventEnrollment');
      await acquireGlobalEnrollmentLock(tx);
      current = new Date(decisionNow());
      const freshUsers = typeof tx.user?.findMany === 'function'
        ? await tx.user.findMany({where:{id:{in:candidateUsers.map(row=>row.id)}},select:{id:true,timezone:true,globalEventTimezone:true}})
        : candidateUsers;
      const prepared = prepare(freshUsers.map(user=>({user})));
      if (typeof tx.$queryRawUnsafe === "function") {
        const generationReady = await generationUsable({ client: tx, now: current });
        const result = await materializePreparedEntitlementsSetBased(tx, {
          event,
          prepared,
          occurredAt: current,
          generationReady,
        });
        try {
          await recordCounters(tx, {
            entitlementsCreated: result.created,
            fallbackEntitlementsCreated: prepared.filter((row) => row.fallback).length,
          });
        } catch {}
        return result.created;
      }
      const insert = prepared.length > 0
        ? await tx.globalStepEventEntitlement.createMany({
          data: prepared.map(({ fallback, ...row }) => row),
          skipDuplicates: true,
        })
        : { count: 0 };
      const entitlements = prepared.length > 0
        ? await tx.globalStepEventEntitlement.findMany({
          where: {
            eventId: event.id,
            userId: { in: prepared.map((row) => row.userId) },
          },
        })
        : [];
      if (entitlements.length > 0 && await generationUsable({ client: tx, now: current })) {
        await appendScheduledEntitlementEventsBatch(tx, {
          event,
          entitlements,
          occurredAt: current,
        });
      }
      try {
        await recordCounters(tx, {
          entitlementsCreated: insert.count || 0,
          fallbackEntitlementsCreated: prepared.filter((row) => row.fallback).length,
        });
      } catch {}
      if (insert.count) await entitlementsChanged(prepared.map(row => row.userId));
      return insert.count || 0;
    }, { timeout: 15_000, maxWait: 10_000 });
    if (!returnPage) return created;
    return {
      candidates: participants.length,
      created,
      nextCursor: participants.at(-1)?.user?.id || afterUserId,
      exhausted: participants.length < batchSize,
    };
  }
  let created = 0;
  for (const { user } of participants) {
    const before = await prisma.globalStepEventEntitlement.findUnique({
      where: { eventId_userId: { eventId: event.id, userId: user.id } },
      select: { id: true },
    });
    const write = async (tx) => ensureEntitlementForUser(tx, { event, user, now });
    const row = prisma === defaultPrisma && typeof runInPrismaTransaction === "function"
      ? await runInPrismaTransaction(write)
      : typeof prisma.$transaction === "function"
        ? await prisma.$transaction(write)
        : await write(prisma);
    if (!before && row) {
      created += 1;
    }
  }
  if (!returnPage) return created;
  return {
    candidates: participants.length,
    created,
    nextCursor: participants.at(-1)?.user?.id || afterUserId,
    exhausted: participants.length < batchSize,
  };
}

async function findDueEntitlementsForUpdate(tx, {
  boundary,
  now,
  take,
  includeEvent = false,
  excludeIds = [],
}) {
  if (boundary !== "start" && boundary !== "end") {
    throw new TypeError("boundary must be start or end");
  }
  const limit = Math.min(100, Math.max(1, Number(take) || 100));
  const timestampColumn = boundary === "start" ? "starts_at" : "ends_at";
  const processedColumn = boundary === "start"
    ? "start_processed_at"
    : "end_processed_at";
  const prismaTimestamp = boundary === "start" ? "startsAt" : "endsAt";
  const prismaProcessed = boundary === "start"
    ? "startProcessedAt"
    : "endProcessedAt";

  if (typeof tx.$queryRawUnsafe !== "function") {
    return tx.globalStepEventEntitlement.findMany({
      where: {
        [prismaProcessed]: null,
        [prismaTimestamp]: { lte: new Date(now) },
        ...(excludeIds.length > 0 ? { id: { notIn: excludeIds } } : {}),
      },
      orderBy: { [prismaTimestamp]: "asc" },
      take: limit,
      ...(includeEvent ? { include: { event: true } } : {}),
    });
  }

  const exclusion = excludeIds.length > 0
    ? `\n        AND "id" <> ALL($3::text[])`
    : "";
  const claimed = await tx.$queryRawUnsafe(
    `SELECT "id"
       FROM "global_step_event_entitlements"
      WHERE "${processedColumn}" IS NULL
        AND "${timestampColumn}" <= $1${exclusion}
      ORDER BY "${timestampColumn}" ASC, "id" ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    ...(
      excludeIds.length > 0
        ? [new Date(now), limit, excludeIds]
        : [new Date(now), limit]
    )
  );
  const ids = claimed.map((row) => row.id);
  if (ids.length === 0) return [];
  const rows = await tx.globalStepEventEntitlement.findMany({
    where: { id: { in: ids } },
    ...(includeEvent ? { include: { event: true } } : {}),
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function processDueEntitlementBoundaries({
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 100,
  tickBudgetMs = 5000,
  enqueueRaceResolution = null,
  appendDomainEvent = defaultAppendDomainEvent,
  logger = console,
  processStarts = true,
} = {}) {
  const started = Date.now();
  const result = { starts: 0, ends: 0, stale: 0, failures: 0 };
  const current = new Date(now);
  const transitionedUserIds = new Set();
  const failureCounts = { start: 0, end: 0 };
  const {
    acquireGlobalEnrollmentLock,
    createPendingEnrollmentsForRaces,
  } = require("./globalEventEnrollment");
  const limit = Math.min(100, Math.max(1, Number(batchSize) || 100));
  const transactionOptions = { timeout: 15_000, maxWait: 10_000 };

  // Production uses the existing batch enqueue contract. A caller-supplied
  // single-race seam remains available for narrow tests and legacy doubles.
  const enqueueRaces = async (tx, entitlement, raceIds, participantIdsByRaceId = new Map()) => {
    if (raceIds.length === 0) return;
    if (!enqueueRaceResolution) {
      await defaultEnqueueRaceResolutionForUser({
        userId: entitlement.userId,
        timeZone: entitlement.timezone,
        now: current,
        reason: "GLOBAL_EVENT_BOUNDARY",
        priority: "IMMEDIATE",
        reconciledRaces: raceIds.map((raceId) => ({
          raceId,
          participantId: participantIdsByRaceId.get(raceId) || null,
        })),
      }, tx);
      return;
    }
    for (const raceId of raceIds) {
      await enqueueRaceResolution({
        raceId,
        userId: entitlement.userId,
        timeZone: entitlement.timezone,
        now: current,
        reason: "GLOBAL_EVENT_BOUNDARY",
        priority: "IMMEDIATE",
      }, tx);
    }
  };

  const processOneStart = async (excludedIds) => {
    let entitlementId = null;
    try {
      return await prisma.$transaction(async (tx) => {
        const [entitlement] = await findDueEntitlementsForUpdate(tx, {
          boundary: "start",
          now: current,
          take: 1,
          includeEvent: true,
          excludeIds: [...excludedIds],
        });
        if (!entitlement) return null;
        entitlementId = entitlement.id;
        if (entitlement.event?.scheduleMode !== LOCAL_ENTITLEMENTS) {
          return { id: entitlement.id, ignored: true };
        }
        if (new Date(entitlement.endsAt) <= current) {
          await tx.globalStepEventEntitlement.updateMany({
            where: { id: entitlement.id, startProcessedAt: null },
            data: { startOutcome: START_OUTCOMES.SKIPPED_STALE, startProcessedAt: current },
          });
          await entitlementsChanged([entitlement.userId]);
          return { id: entitlement.id, userId: entitlement.userId, stale: true };
        }

        // Fence every active race the user currently belongs to before taking
        // the eligibility snapshot. Writers use the same C0 -> global-lock
        // order; after both locks are held this reread cannot observe a
        // membership mutation halfway through the boundary.
        const racesToFence = await tx.raceParticipant.findMany({
          where: {
            userId: entitlement.userId,
            status: "ACCEPTED",
            race: { status: "ACTIVE" },
          },
          select: { raceId: true },
        });
        await acquireRaceWriteFences(tx, [...new Set(racesToFence.map((row) => row.raceId))].sort());
        await acquireGlobalEnrollmentLock(tx);

        const participants = await tx.raceParticipant.findMany({
          where: {
            userId: entitlement.userId,
            status: "ACCEPTED",
            forfeitedAt: null,
            finishedAt: null,
            joinedAt: { lte: entitlement.startsAt },
            race: {
              status: "ACTIVE",
              startedAt: { lte: entitlement.startsAt },
              OR: [{ endsAt: null }, { endsAt: { gt: entitlement.startsAt } }],
            },
          },
          select: { id: true, raceId: true },
        });
        const raceIds = [...new Set(participants.map((row) => row.raceId))].sort();
        await require('./eventRecapStartCount').stampEventRecapStartCounts(tx, [entitlement.id]);
        await createPendingEnrollmentsForRaces(tx, {
          eventId: entitlement.eventId,
          raceIds,
          userId: entitlement.userId,
        });
        await enqueueRaces(tx, entitlement, raceIds, new Map(
          participants.map((row) => [row.raceId, row.id]),
        ));

        if (raceIds.length > 0) {
          await appendDomainEvent(tx, {
            eventKey: `GLOBAL_STEP_EVENT_ACTIVATED_V1:${entitlement.id}`,
            eventType: "GLOBAL_STEP_EVENT_ACTIVATED_V1",
            schemaVersion: 1,
            aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
            aggregateId: entitlement.id,
            occurredAt: current,
            availableAt: current,
            payload: {
              eventId: entitlement.eventId,
              entitlementId: entitlement.id,
              multiplier: entitlement.event.multiplier,
              startsAt: entitlement.startsAt,
              endsAt: entitlement.endsAt,
            },
            audience: [{ recipientId: entitlement.userId, facts: {} }],
          });
        }
        await tx.globalStepEventEntitlement.updateMany({
          where: { id: entitlement.id, startProcessedAt: null },
          data: {
            startOutcome: raceIds.length > 0
              ? START_OUTCOMES.ACTIVATED_ON_TIME
              : START_OUTCOMES.NO_ACTIVE_RACES,
            startProcessedAt: current,
          },
        });
        await entitlementsChanged([entitlement.userId]);
        return { id: entitlement.id, userId: entitlement.userId };
      }, transactionOptions);
    } catch (error) {
      if (entitlementId) error.entitlementId = entitlementId;
      throw error;
    }
  };

  const processOneEnd = async (excludedIds) => {
    let entitlementId = null;
    try {
      return await prisma.$transaction(async (tx) => {
        const [entitlement] = await findDueEntitlementsForUpdate(tx, {
          boundary: "end",
          now: current,
          take: 1,
          includeEvent: true,
          excludeIds: [...excludedIds],
        });
        if (!entitlement) return null;
        entitlementId = entitlement.id;
        const impacts = await tx.globalEventRaceImpact.findMany({
          where: { eventId: entitlement.eventId, userId: entitlement.userId },
          select: { raceId: true },
        });
        const raceIds = [...new Set(impacts.map((row) => row.raceId))].sort();
        await acquireRaceWriteFences(tx, raceIds);
        await acquireGlobalEnrollmentLock(tx);
        const participants = raceIds.length === 0 ? [] : await tx.raceParticipant.findMany({
          where: { userId: entitlement.userId, raceId: { in: raceIds } },
          select: { id: true, raceId: true },
        });
        await enqueueRaces(tx, entitlement, raceIds, new Map(
          participants.map((row) => [row.raceId, row.id]),
        ));
        await tx.globalStepEventEntitlement.updateMany({
          where: { id: entitlement.id, endProcessedAt: null },
          data: { endProcessedAt: current },
        });
        await entitlementsChanged([entitlement.userId]);
        return { id: entitlement.id, userId: entitlement.userId };
      }, transactionOptions);
    } catch (error) {
      if (entitlementId) error.entitlementId = entitlementId;
      throw error;
    }
  };

  const drain = async (boundary, processor, budgetStarted = started) => {
    const excludedIds = new Set();
    let attempts = 0;
    while (attempts < limit && Date.now() - budgetStarted < tickBudgetMs) {
      let outcome;
      try {
        outcome = await processor(excludedIds);
      } catch (error) {
        attempts += 1;
        if (!error.entitlementId) {
          result.failures += 1;
          failureCounts[boundary] += 1;
          logger.error(`[GLOBAL_EVENT_BOUNDARY] ${boundary} tick failed before an entitlement was claimed`, error);
          break;
        }
        excludedIds.add(error.entitlementId);
        result.failures += 1;
        failureCounts[boundary] += 1;
        logger.error(`[GLOBAL_EVENT_BOUNDARY] ${boundary} entitlement failed; continuing`, {
          entitlementId: error.entitlementId,
          error,
        });
        continue;
      }
      if (!outcome) break;
      attempts += 1;
      if (outcome.ignored) {
        excludedIds.add(outcome.id);
        continue;
      }
      if (boundary === "start") {
        result.starts += 1;
        if (outcome.stale) result.stale += 1;
      } else {
        result.ends += 1;
      }
      if (outcome.userId) transitionedUserIds.add(outcome.userId);
    }
  };

  if (processStarts) await drain("start", processOneStart);
  if (Date.now() - started < tickBudgetMs) {
    if (!enqueueRaceResolution && typeof prisma.$queryRawUnsafe === 'function') {
      try {
        const ended = await processDueEndMicroBatch({ prisma, now: current, batchSize: limit });
        result.ends += ended.length;
        for (const row of ended) transitionedUserIds.add(row.userId);
      } catch (error) {
        // The batch rolls back before isolation/retry. Preserve the established
        // per-row recovery path so one malformed historical row cannot strand
        // a cohort. It also retries a race-set change with fresh discovery.
        logger.error('[GLOBAL_EVENT_BOUNDARY] end batch rolled back; retrying individually', {
          errorCode: error?.code || 'END_BATCH_FAILED',
        });
        // A failed batch may have consumed the normal tick budget. Give row
        // isolation its own bounded pass rather than retrying that same batch
        // forever without ever reaching healthy siblings.
        await drain('end', processOneEnd, Date.now());
      }
    } else {
      await drain('end', processOneEnd);
    }
  }
  await invalidateHomeActiveGlobalEvent([...transitionedUserIds]);
  try {
    const { recordOperationalCounters } = require("./globalStepEventObservability");
    await recordOperationalCounters(prisma, {
      startBoundaryClaims: result.starts,
      startBoundaryFailures: failureCounts.start,
      endBoundaryClaims: result.ends,
      endBoundaryFailures: failureCounts.end,
      pushesCreated: 0,
    });
  } catch {}
  return result;
}

async function processDueEndMicroBatch({ prisma = defaultPrisma, now = new Date(), batchSize = 100, ids: suppliedIds = null, bounded = false }) {
  const discovered = suppliedIds ? suppliedIds.map(id=>({id})) : await prisma.globalStepEventEntitlement.findMany({
    where: { endProcessedAt: null, endsAt: { lte: now }, OR: [{endNextAttemptAt:null},{endNextAttemptAt:{lte:now}}] },
    orderBy: [{ endsAt: 'asc' }, { id: 'asc' }], take: batchSize,
    select: { id: true },
  });
  if (!discovered.length) return [];
  const ids = discovered.map(row => row.id);
  const readImpacts = (client, entitlementIds) => client.$queryRawUnsafe(
    `SELECT entitlement.id AS "entitlementId", impact.race_id AS "raceId",
       impact.user_id AS "userId", participant.id AS "participantId"
     FROM global_step_event_entitlements entitlement
     JOIN global_event_race_impacts impact
       ON impact.event_id=entitlement.event_id AND impact.user_id=entitlement.user_id
     LEFT JOIN race_participants participant
       ON participant.race_id=impact.race_id AND participant.user_id=impact.user_id
     WHERE entitlement.id=ANY($1::text[])
     ORDER BY impact.race_id,entitlement.id`, entitlementIds);
  const discoveredImpacts = await readImpacts(prisma, ids);
  const raceIds = [...new Set(discoveredImpacts.map(row => row.raceId))].sort();
  return prisma.$transaction(async tx => {
    if (bounded) await tx.$queryRawUnsafe("SELECT set_config('lock_timeout','100ms',true),set_config('statement_timeout','750ms',true)");
    // Match start-boundary/membership writers: sorted C0, global enrollment,
    // entitlement rows, then summary work. Discovery alone is not a fence.
    await acquireRaceWriteFencesSetBased(tx, raceIds, now);
    const { acquireGlobalEnrollmentLock } = require('./globalEventEnrollment');
    await acquireGlobalEnrollmentLock(tx);
    const claims = await tx.$queryRawUnsafe(
      `SELECT id FROM global_step_event_entitlements
       WHERE id=ANY($1::text[]) AND end_processed_at IS NULL AND ends_at <= $2
         AND (end_next_attempt_at IS NULL OR end_next_attempt_at <= $2)
       ORDER BY ends_at,id FOR UPDATE SKIP LOCKED`, ids, now);
    if (!claims.length) return [];
    const claimedIds = claims.map(row => row.id);
    const entitlements = await tx.globalStepEventEntitlement.findMany({
      where: { id: { in: claimedIds } }, include: { event: true },
    });
    const impacts = await readImpacts(tx, claimedIds);
    const fenced = new Set(raceIds);
    if (impacts.some(row => !fenced.has(row.raceId))) {
      throw Object.assign(new Error('end boundary race lock set changed'), { code: 'GLOBAL_EVENT_LOCK_SET_CHANGED' });
    }
    const impactsByEntitlement = new Map();
    const scopes = new Map();
    for (const impact of impacts) {
      if (!impactsByEntitlement.has(impact.entitlementId)) impactsByEntitlement.set(impact.entitlementId, []);
      impactsByEntitlement.get(impact.entitlementId).push(impact);
      if (!scopes.has(impact.raceId)) scopes.set(impact.raceId, { users: new Set(), participants: new Set() });
      const scope = scopes.get(impact.raceId);
      scope.users.add(impact.userId);
      if (impact.participantId) scope.participants.add(impact.participantId);
    }
    if (scopes.size) {
      await RaceResolutionJobV2.enqueueMany({
        raceIds: [...scopes.keys()], now,
        triggeredUserIdsByRaceId: new Map([...scopes].map(([id, scope]) => [id, [...scope.users]])),
        dirtyEnvelopeByRaceId: new Map([...scopes].map(([id, scope]) => [id, {
          reason: 'GLOBAL_EVENT_BOUNDARY', dirtyUserIds: [...scope.users],
          dirtyParticipantIds: [...scope.participants], powerupTypes: [], priority: 'IMMEDIATE',
        }])),
        burstCoalescing: true, queuePriority: 'LIVE',
      }, tx);
      await deferUntilAfterCommit(() => redisCache.publishDurableQueueWakeup('resolution', { workKind: 'ordinary' }));
    }
    await tx.globalStepEventEntitlement.updateMany({
      where: { id: { in: claimedIds }, endProcessedAt: null }, data: { endProcessedAt: now },
    });
    await entitlementsChanged(entitlements.map(row => row.userId));
    return entitlements;
  }, bounded ? { timeout: 1500, maxWait: 100 } : { timeout: 15_000, maxWait: 10_000 });
}

async function discoverDueStartIds({ prisma = defaultPrisma, now = new Date(), batchSize = 100 } = {}) {
  const current = new Date(now);
  const rows = await prisma.globalStepEventEntitlement.findMany({
    where: {
      startProcessedAt: null,
      startsAt: { lte: current },
      OR: [{ startNextAttemptAt: null }, { startNextAttemptAt: { lte: current } }],
    },
    orderBy: [{ startsAt: "asc" }, { id: "asc" }],
    take: Math.min(100, Math.max(1, Number(batchSize) || 100)),
    select: { id: true, userId: true },
  });
  return rows;
}

async function processDueStartMicroBatch({ prisma = defaultPrisma, ids, now = new Date() } = {}) {
  const candidateIds = [...new Set((ids || []).filter(Boolean))].slice(0, 100);
  if (!candidateIds.length) return { starts: 0, stale: 0, claimed: 0 };
  const current = new Date(now);
  const discovery = await prisma.globalStepEventEntitlement.findMany({
    where: { id: { in: candidateIds } },
    select: { userId: true },
  });
  const userIds = [...new Set(discovery.map((row) => row.userId))];
  const discoveredParticipation = userIds.length
    ? await prisma.raceParticipant.findMany({
        where: { userId: { in: userIds }, status: "ACCEPTED", race: { status: "ACTIVE" } },
        select: { raceId: true },
      })
    : [];
  const discoveredRaceIds = [...new Set(discoveredParticipation.map((row) => row.raceId))].sort();

  return prisma.$transaction(async (tx) => {
    await acquireRaceWriteFencesSetBased(tx, discoveredRaceIds, current);
    const { acquireGlobalEnrollmentLock } = require("./globalEventEnrollment");
    await acquireGlobalEnrollmentLock(tx);

    const closureRows = userIds.length
      ? await tx.raceParticipant.findMany({
          where: { userId: { in: userIds }, status: "ACCEPTED", race: { status: "ACTIVE" } },
          select: { raceId: true },
        })
      : [];
    const closureRaceIds = [...new Set(closureRows.map((row) => row.raceId))].sort();
    const fenced = new Set(discoveredRaceIds);
    if (closureRaceIds.some((raceId) => !fenced.has(raceId))) {
      const error = new Error("global event race lock set changed");
      error.code = "GLOBAL_EVENT_LOCK_SET_CHANGED";
      throw error;
    }

    const claimedIds = (await tx.$queryRawUnsafe(
      `SELECT id
         FROM global_step_event_entitlements
        WHERE id = ANY($1::text[])
          AND start_processed_at IS NULL
          AND starts_at <= $2
          AND (start_next_attempt_at IS NULL OR start_next_attempt_at <= $2)
        ORDER BY starts_at, id
        FOR UPDATE SKIP LOCKED`,
      candidateIds,
      current,
    )).map((row) => row.id);
    if (!claimedIds.length) return { starts: 0, stale: 0, claimed: 0 };
    const entitlements = await tx.globalStepEventEntitlement.findMany({
      where: { id: { in: claimedIds } },
      include: { event: true },
    });
    const byId = new Map(entitlements.map((row) => [row.id, row]));
    const ordered = claimedIds.map((id) => byId.get(id)).filter(Boolean);
    const claimedUsers = [...new Set(ordered.map((row) => row.userId))];
    const participants = claimedUsers.length
      ? await tx.raceParticipant.findMany({
          where: {
            userId: { in: claimedUsers },
            status: "ACCEPTED",
            forfeitedAt: null,
            finishedAt: null,
            race: { status: "ACTIVE" },
          },
          select: {
            id: true,
            userId: true,
            raceId: true,
            joinedAt: true,
            race: { select: { startedAt: true, endsAt: true } },
          },
        })
      : [];
    const participantsByUser = new Map();
    for (const participant of participants) {
      const rows = participantsByUser.get(participant.userId) || [];
      rows.push(participant);
      participantsByUser.set(participant.userId, rows);
    }
    const impactRows = [];
    const activeIds = [];
    const noRaceIds = [];
    const staleIds = [];
    for (const entitlement of ordered) {
      if (entitlement.event?.scheduleMode !== LOCAL_ENTITLEMENTS || new Date(entitlement.endsAt) <= current) {
        staleIds.push(entitlement.id);
        continue;
      }
      const startsAt = new Date(entitlement.startsAt);
      const eligible = (participantsByUser.get(entitlement.userId) || []).filter((row) =>
        new Date(row.joinedAt) <= startsAt && row.race.startedAt &&
        new Date(row.race.startedAt) <= startsAt &&
        (!row.race.endsAt || new Date(row.race.endsAt) > startsAt));
      for (const row of eligible) {
        impactRows.push({
          eventId: entitlement.eventId,
          raceId: row.raceId,
          userId: entitlement.userId,
          participantId: row.id,
        });
      }
      (eligible.length ? activeIds : noRaceIds).push(entitlement.id);
    }
    if (impactRows.length) {
      await tx.globalEventRaceImpact.createMany({
        data: impactRows.map(({ participantId: _participantId, ...impact }) => impact),
        skipDuplicates: true,
      });
      const impactedRaceIds = [...new Set(impactRows.map((row) => row.raceId))];
      const impactedUsersByRaceId = new Map(impactedRaceIds.map((raceId) => [
        raceId,
        [...new Set(impactRows.filter((row) => row.raceId === raceId).map((row) => row.userId))].sort(),
      ]));
      const impactedParticipantsByRaceId = new Map(impactedRaceIds.map((raceId) => [
        raceId,
        [...new Set(impactRows.filter((row) => row.raceId === raceId).map((row) => row.participantId))].sort(),
      ]));
      const resolutionJobs = await RaceResolutionJobV2.enqueueMany({
        raceIds: impactedRaceIds,
        now: current,
        triggeredUserIdsByRaceId: impactedUsersByRaceId,
        dirtyEnvelopeByRaceId: new Map(impactedRaceIds.map((raceId) => [raceId, {
          reason: "GLOBAL_EVENT_BOUNDARY",
          dirtyUserIds: impactedUsersByRaceId.get(raceId),
          dirtyParticipantIds: impactedParticipantsByRaceId.get(raceId),
          powerupTypes: [],
          priority: "COALESCE",
        }])),
        burstCoalescing: true,
        queuePriority: "LIVE",
      }, tx);
      if (resolutionJobs.length) {
        await deferUntilAfterCommit(() => redisCache.publishDurableQueueWakeup(
          "resolution", { workKind: "ordinary" },
        ));
      }
    }
    await require('./eventRecapStartCount').stampEventRecapStartCounts(tx, [...activeIds, ...noRaceIds]);
    if (activeIds.length) await tx.globalStepEventEntitlement.updateMany({
      where: { id: { in: activeIds }, startProcessedAt: null },
      data: { startOutcome: START_OUTCOMES.ACTIVATED_ON_TIME, startProcessedAt: current, startNextAttemptAt: null },
    });
    if (noRaceIds.length) await tx.globalStepEventEntitlement.updateMany({
      where: { id: { in: noRaceIds }, startProcessedAt: null },
      data: { startOutcome: START_OUTCOMES.NO_ACTIVE_RACES, startProcessedAt: current, startNextAttemptAt: null },
    });
    if (staleIds.length) await tx.globalStepEventEntitlement.updateMany({
      where: { id: { in: staleIds }, startProcessedAt: null },
      data: { startOutcome: START_OUTCOMES.SKIPPED_STALE, startProcessedAt: current, startNextAttemptAt: null },
    });
    await entitlementsChanged(ordered.map(row => row.userId));
    return {
      starts: activeIds.length + noRaceIds.length + staleIds.length,
      stale: staleIds.length,
      claimed: ordered.length,
      transitionedUserIds: ordered.map((row) => row.userId),
    };
  }, { timeout: 15_000, maxWait: 10_000 });
}

async function ensureRaceGlobalEventEligibility({
  race,
  at,
  prisma = defaultPrisma,
  acquireRaceFence = null,
}) {
  if (!race?.id || !race.startedAt || !Array.isArray(race.participants)) {
    throw new TypeError("race eligibility context is required");
  }
  const current = new Date(at);
  let accepted = race.participants.filter((row) => row.status === "ACCEPTED");
  // Settlement repairs can legitimately touch hundreds of participants at the
  // weekly boundary. Keep the repair atomic, but do not let Prisma's 5-second
  // interactive-transaction default strand the race before settlement starts.
  const scoringWithoutImpactKeys = await prisma.$transaction(async (tx) => {
    const { acquireGlobalEnrollmentLock, createPendingEnrollmentsBatch } =
      require("./globalEventEnrollment");
    const fence = acquireRaceFence || (async (client, input) => {
      const { RaceResolutionJobV2 } = require("../../races/models/raceResolutionJobV2");
      return RaceResolutionJobV2.acquireForWrite(client, input);
    });
    // Universal order: race writer fence first, then global enrollment.
    // This proves/repairs membership
    // before any canonical settlement scorer is allowed to consume the map.
    await fence(tx, { raceId: race.id, now: current });
    await acquireGlobalEnrollmentLock(tx);
    if (typeof tx.race?.findUnique === "function") {
      const lockedRace = await tx.race.findUnique({
        where: { id: race.id },
        include: { participants: true },
      });
      if (!lockedRace || lockedRace.status !== "ACTIVE") {
        throw new Error("race is no longer eligible for settlement repair");
      }
      race = lockedRace;
      accepted = lockedRace.participants.filter((row) => row.status === "ACCEPTED");
    }
    const entitlements = await tx.globalStepEventEntitlement.findMany({
      where: {
        userId: { in: accepted.map((row) => row.userId) },
        startsAt: { lt: current },
        endsAt: { gt: new Date(race.startedAt) },
        event: { scheduleMode: LOCAL_ENTITLEMENTS },
      },
      include: { event: true },
    });
    const participantByUser = new Map(accepted.map((row) => [row.userId, row]));
    const pendingEnrollments = [];
    for (const entitlement of entitlements) {
      const participant = participantByUser.get(entitlement.userId);
      if (!participant) continue;
      const joinedAt = new Date(participant.joinedAt || race.startedAt);
      if (joinedAt >= new Date(entitlement.endsAt)) continue;
      let outcome = entitlement.startOutcome;
      if (outcome === START_OUTCOMES.SKIPPED_STALE) continue;
      if (outcome === START_OUTCOMES.PENDING) {
        outcome = joinedAt <= new Date(entitlement.startsAt) &&
          new Date(race.startedAt) <= new Date(entitlement.startsAt)
          ? START_OUTCOMES.ACTIVATED_ON_TIME
          : START_OUTCOMES.ACTIVATED_LATE_JOIN;
      } else if (outcome === START_OUTCOMES.NO_ACTIVE_RACES) {
        outcome = START_OUTCOMES.ACTIVATED_LATE_JOIN;
      }
      pendingEnrollments.push({
        eventId: entitlement.eventId,
        raceId: race.id,
        userIds: [entitlement.userId],
      });
      if (outcome !== entitlement.startOutcome) {
        await tx.globalStepEventEntitlement.update({
          where: { id: entitlement.id },
          data: { startOutcome: outcome, startProcessedAt: entitlement.startProcessedAt || current },
        });
        await entitlementsChanged([entitlement.userId]);
        if (outcome === START_OUTCOMES.ACTIVATED_LATE_JOIN) {
          await appendLateActivationEvent(tx, {
            event: entitlement.event,
            entitlement,
            occurredAt: current,
          });
        }
      }
    }
    if (pendingEnrollments.length === 0) return [];

    // Membership is scoring authority, not a recap capture vector. The sorted
    // race fence and enrollment lock above serialize its normal repair.
    await createPendingEnrollmentsBatch(tx, { raceId: race.id, enrollments: pendingEnrollments });
    return [];
  }, { timeout: 30_000, maxWait: 10_000 });
  const { findEligibleByRace } = require("../models/globalStepEventEntitlement");
  return findEligibleByRace({
    raceId: race.id,
    userIds: accepted.map((row) => row.userId),
    rangeStart: race.startedAt,
    rangeEnd: current,
    client: prisma,
    allowMissingImpactEventUserKeys: new Set(scoringWithoutImpactKeys),
  });
}

module.exports = {
  appendScheduledEntitlementEventsBatch,
  materializePreparedEntitlementsSetBased,
  START_OUTCOMES,
  eventsForUser,
  invalidateHomeActiveGlobalEvent,
  normalizedEntitlementEvent,
  appendScheduledEntitlementEvent,
  appendLateActivationEvent,
  ensureEntitlementForUser,
  materializeEntitlementsForActiveRacers,
  findDueEntitlementsForUpdate,
  processDueEntitlementBoundaries,
  processDueEndMicroBatch,
  discoverDueStartIds,
  processDueStartMicroBatch,
  ensureRaceGlobalEventEligibility,
};
