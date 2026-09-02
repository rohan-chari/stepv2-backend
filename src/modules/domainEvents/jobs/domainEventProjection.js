const {
  buildNotificationProjector,
} = require("../services/notificationProjector");
const { buildGetDomainEventHealth } = require("../queries/getDomainEventHealth");
const domainEventOutbox = require("../models/domainEventOutbox");
const { createPostgresWakeCoordinator } = require("../../../shared/queues/postgresWakeCoordinator");
const redisCache = require("../../../shared/cache/redisCache");

const TICK_INTERVAL_MS = 10_000;

function buildDomainEventProjectionJob(dependencies = {}) {
  const projector = dependencies.projector || buildNotificationProjector(dependencies);
  const getHealth = dependencies.getHealth || buildGetDomainEventHealth(dependencies);
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  let nextHealthAt = 0;
  let consecutiveBacklogMinutes = 0;
  return async function projectDomainEvents() {
    const result = await projector.run();
    const currentMs = now().getTime();
    if (currentMs >= nextHealthAt) {
      nextHealthAt = currentMs + 60_000;
      const health = await getHealth();
      const agedBacklog = (health.oldestEvent?.ageMs || 0) > 60_000 ||
        (health.oldestProjection?.ageMs || 0) > 60_000;
      consecutiveBacklogMinutes = agedBacklog ? consecutiveBacklogMinutes + 1 : 0;
      logger.log?.("[DOMAIN_EVENT] health", {
        pendingByType: health.pendingByType,
        projectionsByStatus: health.projectionsByStatus,
        downstream: health.downstream,
        terminalFailures: health.terminalFailures,
        consecutiveBacklogMinutes,
      });
      if (health.terminalFailures.events > 0 || health.terminalFailures.projections > 0 ||
          consecutiveBacklogMinutes >= 5) {
        logger.error?.("[DOMAIN_EVENT] notification backlog alert", {
          terminalFailures: health.terminalFailures,
          oldestEventAgeMs: health.oldestEvent?.ageMs || 0,
          oldestProjectionAgeMs: health.oldestProjection?.ageMs || 0,
          consecutiveBacklogMinutes,
        });
      }
    }
    return result;
  };
}

function scheduleDomainEventProjection(dependencies = {}) {
  const run = dependencies.run || buildDomainEventProjectionJob(dependencies);
  const logger = dependencies.logger || console;
  let running = null;
  const tick = () => {
    if (running) return running;
    running = run()
      .catch((error) => {
        logger.error("[CRON] domainEventProjection tick error", {
          errorCode: error?.code || "PROJECTOR_TICK_ERROR",
        });
        throw error;
      })
      .finally(() => { running = null; });
    return running;
  };
  const coordinator = createPostgresWakeCoordinator({
    queue: "domain-event",
    fallbackIntervalMs: dependencies.intervalMs || 10_000,
    drain: tick,
    nextDueAt: dependencies.nextDueAt || (() => domainEventOutbox.nextDueAt()),
    subscribeWake: dependencies.subscribeWake || redisCache.subscribeDurableQueueWakeup,
    logger,
    now: dependencies.coordinatorNow,
    setTimer: dependencies.setDueTimer,
    clearTimer: dependencies.clearDueTimer,
  });
  coordinator.start().catch((error) => logger.error(
    "[CRON] domainEventProjection wake coordinator error", error,
  ));
  logger.log("[CRON] Domain-event notification projection scheduled (wake-first, 10s recovery)");
  return { tick, coordinator, stop: () => coordinator.stop() };
}

module.exports = {
  TICK_INTERVAL_MS,
  buildDomainEventProjectionJob,
  scheduleDomainEventProjection,
};
