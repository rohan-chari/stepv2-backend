const {
  FALLBACK_EVENT_TIMEZONE,
  LOCAL_ENTITLEMENTS,
  localEventWindowForZone,
} = require("../globalStepEvent");
const { isValidIanaTimeZone } = require("../../users/services/globalEventTimezone");
const {
  prisma: defaultPrisma,
  deferUntilAfterCommit,
  runInPrismaTransaction,
} = require("../../../db");
const { createInboxAlert: defaultCreateInboxAlert } = require("../../inbox/services/inbox");
const { notificationIntentService: defaultNotificationIntentService } = require("../../notifications/services/notificationDelivery");
const {
  enqueueRaceResolutionForUser: defaultEnqueueRaceResolutionForUser,
} = require("../../races/services/enqueueRaceResolution");
const {
  acquireRaceWriteFences,
} = require("../../races/services/raceWriteFence");

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
    const derivedCache = require("../../../shared/cache/derivedCache");
    const cacheKeys = require("../../../shared/cache/cacheKeys");
    await derivedCache.invalidate({
      keys: ids.map((userId) => cacheKeys.homeActiveGlobalEvent(userId)),
      prefix: cacheKeys.PREFIX.HOME_ACTIVE_GLOBAL_EVENT,
    });
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
    impactStatus: impact?.status || null,
    startsAt: entitlement.startsAt,
    endsAt: entitlement.endsAt,
    multiplier: event.multiplier,
    scheduleMode: LOCAL_ENTITLEMENTS,
  };
}

