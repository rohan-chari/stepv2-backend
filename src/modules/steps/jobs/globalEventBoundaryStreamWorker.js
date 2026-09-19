const {
  parseGlobalEventBoundary,
  RACE_DIRTY_VERSION,
  NOTIFICATION_DELIVERY_VERSION,
} = require("../../../shared/queues/workMessages");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 100;
const MAX_BATCH_RACES = 100;
const MAX_BATCH_IMPACTS = 1000;
const FANOUT_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function fanoutReceiptKey(message) {
  return `${process.env.CACHE_ENV_PREFIX || ""}queue:global-event-boundary:fanout:v1:${message.boundaryType}:${message.entitlementId}:${message.scheduleRevision}`;
}

const unique = (values) => [...new Set(values.filter(Boolean))].sort();

function buildGlobalEventBoundaryStreamWorker(dependencies = {}) {
  const prisma = dependencies.prisma || require("../../../db").prisma;
  const queue = dependencies.queue || require("../../../shared/queues/redisStreams");
  const jobModel = dependencies.RaceResolutionJobV2 || require("../../races/models/raceResolutionJobV2").RaceResolutionJobV2;
  const acquireRaceFences = dependencies.acquireRaceWriteFencesSetBased || require("../../races/services/raceWriteFence").acquireRaceWriteFencesSetBased;
  const acquireEnrollmentLock = dependencies.acquireGlobalEnrollmentLock || require("../services/globalEventEnrollment").acquireGlobalEnrollmentLock;
  const invalidate = dependencies.invalidateHomeActiveGlobalEvent || require("../services/globalStepEventEntitlement").invalidateHomeActiveGlobalEvent;
  const stampStartCounts = dependencies.stampEventRecapStartCounts || require("../services/eventRecapStartCount").stampEventRecapStartCounts;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const { STREAMS, GROUPS } = queue;

  // The same bulk read is used for discovery and the authoritative re-read
  // under C0 -> enrollment locks. Replays use durable impacts, not current membership.
  async function decisionsFor(messages, client, current) {
    const entitlements = await client.globalStepEventEntitlement.findMany({
      where: { id: { in: unique(messages.map((message) => message.entitlementId)) } },
    });
    const byId = new Map(entitlements.map((row) => [row.id, row]));
    const matching = messages.filter((message) => {
      const row = byId.get(message.entitlementId);
      return row && Number(row.scheduleRevision || 0) === message.scheduleRevision;
    });
    const startUsers = unique(matching.filter((message) => {
      const row = byId.get(message.entitlementId);
      return message.boundaryType === "START" && !row.startProcessedAt &&
        new Date(row.startsAt) <= current && new Date(row.endsAt) > current;
    }).map((message) => byId.get(message.entitlementId).userId));
    const participants = startUsers.length ? await client.raceParticipant.findMany({
      where: {
        userId: { in: startUsers }, status: "ACCEPTED", forfeitedAt: null,
        finishedAt: null, race: { status: "ACTIVE" },
      },
      select: {
        id: true, userId: true, raceId: true, joinedAt: true,
        race: { select: { startedAt: true, endsAt: true } },
      },
    }) : [];
    const impactSources = matching.filter((message) => {
      const row = byId.get(message.entitlementId);
      return message.boundaryType === "END" || row.startProcessedAt;
    }).map((message) => {
      const row = byId.get(message.entitlementId);
      return { eventId: row.eventId, userId: row.userId };
    });
    const impacts = impactSources.length ? await client.globalEventRaceImpact.findMany({
      where: { OR: impactSources }, select: { eventId: true, userId: true, raceId: true },
    }) : [];
    const participantsByUser = new Map();
    for (const row of participants) {
      if (!participantsByUser.has(row.userId)) participantsByUser.set(row.userId, []);
      participantsByUser.get(row.userId).push(row);
    }
    const impactsBySource = new Map();
    for (const row of impacts) {
      const key = `${row.eventId}:${row.userId}`;
      if (!impactsBySource.has(key)) impactsBySource.set(key, []);
      impactsBySource.get(key).push(row);
    }

    return messages.map((message) => {
      const entitlement = byId.get(message.entitlementId);
      const result = { message, raceIds: [], participants: [], notify: null };
      if (!entitlement || Number(entitlement.scheduleRevision || 0) !== message.scheduleRevision) return result;
      Object.assign(result, { entitlement, userId: entitlement.userId });
      const start = message.boundaryType === "START";
      const processed = start ? entitlement.startProcessedAt : entitlement.endProcessedAt;
      const boundaryAt = new Date(start ? entitlement.startsAt : entitlement.endsAt);
      if (!processed && boundaryAt > current) return { ...result, deferred: true };
      result.replay = Boolean(processed);
      if (!start || processed) {
        if (!start || entitlement.startOutcome === "ACTIVATED_ON_TIME") {
          result.raceIds = unique((impactsBySource.get(`${entitlement.eventId}:${entitlement.userId}`) || []).map((row) => row.raceId));
        }
        result.end = !start && !processed;
      } else if (new Date(entitlement.endsAt) <= current) {
        result.outcome = "SKIPPED_STALE";
      } else {
        const startsAt = new Date(entitlement.startsAt);
        result.participants = (participantsByUser.get(entitlement.userId) || []).filter((row) =>
          new Date(row.joinedAt) <= startsAt && row.race.startedAt &&
          new Date(row.race.startedAt) <= startsAt &&
          (!row.race.endsAt || new Date(row.race.endsAt) > startsAt));
        result.raceIds = unique(result.participants.map((row) => row.raceId));
        result.outcome = result.raceIds.length ? "ACTIVATED_ON_TIME" : "NO_ACTIVE_RACES";
      }
      if (start && result.raceIds.length) result.notify = {
        recipientUserId: entitlement.userId, entitlementId: entitlement.id,
        eventId: entitlement.eventId, scheduleRevision: Number(entitlement.scheduleRevision || 0),
        availableAt: new Date(entitlement.startsAt), expiresAt: new Date(entitlement.endsAt),
      };
      return result;
    });
  }

  function splitByFootprint(decisions) {
    const batches = [];
    let batch = [];
    let races = new Set();
    let impacts = 0;
    for (const decision of decisions) {
      const combined = new Set([...races, ...decision.raceIds]);
      if (batch.length && (combined.size > MAX_BATCH_RACES || impacts + decision.raceIds.length > MAX_BATCH_IMPACTS)) {
        batches.push(batch);
        batch = [];
        races = new Set();
        impacts = 0;
      }
      batch.push(decision);
      for (const raceId of decision.raceIds) races.add(raceId);
      impacts += decision.raceIds.length;
      if (decision.raceIds.length > MAX_BATCH_RACES) {
        logger.warn?.("[GLOBAL_EVENT_QUEUE] oversized singleton boundary", { raceCount: decision.raceIds.length });
      }
    }
    if (batch.length) batches.push(batch);
    return batches;
  }

  async function commitBatch(discovered) {
    const current = new Date(now());
    const raceIds = unique(discovered.flatMap((decision) => decision.raceIds));
    const startedAt = Date.now();
    const result = await prisma.$transaction(async (tx) => {
      await acquireRaceFences(tx, raceIds, current);
      await acquireEnrollmentLock(tx);
      const decisions = await decisionsFor(discovered.map((decision) => decision.message), tx, current);
      const fenced = new Set(raceIds);
      if (decisions.some((decision) => decision.raceIds.some((id) => !fenced.has(id)))) {
        const error = new Error("global event race lock set changed");
        error.code = "GLOBAL_EVENT_LOCK_SET_CHANGED";
        throw error;
      }
      const impactRows = decisions.flatMap((decision) => decision.participants.map((participant) => ({
        eventId: decision.entitlement.eventId, userId: decision.userId, raceId: participant.raceId,
      }))).sort((a, b) => a.raceId.localeCompare(b.raceId) || a.userId.localeCompare(b.userId));
      if (impactRows.length) await tx.globalEventRaceImpact.createMany({ data: impactRows, skipDuplicates: true });
      const starts = decisions.filter((decision) => decision.outcome);
      await stampStartCounts(tx, starts.filter((decision) => decision.outcome !== "SKIPPED_STALE").map((decision) => decision.entitlement.id));
      for (const outcome of ["ACTIVATED_ON_TIME", "NO_ACTIVE_RACES", "SKIPPED_STALE"]) {
        const ids = starts.filter((decision) => decision.outcome === outcome).map((decision) => decision.entitlement.id);
        if (ids.length) await tx.globalStepEventEntitlement.updateMany({
          where: { id: { in: ids }, startProcessedAt: null },
          data: { startOutcome: outcome, startProcessedAt: current, startNextAttemptAt: null },
        });
      }
      const endIds = decisions.filter((decision) => decision.end).map((decision) => decision.entitlement.id);
      if (endIds.length) await tx.globalStepEventEntitlement.updateMany({
        where: { id: { in: endIds }, endProcessedAt: null },
        data: { endProcessedAt: current, endNextAttemptAt: null, endLastErrorCode: null },
      });

      const usersByRace = new Map();
      const participantsByRace = new Map();
      for (const decision of decisions) for (const raceId of decision.raceIds) {
        if (!usersByRace.has(raceId)) usersByRace.set(raceId, new Set());
        usersByRace.get(raceId).add(decision.userId);
      }
      for (const decision of decisions) for (const participant of decision.participants) {
        if (!participantsByRace.has(participant.raceId)) participantsByRace.set(participant.raceId, new Set());
        participantsByRace.get(participant.raceId).add(participant.id);
      }
      const dirtyRaceIds = [...usersByRace.keys()].sort();
      const triggeredUserIdsByRaceId = new Map(dirtyRaceIds.map((raceId) => [raceId, [...usersByRace.get(raceId)].sort()]));
      // Persist scope with the entitlement mutation. Redis only transports one
      // generation wake per race; it never has to choose a single user's scope.
      const jobs = dirtyRaceIds.length ? await jobModel.enqueueMany({
        raceIds: dirtyRaceIds, now: current, triggeredUserIdsByRaceId,
        dirtyEnvelopeByRaceId: new Map(dirtyRaceIds.map((raceId) => [raceId, {
          reason: "GLOBAL_EVENT_BOUNDARY", dirtyUserIds: triggeredUserIdsByRaceId.get(raceId),
          dirtyParticipantIds: [...(participantsByRace.get(raceId) || [])].sort(),
          powerupTypes: [], priority: "COALESCE",
        }])),
        burstCoalescing: true, queuedGenerationMerge: true, queuePriority: "LIVE",
      }, tx) : [];
      return { decisions, jobs };
    }, { timeout: 15_000, maxWait: 10_000 });

    // Replays invalidate too: a prior process may have died just after COMMIT.
    await invalidate(unique(result.decisions.filter((decision) => !decision.deferred).map((decision) => decision.userId)));
    logger.log?.(JSON.stringify({
      event: "global_event_boundary_batch_v1", entries: discovered.length,
      races: result.jobs.length, replayed: result.decisions.filter((decision) => decision.replay).length,
      durationMs: Date.now() - startedAt,
    }));
    return result;
  }

  async function publishFanout({ decisions, jobs }) {
    for (const job of jobs) await queue.publish(STREAMS.RACE_DIRTY, {
      schemaVersion: RACE_DIRTY_VERSION, raceId: job.raceId,
      jobGeneration: Number(job.generation), reason: "GLOBAL_EVENT_BOUNDARY",
      requestedAt: new Date(now()).toISOString(),
    });
    for (const { notify } of decisions) if (notify) await queue.publish(STREAMS.NOTIFICATION_DELIVERY, {
      schemaVersion: NOTIFICATION_DELIVERY_VERSION, recipientUserId: notify.recipientUserId,
      type: "GLOBAL_EVENT_STARTED",
      deliveryKey: `visible:GLOBAL_EVENT_STARTED:${notify.recipientUserId}:${notify.eventId}`,
      sourceType: "GLOBAL_STEP_EVENT_ENTITLEMENT", sourceId: notify.entitlementId,
      sourceRevision: notify.scheduleRevision, availableAt: notify.availableAt.toISOString(),
      expiresAt: notify.expiresAt.toISOString(),
    });
  }

  async function processEntries(entries) {
    let completed = 0;
    for (let offset = 0; offset < entries.length; offset += READ_COUNT) {
      const byKey = new Map();
      for (const entry of entries.slice(offset, offset + READ_COUNT)) {
        try {
          const message = parseGlobalEventBoundary(entry.fields);
          const key = fanoutReceiptKey(message);
          if (!byKey.has(key)) byKey.set(key, { message, entries: [] });
          byKey.get(key).entries.push(entry);
        } catch (error) {
          logger.error?.("[GLOBAL_EVENT_QUEUE] invalid boundary", { messageId: entry.id, code: error?.code || error?.name });
        }
      }
      if (!byKey.size) continue;
      try {
        const groups = [...byKey.values()];
        const receipts = await queue.withCommandClient((redis) => redis.mget(...byKey.keys()));
        const pending = [];
        for (let i = 0; i < groups.length; i += 1) {
          if (!receipts[i]) { pending.push(groups[i].message); continue; }
          for (const entry of groups[i].entries) {
            await queue.ack(STREAMS.GLOBAL_EVENT_BOUNDARY, GROUPS.GLOBAL_EVENT_BOUNDARY, entry.id);
            completed += 1;
          }
        }
        // START before END makes a recovered pair obey the original window;
        // stale starts stay stale rather than extending the event on recovery.
        for (const boundaryType of ["START", "END"]) {
          const messages = pending.filter((message) => message.boundaryType === boundaryType);
          if (!messages.length) continue;
          const discovered = await decisionsFor(messages, prisma, new Date(now()));
          for (const batch of splitByFootprint(discovered)) {
            const result = await commitBatch(batch);
            await publishFanout(result);
            // A per-boundary receipt remains valid across differently shaped retries.
            for (const decision of result.decisions) {
              if (decision.deferred) continue;
              const key = fanoutReceiptKey(decision.message);
              await queue.withCommandClient((redis) => redis.set(key, "1", "PX", FANOUT_RECEIPT_TTL_MS));
              for (const entry of byKey.get(key).entries) {
                await queue.ack(STREAMS.GLOBAL_EVENT_BOUNDARY, GROUPS.GLOBAL_EVENT_BOUNDARY, entry.id);
                completed += 1;
              }
            }
          }
        }
      } catch (error) {
        // The unacknowledged entries and committed job scopes remain recoverable.
        logger.error?.("[GLOBAL_EVENT_QUEUE] boundary batch failed", { code: error?.code || error?.name || "GLOBAL_EVENT_BOUNDARY_ERROR" });
      }
    }
    return completed;
  }

  async function processBoundary(message) {
    const discovered = await decisionsFor([message], prisma, new Date(now()));
    const result = await commitBatch(discovered);
    return result.decisions[0];
  }

  return {
    processEntries,
    processEntry: async (entry) => (await processEntries([entry])) === 1,
    processStart: processBoundary,
    processEnd: processBoundary,
  };
}

