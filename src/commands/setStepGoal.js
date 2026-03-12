const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");

async function setStepGoal({ userId, stepGoal }) {
  const updatedUser = await User.update(userId, { stepGoal });
  eventBus.emit("STEP_GOAL_SET", { userId, stepGoal });
  return updatedUser;
}

module.exports = { setStepGoal };
