const { Steps } = require("../models/steps");
const { User } = require("../models/user");
const { eventBus } = require("../events/eventBus");

function buildRecordSteps(dependencies = {}) {
  const stepsModel = dependencies.Steps || Steps;
  const userModel = dependencies.User || User;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function recordSteps({ userId, steps, date }) {
    const existing = await stepsModel.findByUserIdAndDate(userId, date);

    if (existing) {
      const updated = await stepsModel.update(existing.id, { steps });
      await userModel.update(userId, { lastStepSyncAt: now() });
      events.emit("STEPS_UPDATED", { userId, steps, date });
      return updated;
    }

    const record = await stepsModel.create({ userId, steps, date });
    await userModel.update(userId, { lastStepSyncAt: now() });

    events.emit("STEPS_RECORDED", { userId, steps, date });
    return record;
  };
}

const recordSteps = buildRecordSteps();

module.exports = { buildRecordSteps, recordSteps };
