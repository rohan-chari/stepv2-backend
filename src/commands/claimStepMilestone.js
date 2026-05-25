const { prisma } = require("../db");
const { awardCoins: defaultAwardCoins } = require("./awardCoins");
const {
  findMilestoneByThreshold,
} = require("../constants/stepMilestones");

class StepMilestoneError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "StepMilestoneError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function isValidLocalDate(str) {
  if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  const [y, m, d] = str.split("-").map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function withinOneDayOfServer(localDate) {
  const serverToday = new Date().toISOString().slice(0, 10);
  const diffDays =
    Math.abs(new Date(localDate) - new Date(serverToday)) /
    (1000 * 60 * 60 * 24);
  return diffDays <= 1.5;
}

function buildClaimStepMilestone(deps = {}) {
  const db = deps.prisma || prisma;
  const awardCoinsFn = deps.awardCoins || defaultAwardCoins;

  return async function claimStepMilestone({ userId, localDate, threshold }) {
    if (!isValidLocalDate(localDate)) {
      throw new StepMilestoneError(
        "Invalid localDate (expected YYYY-MM-DD)",
        400
      );
    }
    if (!withinOneDayOfServer(localDate)) {
      throw new StepMilestoneError(
        "localDate is too far from server time",
        400
      );
    }

    const thresholdInt = Number.parseInt(threshold, 10);
    const milestone = findMilestoneByThreshold(thresholdInt);
    if (!milestone) {
      throw new StepMilestoneError("Unknown milestone threshold", 400);
    }

    // Already claimed? Detect first so we can return 409 consistently.
    const existing = await db.stepMilestoneClaim.findUnique({
      where: {
        userId_claimedDate_threshold: {
          userId,
          claimedDate: localDate,
          threshold: milestone.steps,
        },
      },
    });
    if (existing) {
      throw new StepMilestoneError("Milestone already claimed today", 409);
    }

    // Confirm today's steps reach the threshold.
    const stepRecord = await db.step.findUnique({
      where: { userId_date: { userId, date: new Date(localDate) } },
    });
    const currentSteps = stepRecord?.steps ?? 0;
    if (currentSteps < milestone.steps) {
      throw new StepMilestoneError(
        `Threshold not reached (have ${currentSteps}, need ${milestone.steps})`,
        400
      );
    }

    // Insert claim row. Unique constraint catches racey duplicates → 409.
    try {
      await db.stepMilestoneClaim.create({
        data: {
          userId,
          claimedDate: localDate,
          threshold: milestone.steps,
          coins: milestone.coins,
        },
      });
    } catch (error) {
      if (error.code === "P2002") {
        throw new StepMilestoneError("Milestone already claimed today", 409);
      }
      throw error;
    }

    const result = await awardCoinsFn({
      userId,
      amount: milestone.coins,
      reason: "step_milestone",
      refId: `${localDate}:${milestone.steps}`,
    });

    return {
      threshold: milestone.steps,
      coins: milestone.coins,
      currentSteps,
      coinsAfter: result.coins,
    };
  };
}

const claimStepMilestone = buildClaimStepMilestone();

module.exports = {
  claimStepMilestone,
  buildClaimStepMilestone,
  StepMilestoneError,
};
