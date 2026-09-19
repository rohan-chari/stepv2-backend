const { prisma: defaultPrisma } = require("../../../db");
const {
  ensureGroup,
  readGroup,
  ack,
  reclaimIdle,
  publish,
  STREAMS,
  GROUPS,
  consumerName,
} = require("../../../shared/queues/redisStreams");
const { parseStepSync, RACE_DIRTY_VERSION, POWERUP_RECALC_VERSION } =
  require("../../../shared/queues/workMessages");
const { normalizeSamples, removeOverlaps } = require("../commands/recordStepSamples");
const { StepSyncRequest: defaultStepSyncRequest } = require("../models/stepSyncRequest");
const { persistStepInput: defaultPersistStepInput } = require("../services/persistStepInput");
const { buildHistoricalRaceDiscovery } = require("../../races/services/historicalRaceDiscovery");
const {
  buildHistoricalRaceReconciliationIntentModel,
} = require("../../races/models/historicalRaceReconciliationIntent");
const {
  buildHistoricalRaceDiscoveryCursorModel,
} = require("../../races/models/historicalRaceDiscoveryCursor");
const { eventBus: defaultEventBus } = require("../../../shared/events/eventBus");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 10;
const CONCURRENCY = 3;
const LEASE_MS = 30_000;

function serializedSourceEnvelope(sourceEnvelope) {
  if (!sourceEnvelope) return null;
  return {
    changedStart: sourceEnvelope.changedStart.toISOString(),
    changedEnd: sourceEnvelope.changedEnd.toISOString(),
    changedBucketCount: sourceEnvelope.changedBucketCount || 0,
    sourceGeneration: String(sourceEnvelope.sourceGeneration),
  };
}

function hydrateSourceEnvelope(sourceEnvelope) {
  if (!sourceEnvelope) return null;
  return {
    changedStart: new Date(sourceEnvelope.changedStart),
    changedEnd: new Date(sourceEnvelope.changedEnd),
    changedBucketCount: Number(sourceEnvelope.changedBucketCount || 0),
    sourceGeneration: BigInt(sourceEnvelope.sourceGeneration),
  };
}

function buildStepSyncStreamWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const stepSyncRequest = dependencies.StepSyncRequest || defaultStepSyncRequest;
  const persistStepInput = dependencies.persistStepInput || defaultPersistStepInput;
  const events = dependencies.eventBus || defaultEventBus;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const findHistoricalRaces =
    dependencies.findHistoricalRaces || buildHistoricalRaceDiscovery({ prisma, now });
  const historicalIntentModel =
    dependencies.HistoricalRaceReconciliationIntent ||
    buildHistoricalRaceReconciliationIntentModel(prisma);
  const historicalCursorModel =
    dependencies.HistoricalRaceDiscoveryCursor ||
    buildHistoricalRaceDiscoveryCursorModel(prisma);

  async function persistMessage(message, requestOrder) {
    const cleaned = removeOverlaps(normalizeSamples(message.canonical.samples));
    const requestedAt = new Date(message.requestedAt);

    const beforeSourceWrites = null;

    async function execute(tx, reservation) {
      const result = await persistStepInput({
        tx,
        userId: message.userId,
        daily: {
          date: message.canonical.date,
          steps: message.canonical.steps,
        },
        samples: cleaned,
        requestTimestamp: requestedAt,
        requestOrder,
        beforeSourceWrites,
      });
      const responseJson = {
        state: "COMMITTED",
        generation: String(result.generation),
        dailyExisted: result.dailyExisted,
        record: result.record,
        sourceEnvelope: serializedSourceEnvelope(result.sourceEnvelope),
        scoringChanged: result.scoringChanged === true,
        repairRequired: result.repairRequired === true,
        canonicalCoverageThrough: result.canonicalCoverageThrough
          ? new Date(result.canonicalCoverageThrough).toISOString()
          : null,
      };
      await stepSyncRequest.finalize({
        id: reservation.id,
        responseJson,
        dailyExisted: result.dailyExisted,
        completedAt: result.completedAt,
        canonicalCoverageThrough: result.canonicalCoverageThrough,
        scoringInputGeneration: result.generation,
        now: result.completedAt,
      }, tx);
      return { reservationId: reservation.id, result, responseJson };
    }

    try {
      return await prisma.$transaction(async (tx) => {
        const reservation = await stepSyncRequest.createReservation({
          userId: message.userId,
          idempotencyKey: message.idempotencyKey,
          requestHash: message.requestHash,
          resolutionTimeZone: message.timeZone,
          leaseMs: LEASE_MS,
          now: now(),
        }, tx);
        return execute(tx, reservation);
      }, { timeout: 15_000, maxWait: 10_000 });
    } catch (error) {
      if (error?.code !== "P2002") throw error;
    }

    const existing = await stepSyncRequest.findByKey(
      message.userId,
      message.idempotencyKey,
    );
    if (!existing) {
      const error = new Error("step sync idempotency reservation disappeared");
      error.code = "STEP_SYNC_RESERVATION_MISSING";
      throw error;
    }
    if (existing.requestHash !== message.requestHash) {
      const error = new Error("Idempotency key already used");
      error.code = "IDEMPOTENCY_CONFLICT";
      error.nonRetryable = true;
      throw error;
    }
    if (existing.state === "COMPLETE") {
      const stored = existing.responseJson || {};
      return {
        reservationId: existing.id,
        replay: true,
        result: {
          generation: BigInt(stored.generation || existing.scoringInputGeneration || 1),
          dailyExisted: stored.dailyExisted === true,
          record: stored.record || null,
          sourceEnvelope: hydrateSourceEnvelope(stored.sourceEnvelope),
          canonicalCoverageThrough: stored.canonicalCoverageThrough
            ? new Date(stored.canonicalCoverageThrough)
            : existing.canonicalCoverageThrough,
          scoringChanged: stored.scoringChanged === true,
          repairRequired: stored.repairRequired === true,
        },
        responseJson: stored,
      };
    }

    const claimed = await prisma.$transaction(async (tx) => {
      const updated = await tx.stepSyncRequest.updateMany({
        where: {
          id: existing.id,
          state: "PROCESSING",
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now() } },
          ],
        },
        data: {
          leaseExpiresAt: new Date(now().getTime() + LEASE_MS),
          updatedAt: now(),
        },
      });
      if (updated.count !== 1) return null;
      const reservation = await tx.stepSyncRequest.findUnique({
        where: { id: existing.id },
      });
      return execute(tx, reservation);
    }, { timeout: 15_000, maxWait: 10_000 });

    if (!claimed) {
      const error = new Error("step sync is already being processed");
      error.code = "STEP_SYNC_BUSY";
      throw error;
    }
    return claimed;
  }

  async function activeRacesForUser(userId) {
    return prisma.$queryRawUnsafe(
      `SELECT race.id AS "raceId",
              participant.id AS "participantId",
              race.max_participants AS "maxParticipants",
              race.powerups_enabled AS "powerupsEnabled",
              race.powerup_step_interval AS "powerupStepInterval",
              participant.forfeited_at AS "forfeitedAt"
         FROM races race
         JOIN race_participants participant ON participant.race_id=race.id
        WHERE race.status='active'
          AND participant.user_id=$1
          AND participant.status='accepted'
        ORDER BY race.id`,
      userId,
    );
  }

  async function publishDownstream(message, persisted) {
    const generation = String(persisted.result.generation);
    const races = await activeRacesForUser(message.userId);
    for (const race of races) {
      await publish(STREAMS.RACE_DIRTY, {
        schemaVersion: RACE_DIRTY_VERSION,
        raceId: race.raceId,
        userId: message.userId,
        timeZone: message.timeZone,
        sourceGeneration: generation,
        reason: "STEP_INPUT_CHANGED",
        requestedAt: now().toISOString(),
      });
      if (
        race.powerupsEnabled === true &&
        Number(race.powerupStepInterval) > 0 &&
        race.forfeitedAt == null
      ) {
        await publish(STREAMS.POWERUP_RECALC, {
          schemaVersion: POWERUP_RECALC_VERSION,
          userId: message.userId,
          raceId: race.raceId,
          participantId: race.participantId,
          sourceGeneration: generation,
          requestedAt: now().toISOString(),
        });
      }
    }
  }

  async function reconcileHistorical(message, persisted) {
    const sourceEnvelope = persisted.result.sourceEnvelope;
    if (!sourceEnvelope) return;
    const discovered = await findHistoricalRaces({
      userId: message.userId,
      changedStart: sourceEnvelope.changedStart,
      changedEnd: sourceEnvelope.changedEnd,
      cursor: null,
      limit: 100,
    });
    const completed = discovered.rows.filter(
      (row) => String(row.raceStatus).toLowerCase() === "completed",
    );
    if (completed.length) {
      await historicalIntentModel.admitMany({
        rows: completed,
        changedStart: sourceEnvelope.changedStart,
        changedEnd: sourceEnvelope.changedEnd,
        sourceGeneration: persisted.result.generation,
        now: new Date(message.requestedAt),
      });
    }
    if (discovered.nextCursor) {
      await historicalCursorModel.upsert({
        userId: message.userId,
        changedStart: sourceEnvelope.changedStart,
        changedEnd: sourceEnvelope.changedEnd,
        sourceGeneration: persisted.result.generation,
        cursor: discovered.nextCursor,
        now: new Date(message.requestedAt),
      });
    }
  }

  async function afterCommit(message, persisted) {
    try {
      await require("../services/dailyStepsCache").invalidateSafe(
        message.userId,
        message.canonical.date,
      );
    } catch (error) {
      logger.warn?.("[STEP_STREAM] daily cache invalidation failed", {
        code: error?.code || error?.name,
      });
    }
    try {
      if (await stepSyncRequest.claimEventsEmission(persisted.reservationId, now())) {
        events.emit(
          persisted.result.dailyExisted ? "STEPS_UPDATED" : "STEPS_RECORDED",
          {
            userId: message.userId,
            steps: message.canonical.steps,
            date: message.canonical.date,
          },
        );
      }
    } catch (error) {
      logger.warn?.("[STEP_STREAM] step event emission failed", {
        code: error?.code || error?.name,
      });
    }

    if (message.legacyEventRecap && message.canonical.samples.length > 0) {
      try {
        await require("../../home/services/legacyEventRecapInput").finalizeLegacyEventRecap({
          userId: message.userId,
          prisma,
          now,
        });
      } catch (error) {
        logger.warn?.("[STEP_STREAM] legacy recap deferred", {
          code: error?.code || error?.name,
        });
      }
    }

    await reconcileHistorical(message, persisted);
    if (persisted.result.scoringChanged || persisted.result.repairRequired) {
      await publishDownstream(message, persisted);
    }
  }

  async function processEntry(entry) {
    let message;
    try {
      message = parseStepSync(entry.fields);
      const persisted = await persistMessage(message, entry.id);
      await afterCommit(message, persisted);
      await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, entry.id);
      return true;
    } catch (error) {
      if (error?.nonRetryable === true) {
        logger.error("[STEP_STREAM] terminal message error", {
          messageId: entry.id,
          code: error.code || error.name,
        });
        await ack(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC, entry.id);
        return false;
      }
      logger.error("[STEP_STREAM] processing failed", {
        messageId: entry.id,
        code: error?.code || error?.name || "STEP_STREAM_ERROR",
      });
      return false;
    }
  }

  return { processEntry };
}

function scheduleStepSyncStreamWorker(dependencies = {}) {
  const worker = dependencies.worker || buildStepSyncStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || consumerName("step");
  const concurrency = Math.max(1, Number(dependencies.concurrency) || CONCURRENCY);
  let stopped = false;
  let running = Promise.resolve();

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
    await ensureGroup(STREAMS.STEP_SYNC, GROUPS.STEP_SYNC);
    while (!stopped) {
      try {
        const reclaimed = await reclaimIdle({
          stream: STREAMS.STEP_SYNC,
          group: GROUPS.STEP_SYNC,
          consumer,
          minIdleMs: RECLAIM_IDLE_MS,
          count: 25,
        });
        if (reclaimed.length) {
          await processBatch(reclaimed);
          continue;
        }
        const entries = await readGroup({
          stream: STREAMS.STEP_SYNC,
          group: GROUPS.STEP_SYNC,
          consumer,
          count: READ_COUNT,
          blockMs: 5000,
        });
        if (entries.length) await processBatch(entries);
      } catch (error) {
        logger.error("[STEP_STREAM] loop error", error);
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
  buildStepSyncStreamWorker,
  scheduleStepSyncStreamWorker,
};
