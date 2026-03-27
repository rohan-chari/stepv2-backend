const { Steps } = require("../models/steps");
const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");
const { awardCoins: defaultAwardCoins } = require("./awardCoins");

function buildRecordSteps(dependencies = {}) {
  const stepsModel = dependencies.Steps || Steps;
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const awardCoinsFn = dependencies.awardCoins || defaultAwardCoins;
  const now = dependencies.now || (() => new Date());

  return async function recordSteps({ userId, steps, date }) {
    const existing = await stepsModel.findByUserIdAndDate(userId, date);

    let record;
    if (existing) {
      record = await stepsModel.update(existing.id, { steps });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_UPDATED", { userId, steps, date });
    } else {
      record = await stepsModel.create({ userId, steps, date });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_RECORDED", { userId, steps, date });
    }

    // Check daily step goal coin bonus
    try {
      const user = await userModel.findById(userId);
      const goal = user?.stepGoal;
      if (goal && goal > 0) {
        // 1x goal: 10 coins
        if (steps >= goal) {
          await awardCoinsFn({
            userId,
            amount: 10,
            reason: "daily_goal_1x",
            refId: date,
          });
        }
        // 2x goal: additional 10 coins
        if (steps >= goal * 2) {
          await awardCoinsFn({
            userId,
            amount: 10,
            reason: "daily_goal_2x",
            refId: date,
          });
        }
      }
    } catch (e) {
      // Don't fail step recording if coin award fails
      console.error("Failed to award daily goal coins:", e);
    }

    return record;
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps };
