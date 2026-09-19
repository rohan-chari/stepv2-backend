const { parseRaceDirty } = require("../../../shared/queues/workMessages");

const RECLAIM_IDLE_MS = 30_000;
const READ_COUNT = 100;
const CONCURRENCY = 2;
const CLAIM_UNAVAILABLE = "RACE_STREAM_CLAIM_UNAVAILABLE";

function dirtyEnvelopeFor(message) {
  return {
    reason: message.reason === "POWERUP_STATE_CHANGED" ? "POWERUP_MUTATION" : message.reason || "STEP_INPUT_CHANGED",
    dirtyUserIds: message.userId ? [message.userId] : [],
    dirtyParticipantIds: [], powerupTypes: [],
    priority: message.reason === "GLOBAL_EVENT_BOUNDARY" ? "COALESCE" : "IMMEDIATE",
  };
}

function buildRaceDirtyStreamWorker(dependencies = {}) {
  const jobModel = dependencies.RaceResolutionJobV2 || require("../models/raceResolutionJobV2").RaceResolutionJobV2;
  const queue = dependencies.queue || require("../../../shared/queues/redisStreams");
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  // Reuse the existing engine and its model-injection contract. Only this
  // queue-owned instance refuses forced claims; HTTP compatibility is unchanged.
  // An unavailable claim exits before the engine creates a scoring attempt,
  // rather than entering processRace's compatibility polling loop.
  const streamJobModel = {
    ...jobModel,
    async claimNext(options) {
      const job = await jobModel.claimNext({ ...options, force: false });
      if (!job) {
        const error = new Error("race stream claim is not ready");
        error.code = CLAIM_UNAVAILABLE;
        throw error;
      }
      return job;
    },
  };
  const resolver = dependencies.resolver || (dependencies.buildRaceResolutionWorkerV2 || require("./raceResolutionQueueV2").buildRaceResolutionWorkerV2)({
    ...dependencies, RaceResolutionJobV2: streamJobModel, processRole: "resolution",
  });
  const inFlight = new Map();
  const { STREAMS, GROUPS } = queue;

  function covered(job, generation) {
    // A running/failed/queued row is not proof that its processing generation
    // committed. Conservatively retain the wake until a successful generation
    // covers it; newer work can then complete through the same pending entry.
    return job?.state === "SUCCEEDED" && job.lastCompletedAt && generation > 0 &&
      Number(job.processingGeneration) >= generation;
  }

  function waiting(job) {
    const current = new Date(now()).getTime();
    if (job?.state === "FAILED") return { outcome: "TERMINAL_FAILED", retryAt: current + RECLAIM_IDLE_MS };
    if (job?.state === "RUNNING") return { outcome: "BUSY", retryAt: current + 1000 };
    const dueAt = Math.max(
      new Date(job?.notBeforeAt || 0).getTime(),
      new Date(job?.retryAt || 0).getTime(),
    );
    return { outcome: "DEFERRED", retryAt: dueAt > current ? dueAt : current + 1000 };
  }

  async function processGroup(group) {
    const raceId = group[0].message.raceId;
    // Old single-user messages still have to persist their complete scope.
    // Generation wakes from the new boundary producer have already done so.
    const unpreparedByReason = new Map();
    for (const item of group) {
      const known = item.entry._raceJobGeneration || item.message.jobGeneration;
      if (known) { item.entry._raceJobGeneration = known; continue; }
      const reason = item.message.reason;
      if (!unpreparedByReason.has(reason)) unpreparedByReason.set(reason, []);
      unpreparedByReason.get(reason).push(item);
    }
    for (const items of unpreparedByReason.values()) {
      const message = items[0].message;
      const userIds = [...new Set(items.map((item) => item.message.userId).filter(Boolean))].sort();
      const boundary = message.reason === "GLOBAL_EVENT_BOUNDARY";
      const job = await jobModel.enqueue({
        raceId, triggeredUserIds: userIds, resolutionTimeZone: message.timeZone,
        now: now(), dirtyEnvelope: { ...dirtyEnvelopeFor(message), dirtyUserIds: userIds },
        burstCoalescing: boundary, queuedGenerationMerge: true,
        bypassDebounce: !boundary, queuePriority: "LIVE",
      });
      if (!job || !Number.isSafeInteger(Number(job.generation)) || Number(job.generation) < 1) {
        throw new Error("race stream work was not persisted");
      }
      for (const item of items) item.entry._raceJobGeneration = Number(job.generation);
    }
    const generation = Math.max(...group.map((item) => item.entry._raceJobGeneration));
    let current = await jobModel.findByRaceId(raceId);
    let outcome = "COVERED";
    if (!covered(current, generation)) {
      const at = new Date(now()).getTime();
      const dueAt = Math.max(new Date(current?.notBeforeAt || 0).getTime(), new Date(current?.retryAt || 0).getTime());
      const busy = current?.state === "RUNNING" && new Date(current.leaseExpiresAt || 0).getTime() > at;
      if (!current || current.state === "FAILED" || busy || (current.state === "QUEUED" && dueAt > at)) {
        return group.map(({ entry }) => ({ entry, ...waiting(current) }));
      }
      try {
        await resolver.processRace({ raceId, generation });
      } catch (error) {
        if (error?.code !== CLAIM_UNAVAILABLE) throw error;
      }
      current = await jobModel.findByRaceId(raceId);
      if (!covered(current, generation)) return group.map(({ entry }) => ({ entry, ...waiting(current) }));
      outcome = "COMMITTED";
    }
    const results = [];
    for (const { entry } of group) {
      if (entry.id) await queue.ack(STREAMS.RACE_DIRTY, GROUPS.RACE_DIRTY, entry.id);
      results.push({ entry, outcome, completed: true });
    }
    return results;
  }

  async function processEntries(entries) {
    const byRace = new Map();
    const results = [];
    for (const entry of entries) {
      try {
        const message = parseRaceDirty(entry.fields);
        if (!byRace.has(message.raceId)) byRace.set(message.raceId, []);
        byRace.get(message.raceId).push({ entry, message });
      } catch (error) {
        logger.error?.("[RACE_DIRTY_STREAM] invalid message", { messageId: entry.id, code: error?.code || error?.name });
        results.push({ entry, outcome: "RETRY", retryAt: new Date(now()).getTime() + RECLAIM_IDLE_MS });
      }
    }
    const groups = [...byRace.values()];
    let cursor = 0;
    async function consume() {
      while (cursor < groups.length) {
        const group = groups[cursor++];
        const raceId = group[0].message.raceId;
        const previous = inFlight.get(raceId) || Promise.resolve();
        const run = previous.catch(() => {}).then(async () => {
          // Preserve per-race ordering across incompatible timezone contexts.
          // Do not replace an earlier context with the last message's fields.
          let offset = 0;
          while (offset < group.length) {
            let end = offset + 1;
            while (end < group.length && group[end].message.timeZone === group[offset].message.timeZone) end += 1;
            const processed = await processGroup(group.slice(offset, end));
            results.push(...processed);
            const deferred = processed.find((result) => !result.completed);
            if (deferred) {
              for (const { entry } of group.slice(end)) results.push({ entry, outcome: "DEFERRED", retryAt: deferred.retryAt });
              break;
            }
            offset = end;
          }
        });
        inFlight.set(raceId, run);
        try { await run; }
        catch (error) {
          logger.error?.("[RACE_DIRTY_STREAM] processing failed", { code: error?.code || error?.name || "RACE_DIRTY_STREAM_ERROR" });
          const completed = new Set(results.filter((result) => result.completed).map((result) => result.entry));
          for (const { entry } of group) if (!completed.has(entry)) {
            results.push({ entry, outcome: "RETRY", retryAt: new Date(now()).getTime() + 1000 });
          }
        } finally {
          if (inFlight.get(raceId) === run) inFlight.delete(raceId);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, groups.length) }, consume));
    return results;
  }

  async function acknowledgeTerminalFailure(entry) {
    const message = parseRaceDirty(entry.fields);
    const generation = Number(entry._raceJobGeneration || message.jobGeneration);
    if (!entry.id || !Number.isSafeInteger(generation) || generation < 1) return false;
    // recordFailure already committed both the error and pending/processing
    // scopes. That row, not an indefinitely pending Redis entry, owns recovery.
    const job = await jobModel.findByRaceId(message.raceId);
    const failedGeneration = Number(job?.generation);
    if (!job?.id || job.state !== "FAILED" || !job.completedAt ||
        !Number.isSafeInteger(failedGeneration) || failedGeneration < generation) return false;
    logger.error?.(JSON.stringify({
      event: "race_stream_terminal_failure_v1", outcome: "TERMINAL_FAILED",
      messageId: entry.id, jobId: job.id, raceId: message.raceId,
      generation: failedGeneration, errorCode: job.lastErrorCode || "RACE_RESOLUTION_FAILED",
      recoverySource: "race_resolution_jobs_v2",
    }));
    // ACK is transport completion, not scoring success. Never delete or mutate
    // the failed row here. If Redis fails, the same handoff can be retried.
    await queue.ack(STREAMS.RACE_DIRTY, GROUPS.RACE_DIRTY, entry.id);
    return true;
  }

  return {
    processEntries,
    acknowledgeTerminalFailure,
    processEntry: async (entry) => (await processEntries([entry]))[0]?.completed === true,
    processMessage: async (message) => (await processEntries([{ fields: message }]))[0],
    resolver,
  };
}

