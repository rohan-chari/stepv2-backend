const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const {
  FeedbackEmailAttempt: defaultAttemptModel,
  buildFeedbackEmailAttemptModel,
} = require("../models/feedbackEmailAttempt");

const JOB_NAME = "feedback_email_attempt_expiry";
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const BATCH_SIZE = 500;

function hourlyRunKey(now) {
  return now.toISOString().slice(0, 13);
}

function buildFeedbackEmailAttemptExpiry(dependencies = {}) {
  const attemptModel = dependencies.FeedbackEmailAttempt ||
    (dependencies.prisma
      ? buildFeedbackEmailAttemptModel({ prisma: dependencies.prisma })
      : defaultAttemptModel);
  const jobRun = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const batchSize = dependencies.batchSize || BATCH_SIZE;
  const logger = dependencies.logger || console;

  return async function expireFeedbackEmailAttempts() {
    const current = now();
    const runKey = hourlyRunKey(current);
    if (!(await jobRun.claimRun(JOB_NAME, runKey))) return null;
    let deleted = 0;
    let batches = 0;
    for (;;) {
      const count = await attemptModel.deleteExpiredBatch({
        before: current,
        batchSize,
      });
      if (count === 0) break;
      deleted += count;
      batches += 1;
      if (count < batchSize) break;
    }
    logger.log(`[CRON] Feedback email attempt expiry: deleted ${deleted} attempts`);
    return { deleted, batches };
  };
}

function scheduleFeedbackEmailAttemptExpiry(dependencies = {}) {
  const run = buildFeedbackEmailAttemptExpiry(dependencies);
  const logger = dependencies.logger || console;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    run().catch((error) =>
      logger.error("[CRON] feedbackEmailAttemptExpiry tick error:", error)
    );
  };
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  interval.unref?.();
  logger.log("[CRON] Feedback email attempt expiry scheduled (hourly durable claim, 7d retention)");
  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

module.exports = {
  BATCH_SIZE,
  JOB_NAME,
  TICK_INTERVAL_MS,
  buildFeedbackEmailAttemptExpiry,
  scheduleFeedbackEmailAttemptExpiry,
};
