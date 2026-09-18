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
const {
  parsePowerupRecalc,
  RACE_DIRTY_VERSION,
} = require("../../../shared/queues/workMessages");
const {
  computeRaceState: defaultComputeRaceState,
} = require("../../races/services/computeRaceState");
const {
  syncRacePowerupState: defaultSyncRacePowerupState,
} = require("../../races/services/racePowerupStateSync");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 10;
const CONCURRENCY = 3;

function buildPowerupRecalcStreamWorker(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const computeRaceState = dependencies.computeRaceState || defaultComputeRaceState;
  const syncRacePowerupState =
    dependencies.syncRacePowerupState || defaultSyncRacePowerupState;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  async function processMessage(message) {
    const computed = await computeRaceState({
      raceId: message.raceId,
      userIds: [message.userId],
      timeZone: "UTC",
    });
    if (!computed?.result?.race) return { changed: false, skipped: true };

    const boxEffectiveSteps =
      computed.boxEffectiveStepsByUser?.[message.userId];
    if (!Number.isFinite(Number(boxEffectiveSteps))) {
      return { changed: false, skipped: true };
    }

    let syncResult;
    await prisma.$transaction(async (tx) => {
      syncResult = await syncRacePowerupState({
        raceId: message.raceId,
        userId: message.userId,
        race: computed.result.race,
        boxEffectiveSteps: Number(boxEffectiveSteps),
        tx,
      });
    }, { timeout: 15_000, maxWait: 10_000 });

    const changed =
      (syncResult?.newMysteryBoxes?.length || 0) > 0 ||
      Number(syncResult?.newQueuedBoxes || 0) > 0;

    if (changed) {
      await publish(STREAMS.RACE_DIRTY, {
        schemaVersion: RACE_DIRTY_VERSION,
        raceId: message.raceId,
        userId: message.userId,
        sourceGeneration: String(message.sourceGeneration),
        reason: "POWERUP_MUTATION",
        requestedAt: now().toISOString(),
      });
    }

    return { changed, syncResult };
  }

  async function processEntry(entry) {
    try {
      const message = parsePowerupRecalc(entry.fields);
      await processMessage(message);
      await ack(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC, entry.id);
      return true;
    } catch (error) {
      logger.error("[POWERUP_STREAM] processing failed", {
        messageId: entry.id,
        code: error?.code || error?.name || "POWERUP_STREAM_ERROR",
      });
      return false;
    }
  }

  return { processEntry, processMessage };
}

function schedulePowerupRecalcStreamWorker(dependencies = {}) {
  const worker = dependencies.worker || buildPowerupRecalcStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || consumerName("powerup");
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
    await ensureGroup(STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC);
    while (!stopped) {
      try {
        const reclaimed = await reclaimIdle({
          stream: STREAMS.POWERUP_RECALC,
          group: GROUPS.POWERUP_RECALC,
          consumer,
          minIdleMs: RECLAIM_IDLE_MS,
          count: 25,
        });
        if (reclaimed.length) {
          await processBatch(reclaimed);
          continue;
        }
        const entries = await readGroup({
          stream: STREAMS.POWERUP_RECALC,
          group: GROUPS.POWERUP_RECALC,
          consumer,
          count: READ_COUNT,
          blockMs: 5000,
        });
        if (entries.length) await processBatch(entries);
      } catch (error) {
        logger.error("[POWERUP_STREAM] loop error", error);
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
  buildPowerupRecalcStreamWorker,
  schedulePowerupRecalcStreamWorker,
};
