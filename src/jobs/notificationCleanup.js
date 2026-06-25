const { Notification } = require("../models/notification");
const { JobRun } = require("../models/jobRun");
const { dailyRunKey } = require("../utils/etSchedule");

const JOB_NAME = "notification_cleanup";
const TICK_INTERVAL_MS = 5 * 60 * 1000; // ride the shared 5-minute cadence
const TARGET_HOUR_ET = 1; // 1am ET
const RETENTION_DAYS = 7;

// Nightly prune of the notifications audit log: at 1am ET, delete rows older than
// a week. Rides the 5-minute tick like the other cron jobs and fires exactly once
// per ET day via the JobRun marker (restart-safe, DST-proof — see etSchedule.js).
// The DELETE is itself idempotent, so a retry after a failed mark is harmless.
function buildCleanupNotifications(dependencies = {}) {
  const notificationModel = dependencies.Notification || Notification;
  const jobRunModel = dependencies.JobRun || JobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const retentionDays = dependencies.retentionDays || RETENTION_DAYS;
  const targetHour = dependencies.targetHour ?? TARGET_HOUR_ET;

  // Returns the { count } deleted when it ran this tick, or null when the tick
  // wasn't the daily run.
  return async function cleanupNotifications() {
    const currentTime = now();

    const lastRanFor = await jobRunModel.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({
      now: currentTime,
      targetHour,
      lastRanFor,
    });
    if (!runKey) return null;

    const cutoff = new Date(
      currentTime.getTime() - retentionDays * 24 * 60 * 60 * 1000
    );

    const result = await notificationModel.deleteOlderThan(cutoff);
    // Mark only after a successful delete so a failure retries next tick.
    await jobRunModel.markRan(JOB_NAME, runKey);

    logger.log(
      `[CRON] Notification cleanup: deleted ${result?.count ?? 0} rows older than ` +
        `${cutoff.toISOString()} (run for ${runKey})`
    );
    return result;
  };
}

function scheduleNotificationCleanup(dependencies = {}) {
  const run = buildCleanupNotifications(dependencies);
  const logger = dependencies.logger || console;
  const interval = dependencies.intervalMs || TICK_INTERVAL_MS;

  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] notificationCleanup tick error:", error);
    }
  }

  tick(); // run once shortly after boot (no-op unless it's past 1am ET and unrun)
  setInterval(tick, interval);
  logger.log(
    `[CRON] Notification cleanup scheduled (1am ET, ${retentionDaysLabel(dependencies)} retention)`
  );
}

function retentionDaysLabel(dependencies) {
  return `${dependencies.retentionDays || RETENTION_DAYS}d`;
}

module.exports = {
  buildCleanupNotifications,
  scheduleNotificationCleanup,
  JOB_NAME,
};
