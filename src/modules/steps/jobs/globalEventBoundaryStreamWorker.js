const { prisma: defaultPrisma } = require("../../../db");
const {
  STREAMS,
  GROUPS,
  publish,
  ensureGroup,
  readGroup,
  reclaimIdle,
  ack,
  consumerName,
} = require("../../../shared/queues/redisStreams");
const {
  parseGlobalEventBoundary,
  RACE_DIRTY_VERSION,
  NOTIFICATION_DELIVERY_VERSION,
} = require("../../../shared/queues/workMessages");
const {
  acquireRaceWriteFencesSetBased,
} = require("../../races/services/raceWriteFence");
const {
  acquireGlobalEnrollmentLock,
} = require("../services/globalEventEnrollment");
const {
  invalidateHomeActiveGlobalEvent,
} = require("../services/globalStepEventEntitlement");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 10;
const CONCURRENCY = 3;

function buildGlobalEventBoundaryStreamWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  async function discoverStart(entitlement) {
    const rows = await prisma.raceParticipant.findMany({
      where: {
        userId: entitlement.userId,
        status: "ACCEPTED",
        forfeitedAt: null,
        finishedAt: null,
        race: { status: "ACTIVE" },
      },
      select: {
        id: true,
        raceId: true,
        joinedAt: true,
        race: { select: { startedAt: true, endsAt: true } },
      },
    });
    const startsAt = new Date(entitlement.startsAt);
    return rows.filter((row) =>
      new Date(row.joinedAt) <= startsAt &&
      row.race.startedAt &&
      new Date(row.race.startedAt) <= startsAt &&
      (!row.race.endsAt || new Date(row.race.endsAt) > startsAt)
    );
  }

  async function processStart(message) {
    const initial = await prisma.globalStepEventEntitlement.findUnique({
      where: { id: message.entitlementId },
      include: { event: true },
    });
    if (!initial) return { raceIds: [], notify: null };
    if (Number(initial.scheduleRevision || 0) !== message.scheduleRevision) {
      return { raceIds: [], notify: null };
    }
    if (initial.startProcessedAt) return { raceIds: [], notify: null };

    const discovered = await discoverStart(initial);
    const discoveredRaceIds = [...new Set(discovered.map((row) => row.raceId))].sort();
    const current = new Date(now());

    const result = await prisma.$transaction(async (tx) => {
      await acquireRaceWriteFencesSetBased(tx, discoveredRaceIds, current);
      await acquireGlobalEnrollmentLock(tx);

      const entitlement = await tx.globalStepEventEntitlement.findUnique({
        where: { id: message.entitlementId },
        include: { event: true },
      });
      if (!entitlement ||
          Number(entitlement.scheduleRevision || 0) !== message.scheduleRevision ||
          entitlement.startProcessedAt) {
        return { raceIds: [], notify: null, userId: entitlement?.userId || initial.userId };
      }

      if (new Date(entitlement.endsAt) <= current) {
        await tx.globalStepEventEntitlement.update({
          where: { id: entitlement.id },
          data: {
            startOutcome: "SKIPPED_STALE",
            startProcessedAt: current,
            startNextAttemptAt: null,
          },
        });
        return { raceIds: [], notify: null, userId: entitlement.userId };
      }

      const participants = await tx.raceParticipant.findMany({
        where: {
          userId: entitlement.userId,
          status: "ACCEPTED",
          forfeitedAt: null,
          finishedAt: null,
          race: { status: "ACTIVE" },
        },
        select: {
          id: true,
          raceId: true,
          joinedAt: true,
          race: { select: { startedAt: true, endsAt: true } },
        },
      });
      const startsAt = new Date(entitlement.startsAt);
      const eligible = participants.filter((row) =>
        new Date(row.joinedAt) <= startsAt &&
        row.race.startedAt &&
        new Date(row.race.startedAt) <= startsAt &&
        (!row.race.endsAt || new Date(row.race.endsAt) > startsAt)
      );
      const raceIds = [...new Set(eligible.map((row) => row.raceId))].sort();
      const fenced = new Set(discoveredRaceIds);
      if (raceIds.some((raceId) => !fenced.has(raceId))) {
        const error = new Error("global event race lock set changed");
        error.code = "GLOBAL_EVENT_LOCK_SET_CHANGED";
        throw error;
      }

      if (raceIds.length) {
        await tx.globalEventRaceImpact.createMany({
          data: raceIds.map((raceId) => ({
            eventId: entitlement.eventId,
            raceId,
            userId: entitlement.userId,
          })),
          skipDuplicates: true,
        });
      }

      const outcome = raceIds.length ? "ACTIVATED_ON_TIME" : "NO_ACTIVE_RACES";
      await tx.globalStepEventEntitlement.update({
        where: { id: entitlement.id },
        data: {
          startOutcome: outcome,
          startProcessedAt: current,
          startNextAttemptAt: null,
        },
      });

      return {
        raceIds,
        userId: entitlement.userId,
        notify: raceIds.length ? {
          recipientUserId: entitlement.userId,
          entitlementId: entitlement.id,
          eventId: entitlement.eventId,
          scheduleRevision: Number(entitlement.scheduleRevision || 0),
          availableAt: new Date(entitlement.startsAt),
          expiresAt: new Date(entitlement.endsAt),
        } : null,
      };
    }, { timeout: 15_000, maxWait: 10_000 });

    await invalidateHomeActiveGlobalEvent([result.userId]);
    return result;
  }

  async function processEnd(message) {
    const initial = await prisma.globalStepEventEntitlement.findUnique({
      where: { id: message.entitlementId },
    });
    if (!initial ||
        Number(initial.scheduleRevision || 0) !== message.scheduleRevision ||
        initial.endProcessedAt) {
      return { raceIds: [], notify: null, userId: initial?.userId || null };
    }
    const impacts = await prisma.globalEventRaceImpact.findMany({
      where: { eventId: initial.eventId, userId: initial.userId },
      select: { raceId: true },
    });
    const discoveredRaceIds = [...new Set(impacts.map((row) => row.raceId))].sort();
    const current = new Date(now());

    const result = await prisma.$transaction(async (tx) => {
      await acquireRaceWriteFencesSetBased(tx, discoveredRaceIds, current);
      await acquireGlobalEnrollmentLock(tx);
      const entitlement = await tx.globalStepEventEntitlement.findUnique({
        where: { id: message.entitlementId },
      });
      if (!entitlement ||
          Number(entitlement.scheduleRevision || 0) !== message.scheduleRevision ||
          entitlement.endProcessedAt) {
        return { raceIds: [], notify: null, userId: entitlement?.userId || initial.userId };
      }
      const currentImpacts = await tx.globalEventRaceImpact.findMany({
        where: { eventId: entitlement.eventId, userId: entitlement.userId },
        select: { raceId: true },
      });
      const raceIds = [...new Set(currentImpacts.map((row) => row.raceId))].sort();
      const fenced = new Set(discoveredRaceIds);
      if (raceIds.some((raceId) => !fenced.has(raceId))) {
        const error = new Error("global event end race lock set changed");
        error.code = "GLOBAL_EVENT_LOCK_SET_CHANGED";
        throw error;
      }
      await tx.globalStepEventEntitlement.update({
        where: { id: entitlement.id },
        data: {
          endProcessedAt: current,
          endNextAttemptAt: null,
          endLastErrorCode: null,
        },
      });
      return { raceIds, notify: null, userId: entitlement.userId };
    }, { timeout: 15_000, maxWait: 10_000 });

    await invalidateHomeActiveGlobalEvent([result.userId]);
    return result;
  }

  async function publishFanout(message, result) {
    for (const raceId of result.raceIds || []) {
      await publish(STREAMS.RACE_DIRTY, {
        schemaVersion: RACE_DIRTY_VERSION,
        raceId,
        userId: result.userId || "",
        reason: "GLOBAL_EVENT_BOUNDARY",
        requestedAt: new Date(now()).toISOString(),
      });
    }
    if (message.boundaryType === "START" && result.notify) {
      const notify = result.notify;
      await publish(STREAMS.NOTIFICATION_DELIVERY, {
        schemaVersion: NOTIFICATION_DELIVERY_VERSION,
        recipientUserId: notify.recipientUserId,
        type: "GLOBAL_EVENT_STARTED",
        deliveryKey: `global-event-start:${notify.entitlementId}:${notify.scheduleRevision}`,
        sourceType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
        sourceId: notify.entitlementId,
        sourceRevision: notify.scheduleRevision,
        availableAt: notify.availableAt.toISOString(),
        expiresAt: notify.expiresAt.toISOString(),
      });
    }
  }

  async function processEntry(entry) {
    try {
      const message = parseGlobalEventBoundary(entry.fields);
      const result = message.boundaryType === "START"
        ? await processStart(message)
        : await processEnd(message);
      await publishFanout(message, result);
      await ack(STREAMS.GLOBAL_EVENT_BOUNDARY, GROUPS.GLOBAL_EVENT_BOUNDARY, entry.id);
      return true;
    } catch (error) {
      logger.error?.("[GLOBAL_EVENT_QUEUE] boundary processing failed", {
        messageId: entry.id,
        code: error?.code || error?.name || "GLOBAL_EVENT_BOUNDARY_ERROR",
      });
      return false;
    }
  }

  return { processEntry, processStart, processEnd };
}

