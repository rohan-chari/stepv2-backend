const { prisma: defaultPrisma } = require("../../../db");
const {
  bumpManyScoringInputVersions,
} = require("../services/scoringInputVersion");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const {
  destructiveCleanupDisabled,
} = require("../../../shared/config/operationalControls");

// step_samples retention cron (Five-Minute Step Samples §4.1). Finer buckets
// grow row counts ~5x; prune rows nothing can ever read again.
//
// Cutoff = period_end < now()-45d AND period_end < (oldest started_at among
// races NOT in a terminal status). 45 days comfortably exceeds the longest
// race/tournament-round + settlement grace; the second predicate makes the guard
// STRUCTURAL rather than assumed (a live/recomputable race can still read its own
// window). Deletes in bounded batches to avoid long row locks.
//
// Dedup: insert-first JobRun claim (claimRun), NEVER an advisory lock held across
// the callback (the 3e6c827 outage rule). pm2 runs CLUSTER mode, so every worker
// ticks — claimRun flips the (jobName, dayKey) row for exactly one of them.
const JOB_NAME = "step_sample_retention";
const TICK_INTERVAL_MS = 5 * 60 * 1000;
const TARGET_HOUR_ET = 3; // off-peak
const RETENTION_DAYS = 45;
const BATCH_SIZE = 5000;

function buildCleanupStepSamples(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const jobRunModel = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const retentionDays = dependencies.retentionDays || RETENTION_DAYS;
  const batchSize = dependencies.batchSize || BATCH_SIZE;
  const disabled =
    dependencies.disabled ??
    destructiveCleanupDisabled("STEP_SAMPLE_RETENTION_DISABLED");

  return async function cleanupStepSamples() {
    // Kill switch (§4.1). Checked before the claim so a disabled job never even
    // marks the tick — the first prod run must be manually observed.
    if (disabled) return null;

    const currentTime = now();
    const lastRanFor = await jobRunModel.lastRanFor(JOB_NAME);
    const runKey = dailyRunKey({
      now: currentTime,
      targetHour: dependencies.targetHour ?? TARGET_HOUR_ET,
      lastRanFor,
    });
    if (!runKey) return null;

    let claimed = false;
    try {
      claimed = await jobRunModel.claimRun(JOB_NAME, runKey);
    } catch (error) {
      logger.error("[CRON] stepSampleRetention: claimRun failed:", error);
      return null;
    }
    if (!claimed) return null;

    const cutoff45 = new Date(
      currentTime.getTime() - retentionDays * 24 * 60 * 60 * 1000
    );

    // Structural guard: the earliest sample any live/recomputable race could
    // still reference. Enum values are stored lowercase (@map'd). Null started_at
    // (PENDING races) are ignored — a race that hasn't started can't read past
    // samples.
    const guardRows = await prisma.$queryRawUnsafe(
      `SELECT MIN(started_at) AS oldest
       FROM races
       WHERE status NOT IN ('completed', 'cancelled')
         AND started_at IS NOT NULL`
    );
    const oldestNonTerminal =
      guardRows && guardRows[0] && guardRows[0].oldest ? guardRows[0].oldest : null;
    const guardIso = oldestNonTerminal
      ? new Date(oldestNonTerminal).toISOString()
      : null;

    let total = 0;
    for (;;) {
      const deletedUsers = await prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRawUnsafe(
          `DELETE FROM step_samples s USING (
             SELECT id FROM step_samples
             WHERE period_end < $1::timestamp
               AND period_end < COALESCE($2::timestamp, 'infinity'::timestamp)
             LIMIT ${batchSize}
           ) d
           WHERE s.id = d.id
           RETURNING s.user_id AS "userId"`,
          cutoff45.toISOString(),
          guardIso
        );
        await bumpManyScoringInputVersions(
          tx,
          rows.map((row) => row.userId)
        );
        return rows;
      });
      total += deletedUsers.length;
      if (deletedUsers.length < batchSize) break;
    }

    logger.log(
      `[CRON] step_samples retention: deleted ${total} rows older than ${cutoff45.toISOString()} (race guard: ${guardIso || "none"})`
    );
    return { count: total };
  };
}

function scheduleStepSampleRetention(dependencies = {}) {
  const run = buildCleanupStepSamples(dependencies);
  const logger = dependencies.logger || console;
  async function tick() {
    try {
      await run();
    } catch (error) {
      logger.error("[CRON] stepSampleRetention tick error:", error);
    }
  }
  tick();
  const interval = setInterval(tick, dependencies.intervalMs || TICK_INTERVAL_MS);
  if (interval.unref) interval.unref();
  logger.log(
    "[CRON] step_samples retention scheduled (3am ET, 45d + unsettled-race guard)"
  );
}

module.exports = {
  buildCleanupStepSamples,
  scheduleStepSampleRetention,
  JOB_NAME,
};
