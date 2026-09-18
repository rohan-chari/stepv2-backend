const {
  nextBoundaryAt,
  publishDueBoundaries,
} = require("../services/globalEventRedisSchedule");

const RECOVERY_INTERVAL_MS = 60_000;

function buildGlobalEventBoundaryStreamScheduler(dependencies = {}) {
  const now = dependencies.now || (() => new Date());
  const publishDue = dependencies.publishDueBoundaries || publishDueBoundaries;
  return {
    async tick() {
      return publishDue({ now: now(), limit: dependencies.batchSize || 100 });
    },
    async nextDueAt() {
      return nextBoundaryAt();
    },
    async stop() {},
  };
}

function scheduleGlobalEventBoundaryStreamScheduler(dependencies = {}) {
  const worker = dependencies.worker || buildGlobalEventBoundaryStreamScheduler(dependencies);
  const logger = dependencies.logger || console;
  const nowMs = dependencies.nowMs || Date.now;
  const setTimer = dependencies.setTimeout || setTimeout;
  const clearTimer = dependencies.clearTimeout || clearTimeout;
  let stopped = false;
  let running = null;
  let timer = null;

  const arm = async () => {
    if (stopped) return;
    const next = await worker.nextDueAt();
    const delay = next
      ? Math.max(0, Math.min(RECOVERY_INTERVAL_MS, next.getTime() - nowMs()))
      : RECOVERY_INTERVAL_MS;
    if (timer) clearTimer(timer);
    timer = setTimer(tick, delay);
    timer.unref?.();
  };

  const tick = () => {
    if (stopped || running) return running;
    running = Promise.resolve()
      .then(() => worker.tick())
      .catch((error) => logger.error?.("[GLOBAL_EVENT_QUEUE] schedule tick failed", error))
      .finally(async () => {
        running = null;
        await arm();
      });
    return running;
  };

  void tick();
  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      await running;
    },
  };
}

module.exports = {
  RECOVERY_INTERVAL_MS,
  buildGlobalEventBoundaryStreamScheduler,
  scheduleGlobalEventBoundaryStreamScheduler,
};
