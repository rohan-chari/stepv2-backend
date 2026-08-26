const {
  buildNotificationProjector,
} = require("../services/notificationProjector");
const { buildGetDomainEventHealth } = require("../queries/getDomainEventHealth");

const TICK_INTERVAL_MS = 1_000;

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
  const run = buildDomainEventProjectionJob(dependencies);
  const logger = dependencies.logger || console;
  let running = null;
  const tick = () => {
    if (running) return running;
    running = run()
      .catch((error) => logger.error("[CRON] domainEventProjection tick error", {
        errorCode: error?.code || "PROJECTOR_TICK_ERROR",
      }))
      .finally(() => { running = null; });
    return running;
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Domain-event notification projection scheduled");
  return { tick, stop: () => clearInterval(interval) };
}

module.exports = {
  TICK_INTERVAL_MS,
  buildDomainEventProjectionJob,
  scheduleDomainEventProjection,
};
