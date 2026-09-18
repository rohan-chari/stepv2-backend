const {
  STREAMS,
  GROUPS,
  ensureGroup,
  trimSafeHistory,
} = require("./redisStreams");

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_KEEP_RECENT = 1000;
const DEFAULT_QUEUES = Object.freeze([
  [STREAMS.STEP_SYNC, GROUPS.STEP_SYNC],
  [STREAMS.POWERUP_RECALC, GROUPS.POWERUP_RECALC],
  [STREAMS.RACE_DIRTY, GROUPS.RACE_DIRTY],
  [STREAMS.GLOBAL_EVENT_BOUNDARY, GROUPS.GLOBAL_EVENT_BOUNDARY],
  [STREAMS.NOTIFICATION_DELIVERY, GROUPS.NOTIFICATION_DELIVERY],
]);

function buildRedisStreamTrimmer(dependencies = {}) {
  const queues = dependencies.queues || DEFAULT_QUEUES;
  const keepRecent = Math.max(
    0,
    Math.floor(Number(dependencies.keepRecent) || DEFAULT_KEEP_RECENT),
  );
  const logger = dependencies.logger || console;

  async function tick() {
    const results = [];
    for (const [stream, group] of queues) {
      try {
        // The cron owner may start before a dedicated worker has created its
        // consumer group. Creating the group here is idempotent and makes the
        // trim contract explicit for every managed stream.
        await ensureGroup(stream, group);
        const result = await trimSafeHistory(stream, group, { keepRecent });
        results.push({ stream, group, ...result });
      } catch (error) {
        logger.error?.("[QUEUE_TRIM] stream trim failed", {
          stream,
          group,
          code: error?.code || error?.name || "QUEUE_TRIM_ERROR",
        });
        results.push({
          stream,
          group,
          errorCode: error?.code || error?.name || "QUEUE_TRIM_ERROR",
        });
      }
    }
    return results;
  }

  return { tick };
}

function scheduleRedisStreamTrimmer(dependencies = {}) {
  const worker = dependencies.worker || buildRedisStreamTrimmer(dependencies);
  const logger = dependencies.logger || console;
  const intervalMs = Math.max(
    10_000,
    Number(dependencies.intervalMs) || DEFAULT_INTERVAL_MS,
  );
  let stopped = false;
  let running = null;

  const tick = () => {
    if (stopped || running) return running;
    running = Promise.resolve()
      .then(() => worker.tick())
      .catch((error) => {
        logger.error?.("[QUEUE_TRIM] tick failed", error);
        return [];
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  void tick();
  const interval = setInterval(tick, intervalMs);
  interval.unref?.();

  return {
    tick,
    async stop() {
      stopped = true;
      clearInterval(interval);
      await running;
    },
  };
}

module.exports = {
  DEFAULT_INTERVAL_MS,
  DEFAULT_KEEP_RECENT,
  DEFAULT_QUEUES,
  buildRedisStreamTrimmer,
  scheduleRedisStreamTrimmer,
};