function scheduleGlobalEventBoundaryStreamWorker(dependencies = {}) {
  const worker = dependencies.worker || buildGlobalEventBoundaryStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || consumerName("global-event-boundary");
  const concurrency = Math.max(1, Number(dependencies.concurrency) || CONCURRENCY);
  let stopped = false;
  let running;

  async function processBatch(entries) {
    let cursor = 0;
    async function consume() {
      while (!stopped) {
        const index = cursor++;
        if (index >= entries.length) return;
        await worker.processEntry(entries[index]);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(concurrency, entries.length) }, consume),
    );
  }

  async function loop() {
    await ensureGroup(STREAMS.GLOBAL_EVENT_BOUNDARY, GROUPS.GLOBAL_EVENT_BOUNDARY);
    while (!stopped) {
      try {
        const reclaimed = await reclaimIdle({
          stream: STREAMS.GLOBAL_EVENT_BOUNDARY,
          group: GROUPS.GLOBAL_EVENT_BOUNDARY,
          consumer,
          minIdleMs: RECLAIM_IDLE_MS,
          count: 25,
        });
        if (reclaimed.length) {
          await processBatch(reclaimed);
          continue;
        }
        const entries = await readGroup({
          stream: STREAMS.GLOBAL_EVENT_BOUNDARY,
          group: GROUPS.GLOBAL_EVENT_BOUNDARY,
          consumer,
          count: READ_COUNT,
          blockMs: 5000,
        });
        if (entries.length) await processBatch(entries);
      } catch (error) {
        logger.error?.("[GLOBAL_EVENT_QUEUE] worker loop failed", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  running = loop();
  return {
    async stop() {
      stopped = true;
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(resolve, 6000)),
      ]);
    },
  };
}

module.exports = {
  buildGlobalEventBoundaryStreamWorker,
  scheduleGlobalEventBoundaryStreamWorker,
};
