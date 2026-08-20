const { prisma: defaultPrisma } = require("../../db");
const { JobRun: defaultJobRun } = require("../../shared/db/jobRun");
const { dailyRunKey } = require("../../shared/time/etSchedule");
const {
  destructiveCleanupDisabled,
} = require("../../shared/config/operationalControls");

const JOB_NAME = "activation_event_cleanup";
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const TARGET_HOUR_ET = 2;
const RETENTION_DAYS = 90;

function buildCleanupActivationEvents(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const jobRunModel = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const retentionDays = dependencies.retentionDays || RETENTION_DAYS;
  const env = dependencies.env || process.env;

  return async function cleanupActivationEvents() {
    if (destructiveCleanupDisabled("ACTIVATION_EVENT_CLEANUP_DISABLED", env)) {
      return null;
    }
    const currentTime = now();
    const lastRanFor = await jobRunModel.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({
      now: currentTime,
      targetHour: dependencies.targetHour ?? TARGET_HOUR_ET,
      lastRanFor,
    });
    if (!runKey) return null;

    // Atomic CAS claim BEFORE doing the work. Prod runs pm2 in CLUSTER mode, so
    // every worker ticks this interval; with the old read-then-markRan shape all
    // of them observed "not ran yet" and each issued its own deleteMany (see the
    // markRan warning in models/jobRun.js). claimRun flips the row atomically so
    // exactly one worker proceeds, and it already persists runKey — no separate
    // markRan call. Same per-tick CAS pattern as modules/notifications/dailyRewardReminder.js.
    let claimed = false;
    try {
      claimed = await jobRunModel.claimRun(JOB_NAME, runKey);
    } catch (error) {
      logger.error("[CRON] activationEventCleanup: claimRun failed:", error);
      return null;
    }
    if (!claimed) return null;

    const cutoff = new Date(
      currentTime.getTime() - retentionDays * 24 * 60 * 60 * 1000
    );
    const result = await prisma.activationEvent.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    logger.log(
      `[CRON] Activation cleanup: deleted ${result?.count ?? 0} rows older than ${cutoff.toISOString()}`
    );
    return result;
  };
}

function scheduleActivationEventCleanup(dependencies = {}) {
  const run = buildCleanupActivationEvents(dependencies);
  const logger = dependencies.logger || console;
  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] activationEventCleanup tick error:", error);
    }
  }
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  if (interval.unref) interval.unref();
  logger.log("[CRON] Activation cleanup scheduled (2am ET, 90d retention)");
}

module.exports = {
  buildCleanupActivationEvents,
  scheduleActivationEventCleanup,
  JOB_NAME,
};
