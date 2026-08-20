const { prisma: defaultPrisma } = require("../../../db");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const { invalidateInboxUnread } = require("../services/inbox");
const {
  destructiveCleanupDisabled,
} = require("../../../shared/config/operationalControls");

const JOB_NAME = "inbox_expiry";
const TICK_INTERVAL_MS = 5 * 60 * 1000;

// Durable, idempotent retention deletion. The daily job claim is recorded
// before deletion; each DELETE predicate is independently idempotent, and a
// transient database failure is surfaced to the next tick's monitoring rather
// than ever deleting outside the 30-day server clock boundary.
function buildInboxExpiry(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const jobRun = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  return async function expireInbox() {
    if (destructiveCleanupDisabled("INBOX_EXPIRY_DISABLED")) return null;
    const current = now();
    const lastRanFor = await jobRun.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({ now: current, targetHour: dependencies.targetHour ?? 3, lastRanFor });
    if (!runKey || !(await jobRun.claimRun(JOB_NAME, runKey))) return null;
    const affected = await prisma.$transaction(async (tx) => {
      const [alertsBefore, threadsBefore] = await Promise.all([
        tx.inboxAlert.findMany({ where: { expiresAt: { lte: current } }, select: { userId: true } }),
        tx.feedbackThread.findMany({ where: { expiresAt: { lte: current } }, select: { userId: true } }),
      ]);
      const [alerts, threads] = await Promise.all([
      tx.inboxAlert.deleteMany({ where: { expiresAt: { lte: current } } }),
      tx.feedbackThread.deleteMany({ where: { expiresAt: { lte: current } } }),
      ]);
      return { alerts, threads, userIds: [...new Set([...alertsBefore, ...threadsBefore].map((row) => row.userId))] };
    });
    await Promise.all(affected.userIds.map((userId) => invalidateInboxUnread(userId)));
    logger.log(`[CRON] Inbox expiry: deleted ${affected.alerts.count} alerts and ${affected.threads.count} threads`);
    return { alerts: affected.alerts.count, threads: affected.threads.count };
  };
}

function scheduleInboxExpiry(dependencies = {}) {
  const run = buildInboxExpiry(dependencies);
  const logger = dependencies.logger || console;
  const tick = () => run().catch((error) => logger.error("[CRON] inboxExpiry tick error:", error));
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Inbox expiry scheduled (3am ET, 30d retention)");
}

module.exports = { JOB_NAME, buildInboxExpiry, scheduleInboxExpiry };
