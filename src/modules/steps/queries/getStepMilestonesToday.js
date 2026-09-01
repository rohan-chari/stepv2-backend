const { prisma } = require("../../../db");
const {
  STEP_MILESTONE_THRESHOLDS,
} = require("../constants/stepMilestones");
const {
  homeLaunchAuxiliaryBatch: defaultHomeLaunchAuxiliaryBatch,
} = require("../../home/services/homeLaunchAuxiliaryBatch");

function buildGetStepMilestonesToday(deps = {}) {
  const db = deps.prisma || prisma;
  const launchBatch = deps.homeLaunchAuxiliaryBatch ||
    (db === prisma ? defaultHomeLaunchAuxiliaryBatch : null);

  return async function getStepMilestonesToday({ userId, localDate }) {
    if (typeof localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      const err = new Error("Invalid localDate (expected YYYY-MM-DD)");
      err.statusCode = 400;
      throw err;
    }

    const { stepRecord, claims } = launchBatch
      ? await launchBatch.loadMilestones({ prisma: db, userId, localDate })
      : await Promise.all([
          db.step.findUnique({
            where: { userId_date: { userId, date: new Date(localDate) } },
          }),
          db.stepMilestoneClaim.findMany({
            where: { userId, claimedDate: localDate },
            select: { threshold: true },
          }),
        ]).then(([record, rows]) => ({ stepRecord: record, claims: rows }));

    const currentSteps = stepRecord?.steps ?? 0;
    const claimedSet = new Set(claims.map((c) => c.threshold));

    const milestones = STEP_MILESTONE_THRESHOLDS.map((m) => {
      const claimed = claimedSet.has(m.steps);
      return {
        threshold: m.steps,
        coins: m.coins,
        currentSteps,
        claimed,
        claimable: !claimed && currentSteps >= m.steps,
      };
    });

    const totalCoinsClaimed = milestones
      .filter((m) => m.claimed)
      .reduce((sum, m) => sum + m.coins, 0);

    return {
      localDate,
      currentSteps,
      milestones,
      totalCoinsClaimed,
    };
  };
}

const getStepMilestonesToday = buildGetStepMilestonesToday();

module.exports = { getStepMilestonesToday, buildGetStepMilestonesToday };
