const { Steps } = require("../models/steps");
const { eventBus } = require("../events/eventBus");

async function recordSteps({ userId, steps, date }) {
  const existing = await Steps.findByUserIdAndDate(userId, date);

  if (existing) {
    const updated = await Steps.update(existing.id, { steps });
    eventBus.emit("STEPS_UPDATED", { userId, steps, date });
    return updated;
  }

  const record = await Steps.create({ userId, steps, date });

  eventBus.emit("STEPS_RECORDED", { userId, steps, date });
  return record;
}

module.exports = { recordSteps };
