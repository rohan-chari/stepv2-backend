const { Steps } = require("../models/steps");
const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");
const { awardCoins: defaultAwardCoins } = require("./awardCoins");
const { resolveRaceState: defaultResolveRaceState } = require("../services/raceStateResolution");

function buildRecordSteps(dependencies = {}) {
  const hasInjectedDeps = Object.keys(dependencies).length > 0;
  const stepsModel = dependencies.Steps || Steps;
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const awardCoinsFn = dependencies.awardCoins || defaultAwardCoins;
  const resolveRaceState = Object.prototype.hasOwnProperty.call(
    dependencies,
    "resolveRaceState"
  )
    ? dependencies.resolveRaceState
    : hasInjectedDeps
      ? async () => {}
      : defaultResolveRaceState;
  const now = dependencies.now || (() => new Date());

  return async function recordSteps({ userId, steps, date, timeZone }) {
    const existing = await stepsModel.findByUserIdAndDate(userId, date);

    let record;
    let lockedGoal;

    if (existing) {
      record = await stepsModel.update(existing.id, { steps });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_UPDATED", { userId, steps, date });
      // Use the goal that was locked in when the record was first created
      lockedGoal = existing.stepGoal;
    } else {
      const user = await userModel.findById(userId);
      lockedGoal = user?.stepGoal;
      record = await stepsModel.create({ userId, steps, date, stepGoal: lockedGoal });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_RECORDED", { userId, steps, date });
    }

    // Check daily step goal coin bonus using the locked-in goal
    try {
      if (lockedGoal && lockedGoal > 0) {
        // 1x goal: 10 coins
        if (steps >= lockedGoal) {
          await awardCoinsFn({
            userId,
            amount: 10,
            reason: "daily_goal_1x",
            refId: date,
          });
        }
        // 2x goal: additional 10 coins
        if (steps >= lockedGoal * 2) {
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

    await resolveRaceState({ userId, timeZone });

    return record;
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps };
