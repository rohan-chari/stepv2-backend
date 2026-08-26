const { prisma: defaultPrisma } = require("../../../db");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const defaultRepository = require("../models/domainEventOutbox");

const JOB_NAME = "domain_event_retention";
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const TICK_INTERVAL_MS = 5 * 60 * 1000;
function buildDomainEventRetention(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const repository = dependencies.repository || defaultRepository;
  const JobRun = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  return async function retainDomainEvents() {
    const current = now();
    const lastRanFor = await JobRun.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({
      now: current,
      targetHour: dependencies.targetHour ?? 2,
      lastRanFor,
    });
    if (!runKey || !(await JobRun.claimRun(JOB_NAME, runKey))) return null;
    const cutoff = new Date(current.getTime() - RETENTION_MS);
    let deleted = 0;
    for (;;) {
      const candidates = await repository.findRetentionCandidates(prisma, {
        cutoff,
        pageSize: PAGE_SIZE,
      });
      if (!candidates.length) break;
      let pageDeleted = 0;
      for (const event of candidates) {
        const keys = event.projections.map((row) => row.deliveryKey);
        const active = await repository.countActiveDownstream(prisma, keys);
        if (active.schedules || active.inboxOutbox || active.deviceAttempts) continue;
        const removed = await repository.deleteRetainedEvent(prisma, {
          id: event.id,
          cutoff,
        });
        pageDeleted += removed.count;
      }
      deleted += pageDeleted;
      if (candidates.length < PAGE_SIZE || pageDeleted === 0) break;
    }
    logger.log("[CRON] Domain-event retention complete", { runKey, deleted });
    return { deleted };
  };
}

function scheduleDomainEventRetention(dependencies = {}) {
  const run = buildDomainEventRetention(dependencies);
  const logger = dependencies.logger || console;
  const tick = () => run().catch((error) => logger.error("[CRON] domainEventRetention tick error", {
    errorCode: error?.code || "DOMAIN_EVENT_RETENTION_ERROR",
  }));
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Domain-event retention scheduled (30d)");
  return { tick, stop: () => clearInterval(interval) };
}

module.exports = {
  JOB_NAME,
  RETENTION_MS,
  PAGE_SIZE,
  buildDomainEventRetention,
  scheduleDomainEventRetention,
};
