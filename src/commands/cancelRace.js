const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { eventBus } = require("../events/eventBus");

class RaceCancelError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = "RaceCancelError";
    if (statusCode) this.statusCode = statusCode;
  }
}

function buildCancelRace(dependencies = {}) {
  const raceModel = dependencies.Race || Race;
  const participantModel = dependencies.RaceParticipant || RaceParticipant;
  const events = dependencies.eventBus || eventBus;

  return async function cancelRace({ userId, raceId }) {
    const race = await raceModel.findById(raceId);
    if (!race) {
      throw new RaceCancelError("Race not found", 404);
    }
    if (race.creatorId !== userId) {
      throw new RaceCancelError("Only the race creator can cancel the race", 403);
    }
    if (race.status === "COMPLETED") {
      throw new RaceCancelError("Cannot cancel a completed race", 400);
    }
    if (race.status === "CANCELLED") {
      throw new RaceCancelError("Race is already cancelled", 400);
    }

    const updated = await raceModel.update(raceId, { status: "CANCELLED" });

    const acceptedParticipants = await participantModel.findAcceptedByRace(raceId);
    const participantUserIds = acceptedParticipants
      .map((p) => p.userId)
      .filter((id) => id !== userId);

    events.emit("RACE_CANCELLED", {
      raceId,
      raceName: race.name,
      creatorUserId: userId,
      participantUserIds,
    });

    return updated;
  };
}

const cancelRace = buildCancelRace();

module.exports = { buildCancelRace, cancelRace, RaceCancelError };
