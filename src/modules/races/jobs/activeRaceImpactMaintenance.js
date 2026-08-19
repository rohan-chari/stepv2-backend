const { prisma: defaultPrisma } = require("../../../db");
const { JobRun: defaultJobRun } = require("../../../shared/db/jobRun");
const { dailyRunKey } = require("../../../shared/time/etSchedule");
const {
  readActiveImpactRolloutFence,
  stampIneligibleDueEffects,
} = require("../../../shared/config/activeImpactRolloutFence");

const BOUNDARY_INTERVAL_MS = 60 * 1000;
const RETENTION_INTERVAL_MS = 5 * 60 * 1000;
const RETENTION_DAYS = 30;
const RETENTION_JOB_NAME = "active_race_impact_retention";
const RETENTION_TARGET_HOUR_ET = 3;

function isDisabled(dependencies, key) {
  if (dependencies.disabled !== undefined) return dependencies.disabled === true;
  return process.env[key] === "true";
}

function buildActiveImpactBoundaryStamp(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const now = dependencies.now || (() => new Date());

  return async function stampSkippedBoundaries() {
    if (isDisabled(dependencies, "ACTIVE_RACE_IMPACT_BOUNDARY_SCANNER_DISABLED")) {
      return null;
    }
    return prisma.$transaction(async (tx) => {
      // Share-lock the same durable row that enable/disable transitions lock
      // exclusively. The check and every boundary stamp are therefore one
      // serializable decision; no enable can slip between them.
      const fence = await readActiveImpactRolloutFence(tx);
      if (fence.enabled) return { count: 0 };
      const count = await stampIneligibleDueEffects(tx, now());
      return { count };
    });
  };
}

function buildActiveImpactRetention(dependencies = {}) {
  const prisma = dependencies.prisma || defaultPrisma;
  const jobRunModel = dependencies.JobRun || defaultJobRun;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const retentionDays = dependencies.retentionDays || RETENTION_DAYS;

  return async function retainActiveImpactPresentation() {
    if (isDisabled(dependencies, "ACTIVE_RACE_IMPACT_RETENTION_DISABLED")) {
      return null;
    }

    const currentTime = now();
    const lastRanFor = await jobRunModel.lastRanFor(RETENTION_JOB_NAME);
    const runKey = dailyRunKey({
      now: currentTime,
      targetHour: dependencies.targetHour ?? RETENTION_TARGET_HOUR_ET,
      lastRanFor,
    });
    if (!runKey) return null;

    let claimed;
    try {
      claimed = await jobRunModel.claimRun(RETENTION_JOB_NAME, runKey);
    } catch (error) {
      logger.error("[CRON] active impact retention: claimRun failed:", error);
      return null;
    }
    if (!claimed) return null;

    const cutoff = new Date(
      currentTime.getTime() - retentionDays * 24 * 60 * 60 * 1000,
    );
    // Work is the aggregate root and the presentation snapshot cascades from
    // it. Never delete PENDING work, and never touch final RaceEffectImpact.
    const result = await prisma.activeRaceImpactWork.deleteMany({
      where: {
        updatedAt: { lt: cutoff },
        status: { in: ["ZERO", "CREATED", "SUPPRESSED_TERMINAL"] },
      },
    });
    logger.log(
      `[CRON] active impact retention: deleted ${result.count} processed work rows older than ${cutoff.toISOString()}`,
    );
    return result;
  };
}

function scheduleActiveRaceImpactMaintenance(dependencies = {}) {
  const stamp = buildActiveImpactBoundaryStamp(dependencies);
  const retain = buildActiveImpactRetention(dependencies);
  const logger = dependencies.logger || console;

  async function run(name, callback) {
    try {
      await callback();
    } catch (error) {
      logger.error(`[CRON] active impact ${name} tick error:`, error);
    }
  }
  run("boundary", stamp);
  run("retention", retain);
  const boundaryTimer = setInterval(
    () => run("boundary", stamp),
    dependencies.boundaryIntervalMs || BOUNDARY_INTERVAL_MS,
  );
  const retentionTimer = setInterval(
    () => run("retention", retain),
    dependencies.retentionIntervalMs || RETENTION_INTERVAL_MS,
  );
  boundaryTimer.unref?.();
  retentionTimer.unref?.();
  logger.log("[CRON] active impact boundary + 30-day presentation retention scheduled");
  return { boundaryTimer, retentionTimer };
}

module.exports = {
  buildActiveImpactBoundaryStamp,
  buildActiveImpactRetention,
  scheduleActiveRaceImpactMaintenance,
  RETENTION_DAYS,
  RETENTION_JOB_NAME,
};
