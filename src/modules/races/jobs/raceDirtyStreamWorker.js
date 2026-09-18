const {
  ensureGroup,
  readGroup,
  ack,
  reclaimIdle,
  STREAMS,
  GROUPS,
  consumerName,
} = require("../../../shared/queues/redisStreams");
const { parseRaceDirty } = require("../../../shared/queues/workMessages");
const {
  RaceResolutionJobV2: defaultJobModel,
} = require("../models/raceResolutionJobV2");
const {
  buildRaceResolutionWorkerV2,
} = require("./raceResolutionQueueV2");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 10;
const CONCURRENCY = 2;

function dirtyEnvelopeFor(message) {
  if (message.reason === "POWERUP_STATE_CHANGED") {
    return {
      reason: "POWERUP_MUTATION",
      dirtyUserIds: message.userId ? [message.userId] : [],
      dirtyParticipantIds: [],
      powerupTypes: [],
      priority: "IMMEDIATE",
    };
  }
  return {
    reason: message.reason || "STEP_INPUT_CHANGED",
    dirtyUserIds: message.userId ? [message.userId] : [],
    dirtyParticipantIds: [],
    powerupTypes: [],
    priority: "IMMEDIATE",
  };
}

function buildRaceDirtyStreamWorker(dependencies = {}) {
  const jobModel = dependencies.RaceResolutionJobV2 || defaultJobModel;
  const resolver = dependencies.resolver || buildRaceResolutionWorkerV2({
    ...dependencies,
    RaceResolutionJobV2: jobModel,
    processRole: "resolution",
  });
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;

  async function processMessage(message) {
    // Redis is the work transport. The existing per-race row is retained only
    // as the proven generation/fencing state used by the authoritative scoring
    // engine; this worker targets the race immediately rather than polling that
    // table as a queue.
    const job = message.jobGeneration
      ? await jobModel.findByRaceId(message.raceId)
      : await jobModel.enqueue({
          raceId: message.raceId,
          userId: message.userId,
          resolutionTimeZone: null,
          now: now(),
          dirtyEnvelope: dirtyEnvelopeFor(message),
          burstCoalescing: false,
          queuedGenerationMerge: true,
          bypassDebounce: true,
          queuePriority: "LIVE",
        });
    if (!job) return { skipped: true };
    const generation = message.jobGeneration || Number(job.generation);
    const processed = await resolver.processRace({
      raceId: message.raceId,
      generation,
    });
    if (!processed) {
      const error = new Error("race resolution did not complete");
      error.code = "RACE_DIRTY_NOT_RESOLVED";
      throw error;
    }
    return processed;
  }

  async function processEntry(entry) {
    try {
      const message = parseRaceDirty(entry.fields);
      await processMessage(message);
      await ack(STREAMS.RACE_DIRTY, GROUPS.RACE_DIRTY, entry.id);
      return true;
    } catch (error) {
      logger.error("[RACE_DIRTY_STREAM] processing failed", {
        messageId: entry.id,
        code: error?.code || error?.name || "RACE_DIRTY_STREAM_ERROR",
      });
      return false;
    }
  }

  return { processEntry, processMessage, resolver };
}

function scheduleRaceDirtyStreamWorker(dependencies = {}) {
  const worker = dependencies.worker || buildRaceDirtyStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || consumerName("race");
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
    await ensureGroup(STREAMS.RACE_DIRTY, GROUPS.RACE_DIRTY);
    while (!stopped) {
      try {
        const reclaimed = await reclaimIdle({
          stream: STREAMS.RACE_DIRTY,
          group: GROUPS.RACE_DIRTY,
          consumer,
          minIdleMs: RECLAIM_IDLE_MS,
          count: 25,
        });
        if (reclaimed.length) {
          await processBatch(reclaimed);
          continue;
        }
        const entries = await readGroup({
          stream: STREAMS.RACE_DIRTY,
          group: GROUPS.RACE_DIRTY,
          consumer,
          count: READ_COUNT,
          blockMs: 5000,
        });
        if (entries.length) await processBatch(entries);
      } catch (error) {
        logger.error("[RACE_DIRTY_STREAM] loop error", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  running = loop();
  return {
    worker,
    async stop() {
      stopped = true;
      await Promise.race([
        running,
        new Promise((resolve) => setTimeout(resolve, 6000)),
      ]);
      await worker.resolver?.beginDrain?.();
    },
  };
}

module.exports = {
  buildRaceDirtyStreamWorker,
  scheduleRaceDirtyStreamWorker,
};