function scheduleGlobalEventBoundaryStreamWorker(dependencies = {}) {
  const queue = dependencies.queue || require("../../../shared/queues/redisStreams");
  const { STREAMS, GROUPS } = queue;
  const worker = dependencies.worker || buildGlobalEventBoundaryStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || queue.consumerName("global-event-boundary");
  let stopped = false;

  async function processBatch(entries) {
    if (worker.processEntries) return worker.processEntries(entries);
    for (const entry of entries) await worker.processEntry(entry);
  }

  async function loop() {
    await queue.ensureGroup(STREAMS.GLOBAL_EVENT_BOUNDARY, GROUPS.GLOBAL_EVENT_BOUNDARY);
    while (!stopped) {
      try {
        const reclaimed = await queue.reclaimIdle({
          stream: STREAMS.GLOBAL_EVENT_BOUNDARY, group: GROUPS.GLOBAL_EVENT_BOUNDARY,
          consumer, minIdleMs: RECLAIM_IDLE_MS, count: READ_COUNT,
        });
        if (reclaimed.length) { await processBatch(reclaimed); continue; }
        const entries = await queue.readGroup({
          stream: STREAMS.GLOBAL_EVENT_BOUNDARY, group: GROUPS.GLOBAL_EVENT_BOUNDARY,
          consumer, count: READ_COUNT, blockMs: 5000,
        });
        if (entries.length) await processBatch(entries);
      } catch (error) {
        logger.error?.("[GLOBAL_EVENT_QUEUE] worker loop failed", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  const running = loop();
  return {
    async stop() {
      stopped = true;
      await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 6000))]);
    },
  };
}

module.exports = { buildGlobalEventBoundaryStreamWorker, scheduleGlobalEventBoundaryStreamWorker };