async function ensureEntitlementForUser(tx, {
  event,
  user,
  now = new Date(),
  allowActive = false,
}) {
  if (!tx?.globalStepEventEntitlement || !event || !user?.id) return null;
  if (event.scheduleMode !== LOCAL_ENTITLEMENTS) return null;

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
  // Future local starts are durable notification intents, not pre-created
  // Inbox alerts. The due-boundary transaction releases this schedule only
  // after it proves the recipient still has an eligible active race.
  if (tx.notificationSchedule && window.startsAt > current) {
    await defaultNotificationIntentService.submit({
      recipientUserId: user.id,
      type: "GLOBAL_EVENT_STARTED",
      title: "2x STEPS EVENT",
      body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
      payload: {
        type: "GLOBAL_EVENT_STARTED",
        route: "home",
        params: {},
        multiplier: event.multiplier,
        eventId: event.id,
        entitlementId: entitlement.id,
      },
      deliveryKey: `visible:GLOBAL_EVENT_STARTED:${user.id}:${event.id}`,
      availableAt: window.startsAt,
      expiresAt: window.endsAt,
      sourceRef: entitlement.id,
    }, { tx, now: current });
    // A future schedule is durable before this callback runs. When the caller
    // uses the shared Prisma transaction wrapper this wake is deferred until
    // commit; the timer/scan remains the correctness fallback.
    await deferUntilAfterCommit(() =>
      defaultNotificationIntentService.wake({ recipientUserId: user.id })
    );
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
  return entitlement;
}

async function materializeEntitlementsForActiveRacers(event, {
  prisma = defaultPrisma,
  now = new Date(),
  batchSize = 100,
  afterUserId = null,
  returnPage = false,
} = {}) {
  if (event?.scheduleMode !== LOCAL_ENTITLEMENTS) {
    return returnPage
      ? { candidates: 0, created: 0, nextCursor: afterUserId, exhausted: true }
      : 0;
  }
  const participants = await prisma.raceParticipant.findMany({
    where: {
      ...(afterUserId ? { userId: { gt: afterUserId } } : {}),
      status: "ACCEPTED",
      forfeitedAt: null,
      finishedAt: null,
      race: { status: "ACTIVE" },
      user: {
        globalStepEventEntitlements: { none: { eventId: event.id } },
      },
    },
    distinct: ["userId"],
    orderBy: { userId: "asc" },
    take: batchSize,
    select: {
      user: {
        select: {
          id: true,
          timezone: true,
          globalEventTimezone: true,
        },
      },
    },
  });
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
  createInboxAlert = defaultCreateInboxAlert,
  enqueueRaceResolution = null,
  notificationIntentService = defaultNotificationIntentService,
  logger = console,
} = {}) {
  const started = Date.now();
  const result = { starts: 0, ends: 0, stale: 0, failures: 0 };
  const current = new Date(now);
  const transitionedUserIds = new Set();
  const alertedUserIds = new Set();
  const failureCounts = { start: 0, end: 0 };
  const {
    acquireGlobalEnrollmentLock,
    createPendingEnrollmentsForRaces,
  } = require("./globalEventEnrollment");
  const limit = Math.min(100, Math.max(1, Number(batchSize) || 100));
  const transactionOptions = { timeout: 15_000, maxWait: 10_000 };

  // Production uses the existing batch enqueue contract. A caller-supplied
  // single-race seam remains available for narrow tests and legacy doubles.
  const enqueueRaces = async (tx, entitlement, raceIds) => {
    if (raceIds.length === 0) return;
    if (!enqueueRaceResolution) {
      await defaultEnqueueRaceResolutionForUser({
        userId: entitlement.userId,
        timeZone: entitlement.timezone,
        now: current,
        reason: "GLOBAL_EVENT_BOUNDARY",
        priority: "IMMEDIATE",
        reconciledRaces: raceIds.map((raceId) => ({ raceId })),
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
        const deliveryKey = `visible:GLOBAL_EVENT_STARTED:${entitlement.userId}:${entitlement.eventId}`;
        if (new Date(entitlement.endsAt) <= current) {
          await tx.globalStepEventEntitlement.updateMany({
            where: { id: entitlement.id, startProcessedAt: null },
            data: { startOutcome: START_OUTCOMES.SKIPPED_STALE, startProcessedAt: current },
          });
          if (tx.notificationSchedule) {
            await notificationIntentService.releaseOneDue({
              tx,
              recipientUserId: entitlement.userId,
              deliveryKey,
              now: current,
              eligible: false,
            });
          }
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
          select: { raceId: true },
        });
        const raceIds = [...new Set(participants.map((row) => row.raceId))].sort();
        await createPendingEnrollmentsForRaces(tx, {
          eventId: entitlement.eventId,
          raceIds,
          userId: entitlement.userId,
        });
        await enqueueRaces(tx, entitlement, raceIds);

        let alerted = false;
        if (tx.notificationSchedule) {
          const released = await notificationIntentService.releaseOneDue({
            tx,
            recipientUserId: entitlement.userId,
            deliveryKey,
            now: current,
            eligible: raceIds.length > 0,
          });
          if (released?.released) alerted = true;
          else if (released === null && raceIds.length > 0) {
            await createInboxAlert({
              userId: entitlement.userId,
              type: "GLOBAL_EVENT_STARTED",
              title: "2x STEPS EVENT",
              body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
              destination: { route: "home" },
              sourceKey: deliveryKey,
              payload: {
                type: "GLOBAL_EVENT_STARTED", route: "home", params: {},
                multiplier: entitlement.event.multiplier,
                eventId: entitlement.eventId, entitlementId: entitlement.id,
              },
              now: current,
              tx,
            });
            alerted = true;
          }
        } else if (raceIds.length > 0) {
          await createInboxAlert({
            userId: entitlement.userId,
            type: "GLOBAL_EVENT_STARTED",
            title: "2x STEPS EVENT",
            body: "Double steps are LIVE for 30 minutes. Every step counts 2x in your races! Go!",
            destination: { route: "home" },
            sourceKey: deliveryKey,
            payload: {
              type: "GLOBAL_EVENT_STARTED", route: "home", params: {},
              multiplier: entitlement.event.multiplier,
              eventId: entitlement.eventId, entitlementId: entitlement.id,
            },
            now: current,
            tx,
          });
          alerted = true;
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
        return { id: entitlement.id, userId: entitlement.userId, alerted };
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
        await enqueueRaces(tx, entitlement, raceIds);
        await tx.globalStepEventEntitlement.updateMany({
          where: { id: entitlement.id, endProcessedAt: null },
          data: { endProcessedAt: current },
        });
        return { id: entitlement.id, userId: entitlement.userId };
      }, transactionOptions);
    } catch (error) {
      if (entitlementId) error.entitlementId = entitlementId;
      throw error;
    }
  };

  const drain = async (boundary, processor) => {
    const excludedIds = new Set();
    let attempts = 0;
    while (attempts < limit && Date.now() - started < tickBudgetMs) {
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
      if (outcome.alerted) alertedUserIds.add(outcome.userId);
    }
  };

  await drain("start", processOneStart);
  if (Date.now() - started < tickBudgetMs) await drain("end", processOneEnd);
  await invalidateHomeActiveGlobalEvent([...transitionedUserIds]);
  if (alertedUserIds.size > 0) {
    const { invalidateInboxUnread } = require("../../inbox/services/inbox");
    await Promise.all([...alertedUserIds].map((userId) =>
      invalidateInboxUnread(userId).catch(() => null)
    ));
    await Promise.all([...alertedUserIds].map((recipientUserId) =>
      notificationIntentService.wake({ recipientUserId }).catch(() => null)
    ));
  }
  try {
    const { recordOperationalCounters } = require("./globalStepEventObservability");
    await recordOperationalCounters(prisma, {
      startBoundaryClaims: result.starts,
      startBoundaryFailures: failureCounts.start,
      endBoundaryClaims: result.ends,
      endBoundaryFailures: failureCounts.end,
      pushesCreated: alertedUserIds.size,
    });
  } catch {}
  return result;
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
  await prisma.$transaction(async (tx) => {
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
      }
    }
    await createPendingEnrollmentsBatch(tx, { raceId: race.id, enrollments: pendingEnrollments });
  }, { timeout: 30_000, maxWait: 10_000 });
  const { findEligibleByRace } = require("../models/globalStepEventEntitlement");
  return findEligibleByRace({
    raceId: race.id,
    userIds: accepted.map((row) => row.userId),
    rangeStart: race.startedAt,
    rangeEnd: current,
    client: prisma,
  });
}

module.exports = {
  START_OUTCOMES,
  eventsForUser,
  invalidateHomeActiveGlobalEvent,
  normalizedEntitlementEvent,
  ensureEntitlementForUser,
  materializeEntitlementsForActiveRacers,
  findDueEntitlementsForUpdate,
  processDueEntitlementBoundaries,
  ensureRaceGlobalEventEligibility,
};
