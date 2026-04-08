const { Race } = require("../models/race");
const { RaceParticipant } = require("../models/raceParticipant");
const { awardCoins } = require("./awardCoins");
const { eventBus } = require("../events/eventBus");
const { refundRaceBuyIn } = require("../services/raceBuyIns");

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
  const awardCoinsFn = dependencies.awardCoins || awardCoins;
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

    const chargedParticipants = await participantModel.findChargedByRace(raceId);
    for (const participant of chargedParticipants) {
      await refundRaceBuyIn({
        awardCoinsFn,
        userId: participant.userId,
        raceId,
        amount: participant.buyInAmount || 0,
      });
      await participantModel.update(participant.id, {
        buyInStatus: "REFUNDED",
      });
    }

    const updated = await raceModel.update(raceId, {
      status: "CANCELLED",
      potCoins: 0,
    });

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
