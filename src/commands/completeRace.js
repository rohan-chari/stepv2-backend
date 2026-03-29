const { Race } = require("../models/race");
const { eventBus } = require("../events/eventBus");

function buildCompleteRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const events = dependencies.eventBus || eventBus;
  const now = dependencies.now || (() => new Date());

  return async function completeRace({ raceId, winnerUserId, participantUserIds }) {
    const result = await raceModel.updateIfActive(raceId, {
      status: "COMPLETED",
      completedAt: now(),
      winnerUserId,
    });

    if (result.count === 0) {
      return null;
    }

    events.emit("RACE_COMPLETED", {
      raceId,
      winnerUserId,
      participantUserIds,
    });

    return raceModel.findById(raceId);
  };
}

const completeRace = buildCompleteRace();

module.exports = { buildCompleteRace, completeRace };