function scheduleRaceDirtyStreamWorker(dependencies = {}) {
  const queue = dependencies.queue || require("../../../shared/queues/redisStreams");
  const { STREAMS, GROUPS } = queue;
  const worker = dependencies.worker || buildRaceDirtyStreamWorker(dependencies);
  const logger = dependencies.logger || console;
  const consumer = dependencies.consumer || queue.consumerName("race");
  const now = dependencies.now || (() => new Date());
  const buffer = new Map();
  let stopped = false;

  async function loop() {
    await queue.ensureGroup(STREAMS.RACE_DIRTY, GROUPS.RACE_DIRTY);
    while (!stopped) {
      try {
        const current = new Date(now()).getTime();
        const firstByRace = new Map();
        for (const item of buffer.values()) {
          const raceId = item.entry.fields.raceId || item.entry.id;
          if (!firstByRace.has(raceId)) firstByRace.set(raceId, item.retryAt);
        }
        const due = [...buffer.values()].filter((item) =>
          firstByRace.get(item.entry.fields.raceId || item.entry.id) <= current,
        ).map((item) => item.entry);
        if (due.length) {
          const results = worker.processEntries ? await worker.processEntries(due) : await Promise.all(due.map(async (entry) => ({
            entry, completed: await worker.processEntry(entry), retryAt: current + 1000,
          })));
          for (const result of results) {
            const failureHandled = result.outcome === "TERMINAL_FAILED" &&
              await worker.acknowledgeTerminalFailure?.(result.entry);
            if (result.completed || failureHandled) {
              buffer.delete(result.entry.id);
            } else buffer.set(result.entry.id, { entry: result.entry, retryAt: result.retryAt || current + 1000 });
          }
        }
        if (stopped) break;
        const available = READ_COUNT - buffer.size;
        const nextByRace = new Map();
        for (const item of buffer.values()) {
          const raceId = item.entry.fields.raceId || item.entry.id;
          if (!nextByRace.has(raceId)) nextByRace.set(raceId, item.retryAt);
        }
        const untilNext = buffer.size ? Math.max(1, Math.min(5000,
          Math.min(...nextByRace.values()) - new Date(now()).getTime(),
        )) : 5000;
        if (available <= 0) {
          // Bounded backpressure. No database connection or scoring slot is held
          // while waiting; unacknowledged stream entries are the recovery record.
          await new Promise((resolve) => setTimeout(resolve, untilNext));
          continue;
        }
        let entries = await queue.reclaimIdle({
          stream: STREAMS.RACE_DIRTY, group: GROUPS.RACE_DIRTY, consumer,
          minIdleMs: RECLAIM_IDLE_MS, count: available,
        });
        if (!entries.length) entries = await queue.readGroup({
          stream: STREAMS.RACE_DIRTY, group: GROUPS.RACE_DIRTY, consumer,
          count: available, blockMs: untilNext,
        });
        for (const entry of entries) if (!buffer.has(entry.id)) buffer.set(entry.id, { entry, retryAt: 0 });
      } catch (error) {
        logger.error?.("[RACE_DIRTY_STREAM] loop error", error);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  const running = loop();
  return {
    worker,
    async stop() {
      stopped = true;
      await Promise.race([running, new Promise((resolve) => setTimeout(resolve, 6000))]);
      await worker.resolver?.beginDrain?.();
    },
  };
}

function scheduleRaceResolutionRecoverySweep(dependencies = {}) {
  const jobModel = dependencies.RaceResolutionJobV2 || require("../models/raceResolutionJobV2").RaceResolutionJobV2;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  const intervalMs = Math.max(10_000, Number(dependencies.intervalMs) || 60_000);
  const cleanupIntervalMs = Math.max(
    60_000,
    Number(dependencies.cleanupIntervalMs) || 5 * 60_000,
  );
  const terminalRetentionMs = Math.max(
    24 * 60 * 60 * 1000,
    Number(dependencies.terminalRetentionMs) || 14 * 24 * 60 * 60 * 1000,
  );
  const cleanupBatchSize = Math.min(
    5000,
    Math.max(1, Number(dependencies.cleanupBatchSize) || 1000),
  );
  const resolver = dependencies.resolver || require("./raceResolutionQueueV2").buildRaceResolutionWorkerV2({
    ...dependencies,
    RaceResolutionJobV2: jobModel,
    processRole: "resolution",
  });

  let stopped = false;
  let recoveryRunning = false;
  let cleanupRunning = false;

  async function recoveryTick() {
    if (stopped || recoveryRunning) return 0;
    recoveryRunning = true;
    try {
      const candidates = await jobModel.listRecoveryCandidates({
        now: now(),
        queuedLimit: 50,
        runningLimit: 50,
      });
      let processed = 0;
      for (const job of candidates) {
        if (stopped) break;
        try {
          const result = await resolver.processRace({
            raceId: job.raceId,
            generation: Number(job.generation),
          });
          if (result) processed += 1;
        } catch (error) {
          logger.error("[RACE_RECOVERY] candidate failed", {
            raceId: job.raceId,
            code: error?.code || error?.name || "RACE_RECOVERY_ERROR",
          });
        }
      }
      return processed;
    } finally {
      recoveryRunning = false;
    }
  }

  async function cleanupTick() {
    if (stopped || cleanupRunning) return 0;
    cleanupRunning = true;
    try {
      return await jobModel.cleanupTerminalJobs({
        before: new Date(now().getTime() - terminalRetentionMs),
        limit: cleanupBatchSize,
      });
    } catch (error) {
      logger.error("[RACE_RECOVERY] terminal cleanup failed", {
        code: error?.code || error?.name || "RACE_RECOVERY_CLEANUP_ERROR",
      });
      return 0;
    } finally {
      cleanupRunning = false;
    }
  }

  const recoveryTimer = setInterval(() => {
    recoveryTick().catch((error) =>
      logger.error("[RACE_RECOVERY] sweep failed", error));
  }, intervalMs);
  recoveryTimer.unref?.();

  const cleanupTimer = setInterval(() => {
    cleanupTick().catch((error) =>
      logger.error("[RACE_RECOVERY] cleanup sweep failed", error));
  }, cleanupIntervalMs);
  cleanupTimer.unref?.();

  // Do one bounded pass after startup, then rely on the fixed cadence.
  recoveryTick().catch((error) =>
    logger.error("[RACE_RECOVERY] startup sweep failed", error));
  cleanupTick().catch((error) =>
    logger.error("[RACE_RECOVERY] startup cleanup failed", error));

  return {
    recoveryTick,
    cleanupTick,
    async stop() {
      stopped = true;
      clearInterval(recoveryTimer);
      clearInterval(cleanupTimer);
      const deadline = Date.now() + 6000;
      while ((recoveryRunning || cleanupRunning) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
  };
}

module.exports = {
  buildRaceDirtyStreamWorker,
  scheduleRaceDirtyStreamWorker,
  scheduleRaceResolutionRecoverySweep,
};
